import type { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
import { Telegraf, Input } from 'telegraf';
import { supabase } from '../src/db/supabase';
import { markSent, type TelegramFileIds } from '../src/db/queries/jobs';
import { getStatus, consumeCredit } from '../src/services/subscriptionService';
import { track } from '../src/services/analyticsService';
import { buildMainMessage, buildCreditsMessage } from '../src/core/messageBuilder';
import { formatSeoText } from '../src/core/seoFormatter';
import { formatOrderBrief } from '../src/core/orderBrief';
import { zipBuilder } from '../src/core/zipBuilder';
import { createStepProgress } from '../src/core/progress';
import { upsertProduct } from '../src/db/queries/products';
import { buildCacheKey } from '../src/lib/cache';
import { acquireStepLock, extendProcessingLock } from '../src/lib/stepLock';
import { redis } from '../src/lib/redis';
import type { ProductWithContent } from '../src/types';

export const config = { maxDuration: 60 };

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const { jobId } = req.body ?? {};
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  try {
    if (!await acquireStepLock('step4', jobId)) return res.status(200).json({ ok: true, skip: true });

    const { data: job } = await supabase.from('jobs').select('*').eq('id', jobId).single();
    if (!job || job.status !== 'done' || job.sent_to_telegram) return res.status(200).json({ ok: true, skip: true });

    await extendProcessingLock(job.user_id);

    const result = job.result_json as any;
    const chatId = job.tg_chat_id;
    const product = result.product as ProductWithContent;

    const progress = job.tg_message_id
      ? createStepProgress(bot, chatId, job.tg_message_id, 'send')
      : null;

    const safeRiskFlags = product.riskFlags ?? { hasBrand: false, isElectrical: false, isChildren: false, isCosmetic: false, isFood: false, isMedical: false, supplierOrdersLow: false, supplierTypeUnknown: false, weightMissing: false, sizeGridRelevant: false, marketDataUnreliable: false };

    const [seoText, briefText, zipBuffer, freshStatus] = await Promise.all([
      Promise.resolve(formatSeoText(product, product.seoContent, safeRiskFlags)),
      Promise.resolve(formatOrderBrief(product, product.seoContent, product.economics, safeRiskFlags, job.input_url, product.budgets, product.conclusion)),
      result.imageUrls?.length
        ? zipBuilder.buildFromUrls(result.imageUrls, { maxImages: 15, maxSizeBytes: 20 * 1024 * 1024 }).catch(() => null as Buffer | null)
        : Promise.resolve(null as Buffer | null),
      getStatus(job.user_id),
    ]);

    await track(job.user_id, 'generation_done', { url: job.input_url });
    await consumeCredit(job.user_id);

    progress?.stop();
    if (job.tg_message_id) {
      await bot.telegram.deleteMessage(chatId, job.tg_message_id).catch(() => {});
    }

    // ─── СООБЩЕНИЕ 1: Короткая выжимка + кнопки ───────────────────────────────
    const { text: mainText, keyboard: mainKb } = buildMainMessage(product, job.id);
    await bot.telegram.sendMessage(chatId, mainText, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...mainKb,
    });

    // ─── СООБЩЕНИЕ 2: Материалы ────────────────────────────────────────────────
    const fileIds: TelegramFileIds = {};
    const prefix = product.productId?.slice(-8) ?? Date.now().toString().slice(-8);

    await bot.telegram.sendMessage(chatId,
      '📎 <b>Материалы готовы</b>\n• SEO-карточка для WB\n• ТЗ байеру / карго\n• Фото товара',
      { parse_mode: 'HTML' }
    );

    const seoMsg = await bot.telegram.sendDocument(chatId, Input.fromBuffer(Buffer.from(seoText, 'utf-8'), `wb_card_${prefix}.md`));
    fileIds.wb_card = seoMsg.document?.file_id;

    const briefMsg = await bot.telegram.sendDocument(chatId, Input.fromBuffer(Buffer.from(briefText, 'utf-8'), `buyer_brief_${prefix}.md`));
    fileIds.buyer_brief = briefMsg.document?.file_id;

    if (zipBuffer) {
      const zipMsg = await bot.telegram.sendDocument(chatId, Input.fromBuffer(zipBuffer, `photos_${prefix}.zip`));
      fileIds.photos_zip = zipMsg.document?.file_id;
    }

    // ─── СООБЩЕНИЕ 3: Кредиты ──────────────────────────────────────────────────
    const { text: creditsText, keyboard: creditsKb } = buildCreditsMessage(freshStatus);
    await bot.telegram.sendMessage(chatId, creditsText, { parse_mode: 'HTML', ...creditsKb });

    await markSent(job.id, fileIds);
    if (redis) await redis.del(`processing:${job.user_id}`).catch(() => {});

    const cacheKey = buildCacheKey(product.productId, product.titleCn, product.mainImageUrl);
    upsertProduct(job.user_id, { ...product, cacheKey }).catch((e) =>
      console.warn('[step4] Cache save failed:', e instanceof Error ? e.message : e)
    );

    console.log(`[step4] Job ${job.id} sent`);

    res.status(200).json({ ok: true });
  } catch (e: any) {
    console.error('[step4]', e.message);
    const { handleStepError } = require('../src/lib/stepError');
    await handleStepError(jobId, e.message, bot);
    res.status(200).json({ ok: false });
  }
}

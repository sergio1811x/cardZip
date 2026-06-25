import type { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { supabase } from '../src/db/supabase';
import { markSent } from '../src/db/queries/jobs';
import { getStatus, consumeCredit } from '../src/services/subscriptionService';
import { track } from '../src/services/analyticsService';
import { buildMainMessage } from '../src/core/messageBuilder';
import { validateReport } from '../src/core/reportValidator';
import { findWbCategoriesByKeywords } from '../src/db/queries/wbCategories';
import { formatSeoText } from '../src/core/seoFormatter';
import { formatOrderBrief } from '../src/core/orderBrief';
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

    const [seoText, briefText, freshStatus] = await Promise.all([
      Promise.resolve(formatSeoText(product, product.seoContent, safeRiskFlags)),
      Promise.resolve(formatOrderBrief(product, product.seoContent, product.economics, safeRiskFlags, job.input_url, product.budgets, product.conclusion)),
      getStatus(job.user_id),
    ]);

    // Сохраняем тексты файлов в result_json для отложенной отправки по кнопке
    await supabase.from('jobs').update({
      result_json: {
        ...result,
        generatedFiles: { seoText, briefText },
      },
    }).eq('id', jobId);

    await track(job.user_id, 'generation_done', { url: job.input_url });
    await consumeCredit(job.user_id);

    progress?.stop();
    if (job.tg_message_id) {
      await bot.telegram.deleteMessage(chatId, job.tg_message_id).catch(() => {});
    }

    // ─── WB-категория (fallback если аналоги не найдены) ────────────────────────
    const keywords = (product.seoContent?.keywords ?? []).slice(0, 3);
    if (!keywords.length && product.titleRu) keywords.push(product.titleRu.split(' ').slice(0, 2).join(' '));
    const wbCats = keywords.length ? await findWbCategoriesByKeywords(keywords).catch(() => []) : [];
    const wbCategory = wbCats[0] ?? null;

    // ─── Одно сообщение: выжимка + остаток + кнопки ───────────────────────────
    const { text: mainText, keyboard: mainKb } = buildMainMessage(product, job.id, freshStatus, wbCategory);

    // Validate report text
    const validation = validateReport(mainText, (product as any).categoryType ?? 'other', {
      hasPrice: product.priceYuan > 0,
      hasWeight: product.weightKg > 0,
      hasDirectAnalogs: !!(product.similarityData?.directCount && product.similarityData.directCount > 0),
      wb429: !!(product as any).wb429,
      intelligence: (product as any).intelligence ?? null,
    });
    if (!validation.ok) {
      console.warn(`[step4] Validator found ${validation.errors.length} issues:`, validation.errors.join(', '));
    }
    const finalText = validation.ok ? mainText : validation.fixedText;

    await bot.telegram.sendMessage(chatId, finalText, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...mainKb,
    });

    await markSent(job.id);
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

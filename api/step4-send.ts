import type { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
import { Telegraf, Input } from 'telegraf';
import { supabase } from '../src/db/supabase';
import { markSent } from '../src/db/queries/jobs';
import { getStatus } from '../src/services/subscriptionService';
import { track } from '../src/services/analyticsService';
import { buildMessage1, buildMessage2, buildMessage3 } from '../src/core/messageBuilder';
import { formatSeoText } from '../src/core/seoFormatter';
import { formatOrderBrief } from '../src/core/orderBrief';
import { zipBuilder } from '../src/core/zipBuilder';
import { createStepProgress } from '../src/core/progress';
import type { ProductWithContent } from '../src/types';

export const config = { maxDuration: 60 };

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const { jobId } = req.body ?? {};
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  try {
    const { data: job } = await supabase.from('jobs').select('*').eq('id', jobId).single();
    if (!job || job.status !== 'done' || job.sent_to_telegram) return res.status(200).json({ ok: true, skip: true });

    const result = job.result_json as any;
    const chatId = job.tg_chat_id;
    const product = result.product as ProductWithContent;

    const progress = job.tg_message_id
      ? createStepProgress(bot, chatId, job.tg_message_id, 'send')
      : null;

    const [seoText, briefText, zipBuffer, freshStatus] = await Promise.all([
      Promise.resolve(formatSeoText(product, product.seoContent, product.riskFlags)),
      Promise.resolve(formatOrderBrief(product, product.seoContent, product.economics, product.riskFlags, job.input_url, product.budgets, product.conclusion)),
      result.imageUrls?.length
        ? zipBuilder.buildFromUrls(result.imageUrls, { maxImages: 15, maxSizeBytes: 20 * 1024 * 1024 }).catch(() => null as Buffer | null)
        : Promise.resolve(null as Buffer | null),
      getStatus(job.user_id),
    ]);

    await track(job.user_id, 'generation_done', { url: job.input_url });

    progress?.stop();
    if (job.tg_message_id) {
      await bot.telegram.deleteMessage(chatId, job.tg_message_id).catch(() => {});
    }

    // ─── СООБЩЕНИЕ 1: Решение + рынок + экономика + проверки ────────────────
    const msg1text = buildMessage1(product);
    const msg2data = buildMessage2(product, job.id);
    const fullMsg1 = msg1text + '\n\n' + msg2data.text;

    await bot.telegram.sendMessage(chatId, fullMsg1, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...msg2data.keyboard,
    });

    // ─── СООБЩЕНИЕ 2: Документы ──────────────────────────────────────────────
    await bot.telegram.sendMessage(chatId,
      '📎 <b>Материалы готовы</b>\n• SEO-карточка для WB\n• ТЗ байеру / карго\n• Исходные фото товара',
      { parse_mode: 'HTML' }
    );
    await bot.telegram.sendDocument(chatId, Input.fromBuffer(Buffer.from(seoText, 'utf-8'), 'seo_content.md'));
    await bot.telegram.sendDocument(chatId, Input.fromBuffer(Buffer.from(briefText, 'utf-8'), 'order_brief.md'));
    if (zipBuffer) {
      await bot.telegram.sendDocument(chatId, Input.fromBuffer(zipBuffer, 'images.zip'));
    }

    // ─── СООБЩЕНИЕ 3: Действия ───────────────────────────────────────────────
    const { text, keyboard } = buildMessage3(freshStatus);
    await bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML', ...keyboard });

    await markSent(job.id);
    console.log(`[step4] Job ${job.id} sent`);

    res.status(200).json({ ok: true });
  } catch (e: any) {
    console.error('[step4]', e.message);
    await markSent(jobId);
    res.status(200).json({ ok: false });
  }
}

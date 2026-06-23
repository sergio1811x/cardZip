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
      Promise.resolve(formatOrderBrief(product, product.seoContent, product.economics, product.riskFlags, job.input_url)),
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

    // Сообщение 1: Товар + WB ориентир + Экономика + Вывод
    await bot.telegram.sendMessage(chatId, buildMessage1(product), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });

    // Сообщение 2: Риски + Бюджеты + Кнопки
    const msg2 = buildMessage2(product, job.id);
    await bot.telegram.sendMessage(chatId, msg2.text, {
      parse_mode: 'HTML',
      ...msg2.keyboard,
    });

    // Файлы
    await bot.telegram.sendDocument(chatId, Input.fromBuffer(Buffer.from(seoText, 'utf-8'), 'seo_content.md'), {
      caption: '📄 SEO-материалы для карточки WB',
    });
    await bot.telegram.sendDocument(chatId, Input.fromBuffer(Buffer.from(briefText, 'utf-8'), 'order_brief.md'), {
      caption: '📋 ТЗ для байера / карго',
    });
    if (zipBuffer) {
      await bot.telegram.sendDocument(chatId, Input.fromBuffer(zipBuffer, 'images.zip'), {
        caption: `🖼 Фото товара (${result.imageUrls.length} шт.)`,
      });
    }

    // Сообщение 3: Лимиты + кнопки
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

import type { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
import { Telegraf, Input } from 'telegraf';
import { supabase } from '../src/db/supabase';
import { markSent } from '../src/db/queries/jobs';
import { getStatus } from '../src/services/subscriptionService';
import { track } from '../src/services/analyticsService';
import { buildMessage1, buildMessage3 } from '../src/core/messageBuilder';
import { formatSeoText } from '../src/core/seoFormatter';
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

    // Прогресс с анимацией
    const progress = job.tg_message_id
      ? createStepProgress(bot, chatId, job.tg_message_id, 'send')
      : null;

    // Аналитика (до отправки)
    await track(job.user_id, 'generation_done', { url: job.input_url });

    // Стоп прогресс, удаляем
    progress?.stop();
    if (job.tg_message_id) {
      await bot.telegram.deleteMessage(chatId, job.tg_message_id).catch(() => {});
    }

    // Сообщение 1: аналитика
    await bot.telegram.sendMessage(chatId, buildMessage1(product), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });

    // Сообщение 2: SEO файл
    const seoText = formatSeoText(product, product.seoContent);
    await bot.telegram.sendDocument(chatId, Input.fromBuffer(Buffer.from(seoText, 'utf-8'), 'wb_seo.txt'), {
      caption: '📄 SEO-материалы для карточки WB',
    });

    // ZIP
    if (result.imageUrls?.length) {
      try {
        const zipBuffer = await zipBuilder.buildFromUrls(result.imageUrls, { maxImages: 15, maxSizeBytes: 20 * 1024 * 1024 });
        await bot.telegram.sendDocument(chatId, Input.fromBuffer(zipBuffer, 'images.zip'), {
          caption: `🖼 Фото товара (${result.imageUrls.length} шт.)`,
        });
      } catch {}
    }

    // Сообщение 3: счётчик
    const freshStatus = await getStatus(job.user_id);
    const { text, keyboard } = buildMessage3(freshStatus);
    await bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML', ...keyboard });

    await markSent(job.id);
    console.log(`[step3] Job ${job.id} sent to Telegram`);

    res.status(200).json({ ok: true });
  } catch (e: any) {
    console.error('[step3]', e.message);
    // Пометим отправленным чтобы не зациклить
    await markSent(jobId);
    res.status(200).json({ ok: false });
  }
}

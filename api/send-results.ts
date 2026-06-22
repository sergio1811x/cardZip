import type { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
import { Telegraf, Input } from 'telegraf';
import { getUnsentJobs, markSent } from '../src/db/queries/jobs';
import { getStatus } from '../src/services/subscriptionService';
import { track } from '../src/services/analyticsService';
import { buildMessage1, buildMessage3 } from '../src/core/messageBuilder';
import { formatSeoText } from '../src/core/seoFormatter';
import { zipBuilder } from '../src/core/zipBuilder';
import type { ProductWithContent } from '../src/types';

export const config = { maxDuration: 30 };

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const jobs = await getUnsentJobs();
    if (!jobs.length) return res.status(200).json({ ok: true, sent: 0 });

    let sent = 0;

    for (const job of jobs) {
      try {
        const chatId = job.tg_chat_id;

        // Удаляем прогресс-сообщение
        if (job.tg_message_id) {
          await bot.telegram.deleteMessage(chatId, job.tg_message_id).catch(() => {});
        }

        if (job.status === 'failed') {
          await bot.telegram.sendMessage(chatId,
            `❌ Не удалось обработать товар.\n\n${job.error || 'Попробуйте ещё раз.'}`,
          );
          await markSent(job.id);
          sent++;
          continue;
        }

        const result = job.result_json as any;
        if (!result?.product) {
          await bot.telegram.sendMessage(chatId, '❌ Ошибка обработки. Попробуйте ещё раз.');
          await markSent(job.id);
          sent++;
          continue;
        }

        const product = result.product as ProductWithContent;

        // Сообщение 1: аналитика
        await bot.telegram.sendMessage(chatId, buildMessage1(product), {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        });

        // Сообщение 2: SEO файл
        const seoText = formatSeoText(product, product.seoContent);
        const seoBuffer = Buffer.from(seoText, 'utf-8');
        await bot.telegram.sendDocument(chatId, Input.fromBuffer(seoBuffer, 'wb_seo.txt'), {
          caption: '📄 SEO-материалы для карточки WB',
        });

        // ZIP собираем на лету по imageUrls
        if (result.imageUrls?.length) {
          try {
            const zipBuffer = await zipBuilder.buildFromUrls(result.imageUrls, { maxImages: 15, maxSizeBytes: 20 * 1024 * 1024 });
            await bot.telegram.sendDocument(chatId, Input.fromBuffer(zipBuffer, 'images.zip'), {
              caption: `🖼 Фото товара (${result.imageUrls.length} шт.)`,
            });
          } catch {
            console.warn('[send] ZIP failed, skipping');
          }
        }

        // Сообщение 3: счётчик + кнопки
        const freshStatus = await getStatus(job.user_id);
        const { text, keyboard } = buildMessage3(freshStatus);
        await bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML', ...keyboard });

        // Аналитика
        await track(job.user_id, 'generation_done', {
          durationMs: result.durationMs,
          url: job.input_url,
        });

        await markSent(job.id);
        sent++;
        console.log(`[send] Job ${job.id} sent to Telegram`);
      } catch (e) {
        console.error(`[send] Job ${job.id} failed:`, e);
        await markSent(job.id);
      }
    }

    res.status(200).json({ ok: true, sent });
  } catch (e) {
    console.error('[send-results] Error:', e);
    res.status(500).json({ ok: false });
  }
}

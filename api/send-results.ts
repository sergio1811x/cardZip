import type { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
import { Telegraf, Input } from 'telegraf';
import { getUnsentJobs, markSent } from '../src/db/queries/jobs';
import { getStatus } from '../src/services/subscriptionService';
import { track } from '../src/services/analyticsService';
import { buildMessage1, buildMessage3 } from '../src/core/messageBuilder';
import { formatSeoText } from '../src/core/seoFormatter';
import { zipBuilder } from '../src/core/zipBuilder';
import { aiContentGenerator } from '../src/providers/aiContentGenerator';
import { calcEconomics } from '../src/core/economicsCalc';
import { buildVerdict } from '../src/core/verdict';
import type { ProductWithContent } from '../src/types';

export const config = { maxDuration: 60 };

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const jobs = await getUnsentJobs();
    if (!jobs.length) return res.status(200).json({ ok: true, sent: 0 });

    let sent = 0;

    for (const job of jobs) {
      try {
        const chatId = job.tg_chat_id;
        const result = job.result_json as any;

        if (job.status === 'failed' || !result?.rawProduct) {
          if (job.tg_message_id) await bot.telegram.deleteMessage(chatId, job.tg_message_id).catch(() => {});
          await bot.telegram.sendMessage(chatId, `❌ ${job.error || 'Не удалось обработать товар. Попробуйте ещё раз.'}`);
          await markSent(job.id);
          sent++;
          continue;
        }

        const raw = result.rawProduct;
        const wbData = result.wbData;

        // Обновляем прогресс
        if (job.tg_message_id) {
          await bot.telegram.editMessageText(chatId, job.tg_message_id, undefined,
            '🔄 Генерируем SEO-контент...', { parse_mode: 'HTML' }
          ).catch(() => {});
        }

        // AI генерация (на Vercel — быстрый интернет)
        const [seoContent, economics] = await Promise.all([
          aiContentGenerator.generate({
            titleCn: raw.titleCn,
            titleEn: raw.titleEn,
            description: raw.description,
            priceYuan: raw.priceYuan,
            moq: raw.moq,
            weightKg: raw.weightKg,
            supplierName: raw.supplierName,
            supplierRating: raw.supplierRating,
            categoryName: raw.categoryName,
            attributes: raw.attributes,
          }).catch(() => ({
            titleRu: raw.titleEn || raw.titleCn,
            description: '',
            bullets: [] as string[],
            keywords: [] as string[],
            characteristics: {} as Record<string, string>,
            isFallback: true,
          })),
          calcEconomics({
            priceYuan: raw.priceYuan,
            weightKg: raw.weightKg,
            wbAvgPrice: wbData?.avgPrice,
          }),
        ]);

        const verdict = buildVerdict(economics, wbData, raw.sold);

        const product = {
          ...raw,
          titleRu: seoContent.titleRu,
          seoContent,
          wbData,
          economics,
          verdict,
        } as ProductWithContent;

        // Обновляем прогресс
        if (job.tg_message_id) {
          await bot.telegram.editMessageText(chatId, job.tg_message_id, undefined,
            '🔄 Собираем материалы...', { parse_mode: 'HTML' }
          ).catch(() => {});
        }

        // ZIP
        let zipBuffer: Buffer | null = null;
        if (result.imageUrls?.length) {
          try {
            zipBuffer = await zipBuilder.buildFromUrls(result.imageUrls, { maxImages: 15, maxSizeBytes: 20 * 1024 * 1024 });
          } catch {}
        }

        // Удаляем прогресс
        if (job.tg_message_id) {
          await bot.telegram.deleteMessage(chatId, job.tg_message_id).catch(() => {});
        }

        // Аналитика (до отправки)
        await track(job.user_id, 'generation_done', { durationMs: result.durationMs, url: job.input_url });

        // Сообщение 1: аналитика
        await bot.telegram.sendMessage(chatId, buildMessage1(product), {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        });

        // Сообщение 2: файлы
        const seoText = formatSeoText(product, product.seoContent);
        await bot.telegram.sendDocument(chatId, Input.fromBuffer(Buffer.from(seoText, 'utf-8'), 'wb_seo.txt'), {
          caption: '📄 SEO-материалы для карточки WB',
        });

        if (zipBuffer) {
          await bot.telegram.sendDocument(chatId, Input.fromBuffer(zipBuffer, 'images.zip'), {
            caption: `🖼 Фото товара (${result.imageUrls.length} шт.)`,
          });
        }

        // Сообщение 3: счётчик
        const freshStatus = await getStatus(job.user_id);
        const { text, keyboard } = buildMessage3(freshStatus);
        await bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML', ...keyboard });

        await markSent(job.id);
        sent++;
        console.log(`[send] Job ${job.id} sent`);
      } catch (e) {
        console.error(`[send] Job ${job.id} error:`, e);
        await markSent(job.id);
      }
    }

    res.status(200).json({ ok: true, sent });
  } catch (e) {
    console.error('[send-results]', e);
    res.status(500).json({ ok: false });
  }
}

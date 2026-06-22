import type { Context } from 'telegraf';
import type { Message } from 'telegraf/typings/core/types/typegram';
import { productImporter } from '../../providers/productImporter';
import { aiContentGenerator } from '../../providers/aiContentGenerator';
import { marketProvider } from '../../providers/marketProvider';
import { calcEconomics } from '../../core/economicsCalc';
import { zipBuilder } from '../../core/zipBuilder';
import { formatSeoText } from '../../core/seoFormatter';
import { buildMessage1, buildMessage3 } from '../../core/messageBuilder';
import { buildCacheKey } from '../../lib/cache';
import { findProductByKey, upsertProduct } from '../../db/queries/products';
import { getStatus } from '../../services/subscriptionService';
import { track } from '../../services/analyticsService';
import { AppError, isAppError } from '../../lib/errors';
import { Input } from 'telegraf';
import type { ProductWithContent } from '../../types';

const STEPS = [
  '⏳ Получаю данные 1688...',
  '🔍 Анализирую WB...',
  '💰 Рассчитываю экономику...',
  '📦 Готовлю материалы...',
];

export async function handleLink(ctx: Context, url: string): Promise<void> {
  const userId = (ctx as any).dbUserId as string;
  const startTime = Date.now();

  // Проверяем лимиты подписки
  const status = await getStatus(userId);
  if (!status.canGenerate) {
    track(userId, 'upgrade_shown');
    await ctx.reply(
      `❌ <b>Бесплатные генерации исчерпаны</b>\n\nТы использовал все ${status.generationsLimit} бесплатных анализа.\n\nДля продолжения — подключи подписку:`,
      {
        parse_mode: 'HTML',
        ...require('telegraf').Markup.inlineKeyboard([
          [require('telegraf').Markup.button.callback('🚀 Снять лимиты', 'upgrade')],
        ]),
      }
    );
    return;
  }

  track(userId, 'sent_link', { url });

  // Прогресс-сообщение
  const progressMsg = await ctx.reply(STEPS[0], { parse_mode: 'HTML' });
  const progressMsgId = (progressMsg as Message.TextMessage).message_id;
  const chatId = ctx.chat!.id;

  const updateProgress = async (step: number) => {
    try {
      await ctx.telegram.editMessageText(chatId, progressMsgId, undefined, STEPS[step], {
        parse_mode: 'HTML',
      });
    } catch { /* ignore race conditions */ }
  };

  try {
    // ─── Шаг 1: Получаем данные 1688 ────────────────────────────────────────
    const rawProduct = await productImporter.fetchProduct(url);
    const cacheKey = buildCacheKey(rawProduct.productId, rawProduct.titleCn, rawProduct.mainImageUrl);

    // Проверяем кэш Supabase
    const cached = await findProductByKey(cacheKey);
    let product: ProductWithContent;

    if (cached?.data_json) {
      console.log('[pipeline] Cache hit:', cacheKey);
      const d = cached.data_json as any;
      product = {
        ...rawProduct,
        titleRu: cached.title_ru ?? rawProduct.titleCn,
        cacheKey,
        seoContent: d.seoContent,
        wbData: d.wbData ?? null,
        economics: d.economics,
        cachedAt: new Date(cached.created_at),
      };
    } else {
      // ─── Шаг 2: Параллельно AI + WB ───────────────────────────────────────
      await updateProgress(1);

      const [aiResult, wbResult] = await Promise.allSettled([
        aiContentGenerator.generate({
          titleCn: rawProduct.titleCn,
          priceYuan: rawProduct.priceYuan,
          moq: rawProduct.moq,
          weightKg: rawProduct.weightKg,
          supplierName: rawProduct.supplierName,
          supplierRating: rawProduct.supplierRating,
        }),
        marketProvider.searchSimilar(rawProduct.titleCn),
      ]);

      await updateProgress(2);

      const seoContent =
        aiResult.status === 'fulfilled'
          ? aiResult.value
          : { titleRu: rawProduct.titleCn, description: '', keywords: [], characteristics: {}, isFallback: true };

      const wbData = wbResult.status === 'fulfilled' ? wbResult.value : null;

      // ─── Шаг 3: Экономика ─────────────────────────────────────────────────
      const economics = calcEconomics({
        priceYuan: rawProduct.priceYuan,
        weightKg: rawProduct.weightKg,
        wbAvgPrice: wbData?.avgPrice,
      });

      product = {
        ...rawProduct,
        titleRu: seoContent.titleRu,
        cacheKey,
        seoContent,
        wbData,
        economics,
      };

      // Сохраняем в Supabase (не блокируем пайплайн при ошибке записи)
      upsertProduct(userId, product).catch((e) => console.error('[pipeline] upsert failed:', e));
    }

    // ─── Шаг 4: Собираем материалы ────────────────────────────────────────
    await updateProgress(3);

    const [zipBuffer, seoText] = await Promise.all([
      zipBuilder.buildFromUrls(product.images, { maxImages: 15, maxSizeBytes: 20 * 1024 * 1024 }),
      Promise.resolve(formatSeoText(product, product.seoContent)),
    ]);

    // ─── Удаляем прогресс-сообщение ───────────────────────────────────────
    await ctx.telegram.deleteMessage(chatId, progressMsgId).catch(() => {});

    // ─── Отправляем 3 сообщения ───────────────────────────────────────────

    // Сообщение 1: аналитика + экономика
    await ctx.reply(buildMessage1(product), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });

    // Сообщение 2: wb_seo.txt + images.zip
    const seoBuffer = Buffer.from(seoText, 'utf-8');
    await ctx.replyWithDocument(Input.fromBuffer(seoBuffer, 'wb_seo.txt'), {
      caption: '📄 SEO-материалы для карточки WB',
    });
    await ctx.replyWithDocument(Input.fromBuffer(zipBuffer, 'images.zip'), {
      caption: `🖼 Фото товара (${product.images.length} шт.)`,
    });

    // Сообщение 3: счётчик + кнопки
    const freshStatus = await getStatus(userId);
    const { text, keyboard } = buildMessage3(freshStatus);
    await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });

    // ─── Аналитика ────────────────────────────────────────────────────────
    const durationMs = Date.now() - startTime;
    track(userId, 'generation_done', { durationMs, cacheHit: !!cached, url });
    if (durationMs > 25_000) {
      track(userId, 'slow_generation', { durationMs });
    }
  } catch (e) {
    const durationMs = Date.now() - startTime;

    // Удаляем прогресс-сообщение
    await ctx.telegram.deleteMessage(chatId, progressMsgId).catch(() => {});

    if (isAppError(e)) {
      await ctx.reply(`${e.userMessage}`, { parse_mode: 'HTML' });
      if (e.code !== 'RATE_LIMITED' && e.code !== 'LIMIT_REACHED') {
        track(userId, 'generation_failed', { error: e.code, durationMs });
      }
    } else {
      console.error('[pipeline] Unexpected error:', e);
      await ctx.reply(
        '❌ Что-то пошло не так. Попробуй ещё раз через минуту.\n\nЕсли ошибка повторяется — напиши в поддержку.'
      );
      track(userId, 'generation_failed', { error: 'UNKNOWN', durationMs });
    }
  }
}

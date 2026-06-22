import type { Context } from 'telegraf';
import type { Message } from 'telegraf/typings/core/types/typegram';
import { productImporter } from '../../providers/productImporter';
import { aiContentGenerator } from '../../providers/aiContentGenerator';
import { marketProvider } from '../../providers/marketProvider';
import { calcEconomics } from '../../core/economicsCalc';
import { zipBuilder } from '../../core/zipBuilder';
import { formatSeoText } from '../../core/seoFormatter';
import { buildMessage1, buildMessage3 } from '../../core/messageBuilder';
import { buildVerdict } from '../../core/verdict';
import { normalizeCnText } from '../../core/cnNormalize';
import { buildCacheKey } from '../../lib/cache';
import { findProductByKey, upsertProduct } from '../../db/queries/products';
import { getStatus } from '../../services/subscriptionService';
import { track } from '../../services/analyticsService';
import { AppError, isAppError } from '../../lib/errors';
import { Input } from 'telegraf';
import type { ProductWithContent } from '../../types';

// ─── Прогресс-сообщения ──────────────────────────────────────────────────────

const STEP_MESSAGES: Record<string, string[]> = {
  fetch: [
    '📡 <b>Шаг 1/4</b> — Получаем данные с площадки...',
    '📡 <b>Шаг 1/4</b> — Загружаем карточку товара...',
    '📡 <b>Шаг 1/4</b> — Читаем характеристики поставщика...',
    '📡 <b>Шаг 1/4</b> — Обрабатываем данные фабрики...',
    '📡 <b>Шаг 1/4</b> — Извлекаем цены и фотографии...',
    '📡 <b>Шаг 1/4</b> — Почти загрузили, ещё немного...',
  ],
  ai: [
    '🤖 <b>Шаг 2/4</b> — Генерируем SEO-контент...',
    '🤖 <b>Шаг 2/4</b> — Подбираем ключевые слова для WB...',
    '🤖 <b>Шаг 2/4</b> — Составляем описание карточки...',
    '🤖 <b>Шаг 2/4</b> — Формируем 5 буллетов для инфографики...',
    '🤖 <b>Шаг 2/4</b> — Адаптируем под российский рынок...',
    '🤖 <b>Шаг 2/4</b> — Дорабатываем характеристики товара...',
  ],
  wb: [
    '🔍 <b>Шаг 3/4</b> — Ищем похожие товары на Wildberries...',
    '🔍 <b>Шаг 3/4</b> — Анализируем цены конкурентов...',
    '🔍 <b>Шаг 3/4</b> — Загружаем фото для поиска на WB...',
    '🔍 <b>Шаг 3/4</b> — Сравниваем с карточками на маркетплейсе...',
    '🔍 <b>Шаг 3/4</b> — Считаем среднюю цену в нише...',
    '🔍 <b>Шаг 3/4</b> — Собираем топ похожих товаров...',
    '🔍 <b>Шаг 3/4</b> — Оцениваем уровень конкуренции...',
  ],
  zip: [
    '📦 <b>Шаг 4/4</b> — Собираем архив с фотографиями...',
    '📦 <b>Шаг 4/4</b> — Скачиваем изображения товара...',
    '📦 <b>Шаг 4/4</b> — Формируем SEO-файл для карточки...',
    '📦 <b>Шаг 4/4</b> — Упаковываем материалы...',
    '📦 <b>Шаг 4/4</b> — Почти готово, отправляем результат...',
  ],
};

function createProgressUpdater(ctx: Context, chatId: number, msgId: number) {
  let currentKey = '';
  let msgIndex = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const edit = async (text: string) => {
    try {
      await ctx.telegram.editMessageText(chatId, msgId, undefined, text, { parse_mode: 'HTML' });
    } catch {}
  };

  timer = setInterval(() => {
    const messages = STEP_MESSAGES[currentKey];
    if (!messages) return;
    msgIndex++;
    const text = messages[msgIndex % messages.length];
    edit(text);
  }, 10_000);

  return {
    step(key: string) {
      currentKey = key;
      msgIndex = 0;
      const messages = STEP_MESSAGES[key];
      if (messages) edit(messages[0]);
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}

// ─── Определяем сетевые ошибки ───────────────────────────────────────────────

function isNetworkError(e: unknown): boolean {
  if (e instanceof DOMException && e.name === 'TimeoutError') return true;
  if (e instanceof TypeError && (e.message === 'terminated' || e.message === 'fetch failed')) return true;
  return false;
}

// ─── Main handler ────────────────────────────────────────────────────────────

export async function handleLink(ctx: Context, url: string): Promise<void> {
  const userId = (ctx as any).dbUserId as string;
  const startTime = Date.now();

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

  const progressMsg = await ctx.reply(STEP_MESSAGES.fetch[0], { parse_mode: 'HTML' });
  const progressMsgId = (progressMsg as Message.TextMessage).message_id;
  const chatId = ctx.chat!.id;
  const progress = createProgressUpdater(ctx, chatId, progressMsgId);

  try {
    // ─── Шаг 1: Данные с площадки ─────────────────────────────────────────
    progress.step('fetch');
    const rawProduct = await productImporter.fetchProduct(url);
    const cacheKey = buildCacheKey(rawProduct.productId, rawProduct.titleCn, rawProduct.mainImageUrl);

    // Проверяем кэш
    const cached = await findProductByKey(cacheKey);
    let product: ProductWithContent;
    let zipResult: Buffer | null = null;

    // Нормализуем китайский текст перед отправкой в AI
    rawProduct.titleCn = normalizeCnText(rawProduct.titleCn);
    if (rawProduct.description) rawProduct.description = normalizeCnText(rawProduct.description);

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
        verdict: d.verdict ?? buildVerdict(d.economics, d.wbData, rawProduct.sold),
        cachedAt: new Date(cached.created_at),
      };
    } else {
      // ─── Шаги 2-4 ПАРАЛЛЕЛЬНО: AI + WB + ZIP ─────────────────────────────
      progress.step('ai');

      const searchImage = rawProduct.images[1] || rawProduct.images[2] || rawProduct.mainImageUrl;
      const wbQuery = rawProduct.titleEn || rawProduct.titleCn;

      // Запускаем всё параллельно — все зависят только от rawProduct
      const [seoContent, wbData, economicsResult, zipResult] = await Promise.all([
        // AI SEO
        aiContentGenerator.generate({
          titleCn: rawProduct.titleCn,
          titleEn: rawProduct.titleEn,
          description: rawProduct.description,
          priceYuan: rawProduct.priceYuan,
          moq: rawProduct.moq,
          weightKg: rawProduct.weightKg,
          supplierName: rawProduct.supplierName,
          supplierRating: rawProduct.supplierRating,
          categoryName: rawProduct.categoryName,
          attributes: rawProduct.attributes,
        }).catch(() => ({
          titleRu: rawProduct.titleEn || rawProduct.titleCn,
          description: '',
          bullets: [] as string[],
          keywords: [] as string[],
          characteristics: {} as Record<string, string>,
          isFallback: true,
        })),

        // WB поиск по фото (fallback на текст)
        marketProvider.searchSimilar(wbQuery, searchImage).catch(() => null),

        // Экономика (курс ЦБ — без wbAvgPrice, добавим после)
        calcEconomics({
          priceYuan: rawProduct.priceYuan,
          weightKg: rawProduct.weightKg,
        }),

        // ZIP фото
        zipBuilder.buildFromUrls(rawProduct.images, { maxImages: 15, maxSizeBytes: 20 * 1024 * 1024 }),
      ]);

      // Пересчитаем экономику с ценой WB если есть
      const economics = wbData?.avgPrice
        ? await calcEconomics({ priceYuan: rawProduct.priceYuan, weightKg: rawProduct.weightKg, wbAvgPrice: wbData.avgPrice })
        : economicsResult;

      const verdict = buildVerdict(economics, wbData, rawProduct.sold);

      product = {
        ...rawProduct,
        titleRu: seoContent.titleRu,
        cacheKey,
        seoContent,
        wbData,
        economics,
        verdict,
      };

      upsertProduct(userId, product).catch((e) => console.error('[pipeline] upsert failed:', e));
    }

    // ─── SEO текст (мгновенно) ──────────────────────────────────────────
    progress.step('zip');
    const seoText = formatSeoText(product, product.seoContent);
    // zipResult уже готов из параллельного блока, или собираем для cached
    const zipBuffer = zipResult ?? await zipBuilder.buildFromUrls(product.images, { maxImages: 15, maxSizeBytes: 20 * 1024 * 1024 });

    // ─── Стоп прогресс, удаляем сообщение ─────────────────────────────────
    progress.stop();
    await ctx.telegram.deleteMessage(chatId, progressMsgId).catch(() => {});

    // ─── Отправляем 3 сообщения ───────────────────────────────────────────
    await ctx.reply(buildMessage1(product), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });

    const seoBuffer = Buffer.from(seoText, 'utf-8');
    await ctx.replyWithDocument(Input.fromBuffer(seoBuffer, 'wb_seo.txt'), {
      caption: '📄 SEO-материалы для карточки WB',
    });
    await ctx.replyWithDocument(Input.fromBuffer(zipBuffer, 'images.zip'), {
      caption: `🖼 Фото товара (${product.images.length} шт.)`,
    });

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
    progress.stop();
    const durationMs = Date.now() - startTime;
    await ctx.telegram.deleteMessage(chatId, progressMsgId).catch(() => {});

    if (isAppError(e)) {
      await ctx.reply(e.userMessage, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
      if (e.code !== 'RATE_LIMITED' && e.code !== 'LIMIT_REACHED') {
        track(userId, 'generation_failed', { error: e.code, durationMs });
      }
    } else if (isNetworkError(e)) {
      console.error('[pipeline] Network error:', durationMs, 'ms', e);
      await ctx.reply('⏱ Связь с сервером прервалась. Попробуй ещё раз — обычно со второго раза проходит.');
      track(userId, 'generation_failed', { error: 'NETWORK', durationMs });
    } else {
      console.error('[pipeline] Unexpected error:', e);
      await ctx.reply('❌ Что-то пошло не так. Попробуй ещё раз через минуту.');
      track(userId, 'generation_failed', { error: 'UNKNOWN', durationMs });
    }
  }
}

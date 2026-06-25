import type { Context } from 'telegraf';
import type { Message } from 'telegraf/typings/core/types/typegram';
import { productImporter } from '../../providers/productImporter';
import { aiContentGenerator } from '../../providers/aiContentGenerator';
import { marketProvider } from '../../providers/marketProvider';
import { calcEconomics, calcBudgetScenarios, calcMaxPurchasePrice } from '../../core/economicsCalc';
import { zipBuilder } from '../../core/zipBuilder';
import { formatSeoText } from '../../core/seoFormatter';
import { buildMainMessage } from '../../core/messageBuilder';
import { buildConclusion } from '../../core/verdict';
import { buildRiskFlags } from '../../core/riskFlags';
import { filterWbData } from '../../core/wbFilter';
import { normalizeCnText } from '../../core/cnNormalize';
import { buildCacheKey } from '../../lib/cache';
import { findProductByKey, upsertProduct } from '../../db/queries/products';
import { getStatus } from '../../services/subscriptionService';
import { track } from '../../services/analyticsService';
import { AppError, isAppError } from '../../lib/errors';
import { Input } from 'telegraf';
import type { ProductWithContent, WbFilterKeywords, AiContentResult } from '../../types';

// ─── Прогресс-сообщения ──────────────────────────────────────────────────────

const STEP_MESSAGES: Record<string, string[]> = {
  fetch: [
    '🔄 Загружаем данные с площадки...',
    '🔄 Читаем карточку товара...',
    '🔄 Извлекаем характеристики...',
    '🔄 Парсим цены и фотографии...',
    '🔄 Обрабатываем данные поставщика...',
    '🔄 Почти загрузили...',
  ],
  ai: [
    '🔄 Генерируем SEO-контент...',
    '🔄 Подбираем ключевые слова для WB...',
    '🔄 Составляем описание карточки...',
    '🔄 Формируем буллеты для инфографики...',
    '🔄 Адаптируем под российский рынок...',
    '🔄 Готовим вопросы поставщику...',
  ],
  wb: [
    '🔄 Ищем похожие товары на Wildberries...',
    '🔄 Анализируем цены конкурентов...',
    '🔄 Загружаем фото для поиска на WB...',
    '🔄 Фильтруем нерелевантные товары...',
    '🔄 Оцениваем качество выборки...',
    '🔄 Рассчитываем экономику...',
  ],
  zip: [
    '🔄 Собираем архив с фотографиями...',
    '🔄 Скачиваем изображения товара...',
    '🔄 Формируем SEO-файл...',
    '🔄 Упаковываем материалы...',
    '🔄 Почти готово, отправляем...',
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

function isNetworkError(e: unknown): boolean {
  if (e instanceof DOMException && e.name === 'TimeoutError') return true;
  if (e instanceof TypeError && (e.message === 'terminated' || e.message === 'fetch failed')) return true;
  return false;
}

const DEFAULT_FILTER_KEYWORDS: WbFilterKeywords = { required: [], optional: [], exclude: [] };

export async function handleLink(ctx: Context, url: string): Promise<void> {
  const userId = (ctx as any).dbUserId as string;
  const startTime = Date.now();

  const status = await getStatus(userId);
  if (!status.canGenerate) {
    track(userId, 'upgrade_shown');
    await ctx.reply(
      `🔎 <b>Лимит разборов исчерпан</b>\n\n/upgrade для продолжения`,
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

    const cached = await findProductByKey(cacheKey);
    let product: ProductWithContent;
    let zipResult: Buffer | null = null;

    rawProduct.titleCn = normalizeCnText(rawProduct.titleCn);
    if (rawProduct.description) rawProduct.description = normalizeCnText(rawProduct.description);

    if (cached?.data_json) {
      console.log('[pipeline] Cache hit:', cacheKey);
      const d = cached.data_json as any;

      const wbFiltered = d.wbFiltered ?? null;
      const riskFlags = d.riskFlags ?? buildRiskFlags(rawProduct, wbFiltered);
      const economics = d.economics;
      const budgets = d.budgets ?? calcBudgetScenarios(economics.costRub, economics.weightMissing, rawProduct.moq);
      const maxPurchasePrice = d.maxPurchasePrice ?? (wbFiltered?.medianPrice
        ? calcMaxPurchasePrice(wbFiltered.medianPrice, rawProduct.weightKg, economics.yuanToRub, undefined, rawProduct.priceYuan)
        : null);
      const conclusion = d.conclusion ?? buildConclusion(rawProduct.platform, economics, wbFiltered, riskFlags);

      product = {
        ...rawProduct,
        titleRu: cached.title_ru ?? rawProduct.titleCn,
        cacheKey,
        seoContent: d.seoContent,
        wbData: d.wbData ?? null,
        wbFiltered,
        riskFlags,
        economics,
        budgets,
        maxPurchasePrice,
        conclusion,
        cachedAt: new Date(cached.created_at),
      };
    } else {
      // ─── Шаги 2-4 ПАРАЛЛЕЛЬНО: AI + WB + ZIP ─────────────────────────────
      progress.step('ai');

      const searchImage = rawProduct.mainImageUrl || rawProduct.images[0];
      const wbQuery = rawProduct.titleEn || rawProduct.titleCn;

      const [seoContent, wbData, initialEconomics, zipBuf] = await Promise.all([
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
        }).catch((): AiContentResult => ({
          titleRu: rawProduct.titleEn || rawProduct.titleCn,
          description: '',
          bullets: [] as string[],
          keywords: [] as string[],
          characteristics: {} as Record<string, string>,
          isFallback: true,
        })),

        marketProvider.searchSimilar(wbQuery, searchImage).catch(() => null),

        calcEconomics({
          platform: rawProduct.platform,
          priceYuan: rawProduct.priceYuan,
          weightKg: rawProduct.weightKg,
        }),

        zipBuilder.buildFromUrls(rawProduct.images, { maxImages: 15, maxSizeBytes: 20 * 1024 * 1024 }),
      ]);

      zipResult = zipBuf;

      // Фильтрация WB данных
      progress.step('wb');
      const filterKeywords = seoContent.filterKeywords ?? DEFAULT_FILTER_KEYWORDS;
      const searchQueries = seoContent.searchQueries ?? seoContent.keywords?.slice(0, 3) ?? [];
      const wbFiltered = filterWbData(wbData, filterKeywords, searchQueries);

      // Пересчёт экономики с медианой WB
      const economics = wbFiltered && wbFiltered.medianPrice > 0
        ? await calcEconomics({
            platform: rawProduct.platform,
            priceYuan: rawProduct.priceYuan,
            weightKg: rawProduct.weightKg,
            wbMedianPrice: wbFiltered.medianPrice,
          })
        : initialEconomics;

      const riskFlags = buildRiskFlags(rawProduct, wbFiltered);
      const budgets = calcBudgetScenarios(economics.costRub, economics.weightMissing, rawProduct.moq);
      const maxPurchasePrice = wbFiltered?.medianPrice
        ? calcMaxPurchasePrice(wbFiltered.medianPrice, rawProduct.weightKg, economics.yuanToRub, undefined, rawProduct.priceYuan)
        : null;
      const conclusion = buildConclusion(rawProduct.platform, economics, wbFiltered, riskFlags);

      product = {
        ...rawProduct,
        titleRu: seoContent.titleRu,
        cacheKey,
        seoContent,
        wbData,
        wbFiltered,
        riskFlags,
        economics,
        budgets,
        maxPurchasePrice,
        conclusion,
      };

      upsertProduct(userId, product).catch((e) => console.error('[pipeline] upsert failed:', e));
    }

    // ─── SEO текст ──────────────────────────────────────────────────────────
    progress.step('zip');
    const seoText = formatSeoText(product, product.seoContent, product.riskFlags);
    const zipBuffer = zipResult ?? await zipBuilder.buildFromUrls(product.images, { maxImages: 15, maxSizeBytes: 20 * 1024 * 1024 });

    // ─── Стоп прогресс ──────────────────────────────────────────────────────
    progress.stop();
    await ctx.telegram.deleteMessage(chatId, progressMsgId).catch(() => {});

    const durationMs = Date.now() - startTime;
    await track(userId, 'generation_done', { durationMs, cacheHit: !!cached, url });

    // ─── Отправляем 3 сообщения ─────────────────────────────────────────────
    const freshStatus = await getStatus(userId);
    const { text: mainText, keyboard: mainKb } = buildMainMessage(product, '', freshStatus);
    await ctx.reply(mainText, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...mainKb,
    });

    const seoBuffer = Buffer.from(seoText, 'utf-8');
    await ctx.replyWithDocument(Input.fromBuffer(seoBuffer, 'wb_seo.txt'), {
      caption: '📄 SEO-материалы для карточки WB',
    });
    if (zipBuffer) {
      await ctx.replyWithDocument(Input.fromBuffer(zipBuffer, 'images.zip'), {
        caption: `🖼 Фото товара (${product.images.length} шт.)`,
      });
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

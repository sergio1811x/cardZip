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

const PIPELINE_STEPS: Record<string, string> = {
  fetch: '🔄 Анализирую товар: <b>Шаг 1/4</b>. Получаю данные с площадки...',
  ai: '🔄 Анализирую товар: <b>Шаг 2/4</b>. Генерирую SEO-контент и буллеты...',
  wb: '🔄 Анализирую товар: <b>Шаг 3/4</b>. Собираю цены конкурентов на WB...',
  zip: '🔄 Анализирую товар: <b>Шаг 4/4</b>. Собираю материалы и архив...',
};

const WAIT_PHRASES = [
  '⏳ Запрашиваем данные у китайского сервера, это может занять время...',
  '🔄 Сервер обрабатывает запрос, пожалуйста, подождите...',
  '🌏 Получаем информацию от поставщика, почти готово...',
  '☕ Осталось совсем немного, формируем результат...',
  '🚀 Финализируем данные, спасибо за ожидание...',
];

function createProgressUpdater(ctx: Context, chatId: number, msgId: number) {
  let currentStep = '';
  let waitIndex = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let seconds = 0;

  const edit = async (text: string) => {
    try {
      await ctx.telegram.editMessageText(chatId, msgId, undefined, text, { parse_mode: 'HTML' });
    } catch {}
  };

  timer = setInterval(() => {
    seconds += 15;
    if (seconds >= 15) {
      const phrase = WAIT_PHRASES[waitIndex % WAIT_PHRASES.length];
      edit(`${currentStep}\n\n<i>${phrase}</i>`);
      waitIndex++;
    }
  }, 15_000);

  return {
    step(key: string) {
      currentStep = PIPELINE_STEPS[key] ?? key;
      seconds = 0;
      waitIndex = 0;
      edit(currentStep);
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

  const progressMsg = await ctx.reply(PIPELINE_STEPS.fetch, { parse_mode: 'HTML' });
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
      // ─── Шаг 2: AI SEO ───────────────────────────────────────────────────
      progress.step('ai');
      const seoContent = await aiContentGenerator.generate({
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
      }));

      // Для WB поиска: русский от AI, или английский от Elim, или китайский
      const wbQuery = seoContent.isFallback
        ? (rawProduct.titleEn || rawProduct.titleCn)
        : seoContent.titleRu;

      // ─── Шаг 3: WB поиск ─────────────────────────────────────────────────
      progress.step('wb');
      const wbData = await marketProvider.searchSimilar(wbQuery, rawProduct.mainImageUrl).catch(() => null);

      // ─── Экономика + вердикт ──────────────────────────────────────────────
      const economics = await calcEconomics({
        priceYuan: rawProduct.priceYuan,
        weightKg: rawProduct.weightKg,
        wbAvgPrice: wbData?.avgPrice,
      });

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

    // ─── Шаг 5: Сборка материалов ───────────────────────────────────────
    progress.step('zip');
    const [zipBuffer, seoText] = await Promise.all([
      zipBuilder.buildFromUrls(product.images, { maxImages: 15, maxSizeBytes: 20 * 1024 * 1024 }),
      Promise.resolve(formatSeoText(product, product.seoContent)),
    ]);

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

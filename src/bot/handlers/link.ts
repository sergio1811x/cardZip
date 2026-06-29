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
import { createJob } from '../../db/queries/jobs';
import { supabase } from '../../db/supabase';
import { redis } from '../../lib/redis';
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
  const chatId = ctx.chat?.id;
  if (!userId || !chatId) return;

  const status = await getStatus(userId);
  if (!status.canGenerate) {
    await track(userId, 'upgrade_shown');
    await ctx.reply(
      `🔎 <b>Лимит разборов исчерпан</b>\n\nВыберите формат работы:`,
      {
        parse_mode: 'HTML',
        ...require('telegraf').Markup.inlineKeyboard([
          [require('telegraf').Markup.button.callback('10 анализов · 150 ⭐', 'pay_pack10')],
          [require('telegraf').Markup.button.callback('30 анализов · 300 ⭐', 'pay_pack30')],
          [require('telegraf').Markup.button.callback('7 дней Pro · 500 ⭐', 'pay_week')],
        ]),
      }
    );
    return;
  }

  if (redis) {
    const processing = await redis.get(`processing:${userId}`).catch(() => null);
    if (processing) {
      await ctx.reply('⏳ Предыдущий анализ ещё выполняется. Дождитесь результата.');
      return;
    }
  }

  const progressMsg = await ctx.reply('⏳ Запрос принят, начинаю анализ...', { parse_mode: 'HTML' });
  const messageId = (progressMsg as Message.TextMessage).message_id;

  let job: any = null;
  try {
    job = await createJob(userId, chatId, messageId, url);
    if (redis) await redis.set(`processing:${userId}`, job.id, { ex: 75 }).catch(() => null);
    await track(userId, 'sent_link', { url });

    const baseUrl =
      process.env.APP_URL ||
      process.env.PUBLIC_APP_URL ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '');

    if (!baseUrl) {
      throw new Error('APP_URL/PUBLIC_APP_URL/VERCEL_URL is not configured for step pipeline');
    }

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 4000);
    await fetch(`${baseUrl.replace(/\/$/, '')}/api/step1-elim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: job.id }),
      signal: ac.signal,
    }).catch(() => null);
  } catch (e: any) {
    if (job?.id) {
      await supabase.from('jobs').update({
        status: 'failed',
        error: e?.message ?? 'link_handler_failed',
        finished_at: new Date().toISOString(),
      }).eq('id', job.id).then(() => null, () => null);
    }
    if (redis) await redis.del(`processing:${userId}`).catch(() => null);
    await ctx.telegram.editMessageText(chatId, messageId, undefined, '⚠️ Не удалось запустить анализ. Попробуйте ещё раз.', { parse_mode: 'HTML' }).catch(() => null);
  }
}

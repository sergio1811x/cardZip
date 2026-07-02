import type { Context } from 'telegraf';
import type { Message } from 'telegraf/typings/core/types/typegram';
import { getStatus } from '../../services/subscriptionService';
import { track } from '../../services/analyticsService';
import { createJob } from '../../db/queries/jobs';
import { supabase } from '../../db/supabase';
import { redis } from '../../lib/redis';
import { triggerPipelineStep } from '../../lib/pipelineStep';

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
    '🔄 Структурируем закупочный пакет...',
    '🔄 Составляем описание карточки...',
    '🔄 Формируем буллеты для инфографики...',
    '🔄 Проверяем риски и claims...',
    '🔄 Готовим вопросы поставщику...',
  ],
  package: [
    '🔄 Считаем закупочную готовность...',
    '🔄 Разбираем цену и SKU...',
    '🔄 Формируем ТЗ байеру...',
    '🔄 Формируем ТЗ карго...',
    '🔄 Готовим чек-лист образца...',
    '🔄 Считаю предварительную себестоимость...',
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

  const progressMsg = await ctx.reply('🔍 <b>Анализирую товар с 1688...</b>\n\nЧто делаю:\n1. Получаю данные товара\n2. Разбираю SKU и цену\n3. Определяю риски закупки\n4. Готовлю вопросы поставщику\n5. Формирую файлы для байера, карго и карточки\n\n⏱ Обычно 40–70 секунд', { parse_mode: 'HTML' });
  const messageId = (progressMsg as Message.TextMessage).message_id;

  let job: any = null;
  try {
    job = await createJob(userId, chatId, messageId, url);
    if (redis) await redis.set(`processing:${userId}`, job.id, { ex: Number(process.env.PROCESSING_LOCK_TTL_SEC ?? 900) }).catch(() => null);
    await track(userId, 'sent_link', { url });

    const started = await triggerPipelineStep(undefined, '/api/step1-elim', { jobId: job.id }, { logPrefix: 'link' });
    if (!started) throw new Error('step1_trigger_failed');
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

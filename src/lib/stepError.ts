import { supabase } from '../db/supabase';
import { redis } from './redis';
import { Telegraf } from 'telegraf';

function getUserMessage(errorMsg: string): string {
  const lower = errorMsg.toLowerCase();

  if (lower.includes('не удалось распознать url') || lower.includes('invalid_url'))
    return '❌ Эта ссылка не на товар.\n\nБот работает только со ссылками на конкретный товар с 1688, Taobao или Tmall.\nСсылки на подборки, магазины и категории не поддерживаются.';

  if (lower.includes('elim') && (lower.includes('timeout') || lower.includes('не ответил')))
    return '❌ Сервис парсинга не отвечает.\n\nПопробуйте через 1–2 минуты.\nКредит не списан.';

  if (lower.includes('elim') && lower.includes('401'))
    return '❌ Ошибка доступа к парсеру.\n\nМы уже знаем о проблеме. Попробуйте позже.\nКредит не списан.';

  if (lower.includes('товар не найден') || lower.includes('ссылка устарела'))
    return '⚠️ Не удалось разобрать товар.\n\nСсылка могла устареть или карточка недоступна. Попробуйте открыть отчёт заново или отправьте другую ссылку.';

  if (lower.includes('step') && lower.includes('trigger'))
    return '❌ Сервер перегружен.\n\nПопробуйте через минуту.\nКредит не списан.';

  return '❌ Не удалось завершить анализ.\n\nПопробуйте ещё раз.\nКредит не списан.';
}

export async function handleStepError(
  jobId: string,
  errorMsg: string,
  bot?: Telegraf
): Promise<void> {
  try {
    const { data: job } = await supabase
      .from('jobs')
      .select('tg_chat_id, tg_message_id, user_id')
      .eq('id', jobId)
      .single();

    if (!job) return;

    await supabase.from('jobs').update({
      status: 'failed',
      error: errorMsg,
      finished_at: new Date().toISOString(),
    }).eq('id', jobId);

    const userMsg = getUserMessage(errorMsg);

    if (job.tg_message_id && bot) {
      await bot.telegram.editMessageText(
        job.tg_chat_id, job.tg_message_id, undefined, userMsg
      ).catch(() => {
        bot.telegram.deleteMessage(job.tg_chat_id, job.tg_message_id!).catch(() => {});
        bot.telegram.sendMessage(job.tg_chat_id, userMsg).catch(() => {});
      });
    }

    if (redis && job.user_id) {
      await redis.del(`processing:${job.user_id}`).catch(() => {});
    }
  } catch {}
}

import { supabase } from '../db/supabase';
import { redis } from './redis';
import { Telegraf } from 'telegraf';

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

    // Помечаем failed
    await supabase.from('jobs').update({
      status: 'failed',
      error: errorMsg,
      finished_at: new Date().toISOString(),
    }).eq('id', jobId);

    // Заменяем прогресс на ошибку
    if (job.tg_message_id && bot) {
      await bot.telegram.editMessageText(
        job.tg_chat_id, job.tg_message_id, undefined,
        '❌ Не удалось завершить анализ.\n\nПопробуйте ещё раз.\nКредит не списан.'
      ).catch(() => {
        // Если editMessage не сработал — удаляем и шлём новое
        bot.telegram.deleteMessage(job.tg_chat_id, job.tg_message_id!).catch(() => {});
        bot.telegram.sendMessage(job.tg_chat_id,
          '❌ Не удалось завершить анализ.\n\nПопробуйте ещё раз.\nКредит не списан.'
        ).catch(() => {});
      });
    }

    // Снимаем processing lock
    if (redis && job.user_id) {
      await redis.del(`processing:${job.user_id}`).catch(() => {});
    }
  } catch {}
}

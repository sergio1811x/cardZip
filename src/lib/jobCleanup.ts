import { supabase } from '../db/supabase';
import { redis } from './redis';

const STUCK_TIMEOUT_MS = 90_000; // 90с — чуть больше 60с лимита Vercel

export async function cleanupStuckJobs(userId: string, chatId: number, bot: any): Promise<boolean> {
  // Ищем jobs в промежуточных статусах старше 3 минут
  const cutoff = new Date(Date.now() - STUCK_TIMEOUT_MS).toISOString();

  const { data: stuckJobs } = await supabase
    .from('jobs')
    .select('id, tg_message_id, status, updated_at')
    .eq('user_id', userId)
    .in('status', ['pending', 'elim', 'elim_done', 'sku_pending', 'ai_processing', 'ai_done', 'market_processing'])
    .lt('updated_at', cutoff)
    .limit(5);

  if (!stuckJobs?.length) return false;

  for (const job of stuckJobs) {
    // Помечаем как failed
    await supabase.from('jobs').update({
      status: 'failed',
      error: 'timeout',
      finished_at: new Date().toISOString(),
    }).eq('id', job.id);

    // Удаляем прогресс-сообщение
    if (job.tg_message_id) {
      await bot.telegram.deleteMessage(chatId, job.tg_message_id).catch(() => {});
    }
  }

  // Снимаем processing lock
  if (redis) {
    await redis.del(`processing:${userId}`).catch(() => {});
  }

  // Сообщаем пользователю
  await bot.telegram.sendMessage(chatId,
    '⚠️ Предыдущий анализ не завершился из-за таймаута. Попробуйте отправить ссылку ещё раз.'
  ).catch(() => {});

  return true;
}

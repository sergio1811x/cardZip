import { supabase } from '../db/supabase';
import { redis } from './redis';

const STUCK_TIMEOUT_MS = 75_000; // 75с — чуть больше 60с лимита Vercel

export async function cleanupStuckJobs(userId: string, chatId: number, botOrTelegram: any): Promise<boolean> {
  const cutoff = new Date(Date.now() - STUCK_TIMEOUT_MS).toISOString();

  const { data: stuckJobs } = await supabase
    .from('jobs')
    .select('id, tg_message_id, status, updated_at')
    .eq('user_id', userId)
    .in('status', ['pending', 'elim', 'elim_done', 'sku_pending', 'ai_processing', 'ai_done', 'market_processing'])
    .lt('updated_at', cutoff)
    .limit(5);

  if (!stuckJobs?.length) return false;

  // Определяем telegram API (может быть bot.telegram или ctx.telegram)
  const tg = botOrTelegram.telegram ?? botOrTelegram;

  for (const job of stuckJobs) {
    await supabase.from('jobs').update({
      status: 'failed',
      error: 'timeout',
      finished_at: new Date().toISOString(),
    }).eq('id', job.id);

    if (job.tg_message_id) {
      await tg.editMessageText(
        chatId, job.tg_message_id, undefined,
        '❌ Анализ не завершился из-за таймаута.\n\nПопробуйте ещё раз.\nКредит не списан.'
      ).catch(() => {
        tg.deleteMessage(chatId, job.tg_message_id).catch(() => {});
      });
    }
  }

  if (redis) {
    await redis.del(`processing:${userId}`).catch(() => {});
  }

  return true;
}

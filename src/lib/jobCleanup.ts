import { supabase } from '../db/supabase';
import { redis } from './redis';

const STUCK_TIMEOUT_MS = 90_000; // 90с — один step максимум 60с + запас

export async function cleanupStuckJobs(userId: string, chatId: number, botOrTelegram: any): Promise<boolean> {
  const cutoff = new Date(Date.now() - STUCK_TIMEOUT_MS).toISOString();

  // Ищем зависшие jobs — все промежуточные статусы + done но не отправленные
  const { data: stuckJobs } = await supabase
    .from('jobs')
    .select('id, tg_message_id, status, updated_at, created_at')
    .eq('user_id', userId)
    .or(
      `and(status.in.(pending,elim,elim_done,sku_pending,ai_processing,ai_done,market_processing),updated_at.lt.${cutoff}),` +
      `and(status.eq.done,sent_to_telegram.eq.false,updated_at.lt.${cutoff})`
    )
    .limit(5);

  if (!stuckJobs?.length) return false;

  const tg = botOrTelegram.telegram ?? botOrTelegram;

  for (const job of stuckJobs) {
    console.log(`[cleanup] Stuck job ${job.id} status=${job.status} updated=${job.updated_at}`);

    await supabase.from('jobs').update({
      status: 'failed',
      error: `timeout_cleanup (was ${job.status})`,
      finished_at: new Date().toISOString(),
    }).eq('id', job.id);

    if (job.tg_message_id) {
      await tg.editMessageText(
        chatId, job.tg_message_id, undefined,
        '❌ Анализ не завершился.\n\nПопробуйте ещё раз.\nКредит не списан.'
      ).catch(() => {
        tg.deleteMessage(chatId, job.tg_message_id).catch(() => {});
      });
    }
  }

  if (redis) {
    await redis.del(`processing:${userId}`).catch(() => {});
    // Очищаем все step locks для этого юзера
    const keys = stuckJobs.map((j) => `step:step1:${j.id}`);
    keys.push(...stuckJobs.map((j) => `step:step2:${j.id}`));
    keys.push(...stuckJobs.map((j) => `step:step3:${j.id}`));
    keys.push(...stuckJobs.map((j) => `step:step4:${j.id}`));
    for (const k of keys) await redis.del(k).catch(() => {});
  }

  return true;
}

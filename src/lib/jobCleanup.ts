import { supabase } from '../db/supabase';
import { redis } from './redis';

const STUCK_TIMEOUT_MS = Number(process.env.JOB_STUCK_TIMEOUT_MS ?? 10 * 60_000);

export async function cleanupStuckJobs(userId: string, chatId: number, botOrTelegram: any): Promise<boolean> {
  const cutoff = new Date(Date.now() - STUCK_TIMEOUT_MS).toISOString();

  // Ищем ВСЕ незавершённые jobs юзера
  const { data: activeJobs } = await supabase
    .from('jobs')
    .select('id, tg_message_id, status, updated_at, created_at')
    .eq('user_id', userId)
    .in('status', [
      'pending',
      'processing',
      'elim',
      'elim_done',
      'sku_pending',
      'ai_processing',
      'ai_done',
      'market_processing',
      'package_processing',
      'done',
    ])
    .limit(10);

  // Фильтруем зависшие: старше 90с ИЛИ done+not_sent
  const stuckJobs = (activeJobs ?? []).filter((j) => {
    const ts = j.updated_at ?? j.created_at;
    if (!ts) return true;
    const isOld = new Date(ts).getTime() < Date.now() - STUCK_TIMEOUT_MS;
    if (j.status === 'done') return isOld; // done но не отправлено
    return isOld;
  });

  const tg = botOrTelegram.telegram ?? botOrTelegram;

  if (stuckJobs.length > 0) {
    for (const job of stuckJobs) {
      console.log(`[cleanup] Stuck job ${job.id} status=${job.status} updated=${job.updated_at ?? job.created_at}`);

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
  }

  // Проверяем: остались ли активные (не зависшие) jobs
  const remainingActive = (activeJobs ?? []).length - stuckJobs.length;

  // Если нет активных jobs — всегда сбрасываем processing lock
  if (remainingActive <= 0 && redis) {
    await redis.del(`processing:${userId}`).catch(() => {});
  }

  if (stuckJobs.length > 0 && redis) {
    const keys = stuckJobs.flatMap((j) => [
      `lock:step1:${j.id}`, `lock:step2:${j.id}`, `lock:step3:${j.id}`, `lock:step4:${j.id}`, `lock:step5:${j.id}`,
      `step:step1:${j.id}`, `step:step2:${j.id}`, `step:step3:${j.id}`, `step:step4:${j.id}`, `step:step5:${j.id}`,
    ]);
    for (const k of keys) await redis.del(k).catch(() => {});
  }

  return stuckJobs.length > 0;
}

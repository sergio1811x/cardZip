import { supabase } from '../db/supabase';
import { redis } from './redis';
import { buildStepLockKey } from './stepLock';

const STUCK_TIMEOUT_MS = 90_000;
const ACTIVE_JOB_STATUSES = [
  'pending',
  'processing',
  'elim',
  'elim_done',
  'sku_pending',
  'ai_processing',
  'ai_done',
  'market_processing',
  'done',
  'qa_pending',
] as const;

function getTelegramClient(botOrTelegram: any): any | null {
  return botOrTelegram?.telegram ?? botOrTelegram ?? null;
}

export async function cleanupStuckJobs(userId: string, chatId: number, botOrTelegram: any): Promise<boolean> {
  const now = Date.now();

  // Ищем незавершённые jobs юзера. Done intentionally не трогаем без отдельного sent_at/delivered флага.
  const { data: activeJobs, error } = await supabase
    .from('jobs')
    .select('id, tg_message_id, status, updated_at, created_at')
    .eq('user_id', userId)
    .in('status', [...ACTIVE_JOB_STATUSES])
    .limit(10);

  if (error) {
    console.warn('[cleanup] Failed to query active jobs:', error.message);
    return false;
  }

  const stuckJobs = (activeJobs ?? []).filter((j) => {
    const ts = j.updated_at ?? j.created_at;
    if (!ts) return true;
    const parsed = new Date(ts).getTime();
    if (!Number.isFinite(parsed)) return true;
    return parsed < now - STUCK_TIMEOUT_MS;
  });

  const tg = getTelegramClient(botOrTelegram);

  if (stuckJobs.length > 0) {
    for (const job of stuckJobs) {
      console.log(`[cleanup] Stuck job ${job.id} status=${job.status} updated=${job.updated_at ?? job.created_at}`);

      await supabase.from('jobs').update({
        status: 'failed',
        error: `timeout_cleanup (was ${job.status})`,
        finished_at: new Date().toISOString(),
      }).eq('id', job.id);

      if (job.tg_message_id && tg) {
        await tg.editMessageText(
          chatId, job.tg_message_id, undefined,
          '❌ Анализ не завершился.\n\nПопробуйте ещё раз.\nКредит не списан.'
        ).catch(() => {
          tg.deleteMessage?.(chatId, job.tg_message_id).catch(() => {});
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
      buildStepLockKey('step1', String(j.id)),
      buildStepLockKey('step2', String(j.id)),
      buildStepLockKey('step3', String(j.id)),
      buildStepLockKey('step4', String(j.id)),
      // Backward compatibility with older lock prefix used in previous cleanup code.
      `step:step1:${j.id}`,
      `step:step2:${j.id}`,
      `step:step3:${j.id}`,
      `step:step4:${j.id}`,
    ]);
    for (const k of keys) await redis.del(k).catch(() => {});
  }

  return stuckJobs.length > 0;
}

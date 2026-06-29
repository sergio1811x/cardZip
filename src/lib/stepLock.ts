import { redis } from './redis';

export async function acquireStepLock(stepName: string, jobId: string): Promise<boolean> {
  if (!redis) return true;
  const key = `lock:${stepName}:${jobId}`;
  const ttlSec = Number(process.env.STEP_LOCK_TTL_SEC ?? 900);
  const result = await redis.set(key, '1', { nx: true, ex: ttlSec });
  if (result === null) {
    console.log(`[${stepName}] Duplicate blocked for job ${jobId}`);
    return false;
  }
  return true;
}

// Продлить processing lock на время всего анализа. На Railway один LLM/provider step
// может легитимно идти 60–180 секунд, поэтому старые 75с давали ложные stuck jobs.
export async function extendProcessingLock(userId: string): Promise<void> {
  if (!redis) return;
  const ttlSec = Number(process.env.PROCESSING_LOCK_TTL_SEC ?? 900);
  await redis.expire(`processing:${userId}`, ttlSec).catch(() => {});
}

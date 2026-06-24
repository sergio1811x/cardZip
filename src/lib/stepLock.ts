import { redis } from './redis';

export async function acquireStepLock(stepName: string, jobId: string): Promise<boolean> {
  if (!redis) return true;
  const key = `lock:${stepName}:${jobId}`;
  const result = await redis.set(key, '1', { nx: true, ex: 120 });
  if (result === null) {
    console.log(`[${stepName}] Duplicate blocked for job ${jobId}`);
    return false;
  }
  return true;
}

// Продлить processing lock на ещё 75с (вызывать в начале каждого step)
export async function extendProcessingLock(userId: string): Promise<void> {
  if (!redis) return;
  await redis.expire(`processing:${userId}`, 75).catch(() => {});
}

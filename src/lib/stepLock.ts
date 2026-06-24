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

import { redis } from './redis';

const DEFAULT_STEP_LOCK_TTL_SECONDS = 120;
const DEFAULT_PROCESSING_LOCK_TTL_SECONDS = 75;

function sanitizeLockPart(value: string): string {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9:_-]/g, '_').slice(0, 120);
}

export function buildStepLockKey(stepName: string, jobId: string): string {
  return `lock:${sanitizeLockPart(stepName)}:${sanitizeLockPart(jobId)}`;
}

export async function acquireStepLock(stepName: string, jobId: string): Promise<boolean> {
  if (!redis) return true;

  const key = buildStepLockKey(stepName, jobId);

  try {
    const result = await redis.set(key, '1', { nx: true, ex: DEFAULT_STEP_LOCK_TTL_SECONDS });
    if (result === null) {
      console.log(`[${stepName}] Duplicate blocked for job ${jobId}`);
      return false;
    }
    return true;
  } catch (error) {
    // Redis is a protection layer, not a single point of failure for the job pipeline.
    console.warn(`[${stepName}] Step lock unavailable for job ${jobId}:`, error instanceof Error ? error.message : error);
    return true;
  }
}

export async function releaseStepLock(stepName: string, jobId: string): Promise<void> {
  if (!redis) return;
  await redis.del(buildStepLockKey(stepName, jobId)).catch(() => {});
}

// Продлить processing lock на ещё 75с (вызывать в начале каждого step)
export async function extendProcessingLock(userId: string): Promise<void> {
  if (!redis || !userId) return;
  await redis.expire(`processing:${sanitizeLockPart(userId)}`, DEFAULT_PROCESSING_LOCK_TTL_SECONDS).catch(() => {});
}

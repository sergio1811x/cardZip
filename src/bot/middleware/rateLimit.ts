import { redis } from '../../lib/redis';

interface RateLimitResult {
  allowed: boolean;
  retryAfterSec?: number;
}

async function checkLimit(key: string, maxHits: number, windowSec: number): Promise<RateLimitResult> {
  if (!redis) return { allowed: true };

  try {
    const current = await redis.incr(key);
    if (current === 1) {
      await redis.expire(key, windowSec);
    }
    if (current > maxHits) {
      const ttl = await redis.ttl(key);
      return { allowed: false, retryAfterSec: ttl > 0 ? ttl : windowSec };
    }
    return { allowed: true };
  } catch {
    return { allowed: true };
  }
}

// 1 ссылка в 30с
export async function checkLinkLimit(userId: string): Promise<RateLimitResult> {
  return checkLimit(`rl:link:${userId}`, 1, 30);
}

// 5 callback нажатий в 10с
export async function checkCallbackLimit(userId: string): Promise<RateLimitResult> {
  return checkLimit(`rl:cb:${userId}`, 5, 10);
}

// Глобальный: 10 любых действий в минуту
export async function checkGlobalLimit(userId: string): Promise<RateLimitResult> {
  return checkLimit(`rl:global:${userId}`, 10, 60);
}

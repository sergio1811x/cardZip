import type { Context, MiddlewareFn } from 'telegraf';
import { redis } from '../../lib/redis';
import { AppError } from '../../lib/errors';

const FREE_WINDOW_SECONDS = 10;

/**
 * Rate limit для free-пользователей: 1 запрос / 10 секунд.
 * Paid-пользователи получают окно 1 сек для защиты от abuse.
 */
export function rateLimitMiddleware(isPaid: boolean): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const userId = (ctx as any).dbUserId as string | undefined;
    if (!userId || !redis) return next();

    const window = isPaid ? 1 : FREE_WINDOW_SECONDS;
    const key = `rl:${userId}`;

    let current: number | null = null;
    try {
      current = await redis.get<number>(key);
    } catch {
      return next();
    }

    if (current !== null && current !== undefined) {
      throw new AppError(
        'RATE_LIMITED',
        `Rate limit: userId=${userId}`,
        `⏳ Подожди ${window} секунд перед следующим запросом.`
      );
    }

    try {
      await redis.set(key, 1, { ex: window });
    } catch {}

    return next();
  };
}

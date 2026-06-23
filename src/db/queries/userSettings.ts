import { supabase } from '../supabase';
import { redis } from '../../lib/redis';
import type { UserTariffs } from '../../types';

const CACHE_TTL = 2 * 24 * 60 * 60; // 2 дня

function cacheKey(userId: string): string {
  return `tariffs:${userId}`;
}

export async function getUserTariffs(userId: string): Promise<UserTariffs | null> {
  if (redis) {
    const cached = await redis.get(cacheKey(userId));
    if (cached) {
      return typeof cached === 'string' ? JSON.parse(cached) : cached as UserTariffs;
    }
  }

  const { data } = await supabase
    .from('users')
    .select('custom_tariffs')
    .eq('id', userId)
    .single();

  const tariffs = (data?.custom_tariffs as UserTariffs) ?? null;

  if (redis && tariffs) {
    await redis.set(cacheKey(userId), JSON.stringify(tariffs), { ex: CACHE_TTL }).catch(() => {});
  }

  return tariffs;
}

export async function saveUserTariffs(userId: string, tariffs: UserTariffs): Promise<void> {
  await supabase
    .from('users')
    .update({ custom_tariffs: tariffs })
    .eq('id', userId);

  if (redis) {
    if (Object.keys(tariffs).length > 0) {
      await redis.set(cacheKey(userId), JSON.stringify(tariffs), { ex: CACHE_TTL }).catch(() => {});
    } else {
      await redis.del(cacheKey(userId)).catch(() => {});
    }
  }
}

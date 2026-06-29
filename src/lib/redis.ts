import { Redis } from '@upstash/redis';

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;

function createRedis(): Redis | null {
  if (!url || !token) {
    console.warn('⚠️  UPSTASH_REDIS не настроен — rate limit отключён');
    return null;
  }
  return new Redis({ url, token });
}

export const redis = createRedis();

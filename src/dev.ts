import 'dotenv/config';
import { bot } from './bot/index';

const required = ['TELEGRAM_BOT_TOKEN', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const;
for (const key of required) {
  if (!process.env[key]) {
    console.error(`❌ Переменная ${key} не задана в .env`);
    process.exit(1);
  }
}

const optional = ['UPSTASH_REDIS_REST_URL', 'OPENROUTER_API_KEY', 'TOPSAPI_KEY'];
for (const key of optional) {
  if (!process.env[key]) console.warn(`⚠️  ${key} не задан — часть функций не будет работать`);
}

bot.launch(() => console.log('🤖 Бот запущен в polling-режиме'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

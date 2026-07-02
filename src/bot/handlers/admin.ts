import type { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { getAdminMetrics } from '../../db/queries/events';
import { redis } from '../../lib/redis';

const ADMIN_IDS: number[] = (process.env.TELEGRAM_ADMIN_TG_ID ?? '')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => !isNaN(n));

function isAdmin(ctx: Context): boolean {
  return ADMIN_IDS.includes(ctx.from?.id ?? 0);
}

export async function handleAdmin(ctx: Context): Promise<void> {
  if (!isAdmin(ctx)) { await ctx.reply('⛔ Нет доступа'); return; }

  await ctx.reply('⏳ Считаю...');

  try {
    const metrics = await getAdminMetrics();
    await ctx.reply(metrics, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([]),
    });
  } catch (e) {
    console.error('[admin]', e);
    await ctx.reply('❌ Ошибка при получении метрик');
  }
}

export async function handleUpdateLegacyCategories(ctx: Context): Promise<void> {
  if (!isAdmin(ctx)) { await ctx.answerCbQuery('⛔'); return; }
  await ctx.answerCbQuery('Раздел отключён в MVP закупочного пакета.');
}

export async function getAdminLegacyDatePending(chatId: number): Promise<boolean> {
  if (!redis) return false;
  const v = await redis.get(`admin_legacy_date:${chatId}`);
  return !!v;
}

export async function handleAdminLegacyDateInput(ctx: Context, text: string): Promise<boolean> {
  const chatId = ctx.chat?.id;
  if (!chatId) return false;

  const pending = await getAdminLegacyDatePending(chatId);
  if (!pending) return false;

  if (redis) await redis.del(`admin_legacy_date:${chatId}`);
  await ctx.reply('Старый импорт категорий отключён в MVP закупочного пакета.');
  return true;
}

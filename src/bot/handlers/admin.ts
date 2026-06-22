import type { Context } from 'telegraf';
import { getAdminMetrics } from '../../db/queries/events';

const ADMIN_IDS: number[] = (process.env.TELEGRAM_ADMIN_TG_ID ?? '')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => !isNaN(n));

export async function handleAdmin(ctx: Context): Promise<void> {
  const tgId = ctx.from?.id;
  if (!tgId || !ADMIN_IDS.includes(tgId)) {
    await ctx.reply('⛔ Нет доступа');
    return;
  }

  await ctx.reply('⏳ Считаю...');

  try {
    const metrics = await getAdminMetrics();
    await ctx.reply(metrics, { parse_mode: 'HTML' });
  } catch (e) {
    console.error('[admin]', e);
    await ctx.reply('❌ Ошибка при получении метрик');
  }
}

import type { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { getAdminMetrics } from '../../db/queries/events';
import { redis } from '../../lib/redis';
import { getPipelineBaseUrl } from '../../lib/pipelineStep';

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
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Обновить WB-категории', 'admin_update_wb_cats')],
      ]),
    });
  } catch (e) {
    console.error('[admin]', e);
    await ctx.reply('❌ Ошибка при получении метрик');
  }
}

export async function handleUpdateWbCategories(ctx: Context): Promise<void> {
  if (!isAdmin(ctx)) { await ctx.answerCbQuery('⛔'); return; }

  await ctx.answerCbQuery();

  const chatId = ctx.chat?.id;
  if (!chatId) return;

  if (redis) {
    await redis.set(`admin_wb_date:${chatId}`, '1', { ex: 120 });
  }

  await ctx.reply(
    '📅 Введите дату данных wbcon.ru (формат YYYY-MM-DD):\n\nНапример: <code>2026-06-18</code>',
    { parse_mode: 'HTML' },
  );
}

export async function getAdminWbDatePending(chatId: number): Promise<boolean> {
  if (!redis) return false;
  const v = await redis.get(`admin_wb_date:${chatId}`);
  return !!v;
}

export async function handleAdminWbDateInput(ctx: Context, text: string): Promise<boolean> {
  const chatId = ctx.chat?.id;
  if (!chatId) return false;

  const pending = await getAdminWbDatePending(chatId);
  if (!pending) return false;

  const dateMatch = text.trim().match(/^\d{4}-\d{2}-\d{2}$/);
  if (!dateMatch) {
    await ctx.reply('❌ Неверный формат. Нужен YYYY-MM-DD, например <code>2026-06-18</code>', { parse_mode: 'HTML' });
    return true;
  }

  if (redis) await redis.del(`admin_wb_date:${chatId}`);

  await ctx.reply(`⏳ Загружаю WB-категории за ${dateMatch[0]}...`);

  try {
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    const baseUrl = getPipelineBaseUrl(undefined);
    const res = await fetch(`${baseUrl}/api/update-wb-categories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cardzip-admin-secret': secret ?? '' },
      body: JSON.stringify({ secret, date: dateMatch[0] }),
      signal: AbortSignal.timeout(120_000),
    });
    const data = await res.json() as any;

    if (data.ok) {
      await ctx.reply(`✅ WB-категории загружены: ${data.loaded} из ${data.total}\nДата: ${data.date}`);
    } else {
      await ctx.reply(`❌ Ошибка: ${data.error ?? 'unknown'}`);
    }
  } catch (e: any) {
    await ctx.reply(`❌ ${e.message}`);
  }

  return true;
}

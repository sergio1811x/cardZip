import type { Context } from 'telegraf';
import { Markup } from 'telegraf';
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
  const tgId = ctx.from?.id;
  if (!tgId || !ADMIN_IDS.includes(tgId)) {
    await ctx.answerCbQuery('⛔ Нет доступа');
    return;
  }

  await ctx.answerCbQuery('Загружаю...');

  try {
    const host = 'card-zip.vercel.app';
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    const res = await fetch(`https://${host}/api/update-wb-categories?secret=${secret}`, {
      method: 'GET',
      signal: AbortSignal.timeout(55_000),
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
}

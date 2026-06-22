import type { Context } from 'telegraf';
import { track } from '../../services/analyticsService';

export async function handleStart(ctx: Context): Promise<void> {
  const userId = (ctx as any).dbUserId as string | undefined;
  if (userId) track(userId, 'start');

  await ctx.reply(
    `👋 <b>1688 → WB Copilot</b>\n\n` +
      `Пришли ссылку на товар с 1688.com — я:\n\n` +
      `• Разберу карточку поставщика\n` +
      `• Найду похожие товары на WB\n` +
      `• Рассчитаю юнит-экономику\n` +
      `• Создам SEO-текст для WB\n` +
      `• Соберу архив с фотографиями\n\n` +
      `🎁 <b>3 генерации бесплатно</b>\n\n` +
      `Просто отправь ссылку вида:\n` +
      `<code>https://detail.1688.com/offer/XXXXXXXX.html</code>`,
    { parse_mode: 'HTML' }
  );
}

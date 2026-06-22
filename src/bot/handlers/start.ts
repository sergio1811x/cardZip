import type { Context } from 'telegraf';
import { track } from '../../services/analyticsService';

export async function handleStart(ctx: Context): Promise<void> {
  const userId = (ctx as any).dbUserId as string | undefined;
  if (userId) track(userId, 'start');

  await ctx.reply(
    `🚀 <b>CardZip</b> — ИИ-копилот для селлеров и байеров.\n\n` +
      `Товар с 1688 или Taobao ➜ готовая карточка для Wildberries за ~30 секунд.\n\n` +
      `Вы получите:\n` +
      `📦 Заголовок и SEO-описание для WB\n` +
      `🖼 ZIP с исходными фото товара\n` +
      `🔍 Анализ похожих товаров на Wildberries\n` +
      `💰 Предварительную оценку юнит-экономики\n\n` +
      `Поддерживаемые источники:\n` +
      `🟧 1688 • 🟧 Taobao\n\n` +
      `👇 Просто отправьте ссылку на товар.`,
    { parse_mode: 'HTML' }
  );
}

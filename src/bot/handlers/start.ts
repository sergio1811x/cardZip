import type { Context } from 'telegraf';
import { track } from '../../services/analyticsService';

export async function handleStart(ctx: Context): Promise<void> {
  const userId = (ctx as any).dbUserId as string | undefined;
  if (userId) track(userId, 'start');

  await ctx.reply(
    `🚀 <b>CardZip</b> — ИИ-ассистент для поиска и разбора товаров из Китая.\n\n` +
      `Отправьте ссылку с 1688, Taobao или Tmall — за ~60 секунд получите понятную закупочную карточку для подготовки товара к Wildberries.\n\n` +
      `Что внутри:\n` +
      `📦 Перевод и структурирование характеристик товара\n` +
      `💰 Расчёт закупочной себестоимости и бюджета тестовой партии\n` +
      `⚠️ Риски и данные, которые нужно уточнить до заказа\n` +
      `📩 Готовые вопросы поставщику на русском и китайском\n` +
      `📝 Название, описание и характеристики для карточки WB\n` +
      `🖼 ZIP с исходными фото товара\n\n` +
      `Поддерживаемые источники:\n` +
      `🟧 1688 • 🟧 Taobao • 🟧 Tmall\n\n` +
      `👇 Отправьте ссылку на товар.`,
    { parse_mode: 'HTML' }
  );
}

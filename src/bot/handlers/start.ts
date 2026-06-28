import type { Context } from 'telegraf';
import { track } from '../../services/analyticsService';

export async function handleStart(ctx: Context): Promise<void> {
  const userId = (ctx as any).dbUserId as string | undefined;
  if (userId) track(userId, 'start');

  await ctx.reply(
    `🚀 <b>CardZip</b> — ИИ-ассистент для разбора товаров из Китая перед закупкой.\n\n` +
      `Отправьте ссылку с 1688, Taobao или Tmall — бот соберёт закупочную гипотезу для Wildberries/Ozon: товар, поставщик, риски, аналоги и предварительная экономика.\n\n` +
      `<b>Что внутри:</b>\n` +
      `📦 Характеристики товара — перевод и структура\n` +
      `💰 Себестоимость и экономика только при достаточных данных\n` +
      `🔎 Аналоги на WB — с проверкой похожести, а не просто по названию\n` +
      `📩 Готовые вопросы поставщику (RU + CN)\n` +
      `📝 SEO-черновик для карточки WB\n` +
      `📎 ТЗ для байера + ZIP с фото\n\n` +
      `<b>Важно:</b> если прямые аналоги WB не подтверждены, бот не будет рисовать псевдо-ROI — покажет риски и следующий шаг.\n\n` +
      `🟧 1688 • 🟧 Taobao • 🟧 Tmall\n` +
      `🎁 3 бесплатных анализа\n\n` +
      `👇 Отправьте ссылку на товар.`,
    { parse_mode: 'HTML' }
  );
}

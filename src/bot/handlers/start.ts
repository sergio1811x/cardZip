import type { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { track } from '../../services/analyticsService';

export async function handleStart(ctx: Context): Promise<void> {
  const userId = (ctx as any).dbUserId as string | undefined;
  if (userId) track(userId, 'start');

  await ctx.reply(
    `👋 <b>CardZip — закупочный ассистент для 1688</b>\n\n` +
      `Скиньте ссылку на товар с 1688.\n` +
      `Я подготовлю закупочный пакет:\n\n` +
      `• понятный разбор товара и SKU\n` +
      `• цену, MOQ и данные поставщика\n` +
      `• вопросы поставщику RU/CN\n` +
      `• ТЗ байеру\n` +
      `• ТЗ карго\n` +
      `• риск-чеклист\n` +
      `• рекомендацию по образцу\n` +
      `• SEO-черновик WB/Ozon\n` +
      `• ТЗ для инфографики\n\n` +
      `🎁 Бесплатно: 3 анализа\n\n` +
      `Пришлите ссылку на товар.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📦 Подготовить товар', 'new_search')],
        [Markup.button.callback('📋 Пример результата', 'example_result'), Markup.button.callback('💳 Тарифы', 'tariffs')],
        [Markup.button.callback('ℹ️ Как это работает', 'how_it_works')],
      ]),
    },
  );
}

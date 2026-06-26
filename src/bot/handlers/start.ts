import type { Context } from 'telegraf';
import { track } from '../../services/analyticsService';

export async function handleStart(ctx: Context): Promise<void> {
  const userId = (ctx as any).dbUserId as string | undefined;
  if (userId) track(userId, 'start');

  await ctx.reply(
    `🚀 <b>CardZip</b> — ИИ-ассистент для поиска и разбора товаров из Китая.\n\n` +
      `Отправьте ссылку с 1688, Taobao или Tmall — за ~60 секунд получите понятную закупочную карточку для подготовки товара к Wildberries.\n\n` +
      `<b>Что внутри:</b>\n` +
      `📦 Характеристики товара — перевод и структура\n` +
      `💰 Себестоимость, ROI и бюджет тестовой партии\n` +
      `🔎 Аналоги на WB — цены, спрос, конкуренция\n` +
      `📩 Готовые вопросы поставщику (RU + CN)\n` +
      `📝 SEO-черновик для карточки WB\n` +
      `📎 ТЗ для байера + ZIP с фото\n\n` +
      `<b>Пример результата:</b>\n` +
      `Комбинезон спортивный, от 26¥ (~340₽)\n` +
      `→ 3 аналога на WB, медиана 2 169₽\n` +
      `→ ROI ~45%, маржа ~35%\n` +
      `→ Вопросы поставщику + ТЗ байеру готовы\n\n` +
      `🟧 1688 • 🟧 Taobao • 🟧 Tmall\n` +
      `🎁 3 бесплатных анализа\n\n` +
      `👇 Отправьте ссылку на товар.`,
    { parse_mode: 'HTML' }
  );
}

import type { Context } from 'telegraf';
import { track } from '../../services/analyticsService';

export async function handleStart(ctx: Context): Promise<void> {
  const userId = (ctx as any).dbUserId as string | undefined;
  if (userId) track(userId, 'start');

  await ctx.reply(
    `🚀 <b>CardZip</b> — ИИ-закупщик для товаров с 1688, Taobao и Tmall.\n\n` +
      `Отправьте ссылку — бот соберёт закупочный пакет для проверки товара перед WB/Ozon.\n\n` +
      `<b>Что внутри:</b>\n` +
      `📦 Понятный разбор товара и свойств\n` +
      `📋 Нормализация SKU: цвета, размеры, комплектации\n` +
      `💰 Цена 1688 и себестоимость без/с карго\n` +
      `⚠️ Риски и закупочная готовность 0–100\n` +
      `💬 Вопросы поставщику на русском и китайском\n` +
      `🧾 ТЗ байеру и отдельное ТЗ карго\n` +
      `📝 SEO-черновик WB/Ozon\n` +
      `🖼 ТЗ для инфографики\n` +
      `🧪 Рекомендация по образцу\n\n` +
      `<b>Важно:</b> мы не обещаем прибыль и не считаем автоматический ROI без ваших данных. CardZip помогает не закупать вслепую и быстро понять, что нужно подтвердить.\n\n` +
      `🎁 3 бесплатных анализа\n\n` +
      `👇 Отправьте ссылку на товар.`,
    { parse_mode: 'HTML' }
  );
}

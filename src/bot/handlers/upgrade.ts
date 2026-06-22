import type { Context } from 'telegraf';
import { sendInvoice, handleSuccessfulPayment } from '../../services/paymentService';
import { track } from '../../services/analyticsService';
import { Markup } from 'telegraf';

export async function handleUpgrade(ctx: Context): Promise<void> {
  const userId = (ctx as any).dbUserId as string | undefined;
  if (userId) track(userId, 'upgrade_clicked');

  await ctx.reply(
    `🚀 <b>Выбери тариф</b>\n\n` +
      `<b>Seller — 1 490 ₽/мес</b>\n` +
      `• Безлимитный анализ товаров\n` +
      `• Готовые WB материалы (SEO + фото)\n` +
      `• История /last\n\n` +
      `<b>Business — 2 990 ₽/мес</b>\n` +
      `• Всё из Seller\n` +
      `• Будущие функции: batch-импорт, сравнение поставщиков`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('💳 Seller — 1 490 ₽/мес', 'pay_seller')],
        [Markup.button.callback('💎 Business — 2 990 ₽/мес', 'pay_business')],
      ]),
    }
  );
}

export async function handlePaySeller(ctx: Context): Promise<void> {
  await ctx.answerCbQuery();
  await sendInvoice(ctx, 'seller');
}

export async function handlePayBusiness(ctx: Context): Promise<void> {
  await ctx.answerCbQuery();
  await sendInvoice(ctx, 'business');
}

export async function handleSuccessPayment(ctx: Context): Promise<void> {
  const userId = (ctx as any).dbUserId as string | undefined;
  if (!userId) return;
  await handleSuccessfulPayment(ctx, userId);
}

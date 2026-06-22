import type { Context } from 'telegraf';
import * as subscriptionService from './subscriptionService';
import { track } from './analyticsService';

// Цены в копейках (Telegram требует минимальную единицу валюты)
const PRICES = {
  seller: { amount: 149000, label: 'Seller — 1 месяц' },   // 1490 ₽
  business: { amount: 299000, label: 'Business — 1 месяц' }, // 2990 ₽
};

export async function sendInvoice(ctx: Context, plan: 'seller' | 'business'): Promise<void> {
  const price = PRICES[plan];
  await ctx.replyWithInvoice({
    title: `cardZip — ${price.label}`,
    description:
      plan === 'seller'
        ? 'Безлимитный анализ товаров + готовые WB материалы + история /last'
        : 'Business план (будущие функции: batch-импорт, сравнение поставщиков)',
    payload: JSON.stringify({ plan, userId: (ctx as any).dbUserId }),
    provider_token: process.env.TELEGRAM_PAYMENT_PROVIDER_TOKEN ?? '',
    currency: 'RUB',
    prices: [{ label: price.label, amount: price.amount }],
  });
}

export async function handleSuccessfulPayment(
  ctx: Context,
  userId: string
): Promise<void> {
  const payment = (ctx.message as any)?.successful_payment;
  if (!payment) return;

  let plan: 'seller' | 'business' = 'seller';
  try {
    const payloadData = JSON.parse(payment.invoice_payload);
    if (payloadData.plan === 'business') plan = 'business';
  } catch {
    // payload не распарсился — оставляем seller
  }

  await subscriptionService.activate(userId, plan, 1);
  track(userId, 'paid', { plan, amount: payment.total_amount });

  await ctx.reply(
    `✅ Оплата прошла! Подписка <b>${plan === 'seller' ? 'Seller' : 'Business'}</b> активирована на 1 месяц.\n\nОтправляй ссылку на товар — анализирую без ограничений 🚀`,
    { parse_mode: 'HTML' }
  );
}

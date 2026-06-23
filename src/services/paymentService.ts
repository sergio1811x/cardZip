import type { Context } from 'telegraf';
import * as subscriptionService from './subscriptionService';
import { track } from './analyticsService';
import type { Plan } from '../types';

const PACKAGES: Record<string, { amount: number; label: string; plan: Plan }> = {
  pack10: { amount: 29900, label: '10 разборов', plan: 'pack10' },
  pack30: { amount: 59900, label: '30 разборов', plan: 'pack30' },
  week:   { amount: 99000, label: 'Неделя активной закупки', plan: 'week' },
};

export async function sendInvoice(ctx: Context, packageId: string): Promise<void> {
  const pkg = PACKAGES[packageId];
  if (!pkg) return;

  const descriptions: Record<string, string> = {
    pack10: '10 полных разборов товаров. Кредиты не сгорают.',
    pack30: '30 полных разборов — выгоднее! ~20 ₽ за разбор. Кредиты не сгорают.',
    week: '7 дней безлимитного поиска (до 50 разборов). Для активной фазы закупки.',
  };

  await ctx.replyWithInvoice({
    title: `CardZip — ${pkg.label}`,
    description: descriptions[packageId] ?? '',
    payload: JSON.stringify({ plan: pkg.plan, userId: (ctx as any).dbUserId }),
    provider_token: process.env.TELEGRAM_PAYMENT_PROVIDER_TOKEN ?? '',
    currency: 'RUB',
    prices: [{ label: pkg.label, amount: pkg.amount }],
  });
}

export async function handleSuccessfulPayment(
  ctx: Context,
  userId: string
): Promise<void> {
  const payment = (ctx.message as any)?.successful_payment;
  if (!payment) return;

  let plan: Plan = 'pack10';
  try {
    const payloadData = JSON.parse(payment.invoice_payload);
    if (payloadData.plan) plan = payloadData.plan as Plan;
  } catch {}

  await subscriptionService.activate(userId, plan);
  track(userId, 'paid', { plan, amount: payment.total_amount });

  const labels: Record<string, string> = {
    pack10: '10 разборов',
    pack30: '30 разборов',
    week: 'Неделя активной закупки (до 50 разборов)',
  };

  await ctx.reply(
    `✅ Оплата прошла! Активировано: <b>${labels[plan] ?? plan}</b>.\n\nОтправляйте ссылку на товар 👇`,
    { parse_mode: 'HTML' }
  );
}

import type { Context } from 'telegraf';
import * as subscriptionService from './subscriptionService';
import { track } from './analyticsService';
import type { Plan } from '../types';

// Telegram Stars: 1 звезда ≈ 1.8 ₽
const PACKAGES: Record<string, { stars: number; label: string; plan: Plan; description: string }> = {
  test: {
    stars: 1,
    label: 'Тест 3 разбора',
    plan: 'pack10' as Plan,
    description: 'Тестовый пакет: 3 разбора за 1 звезду.',
  },
  pack10: {
    stars: 165,
    label: '10 разборов',
    plan: 'pack10',
    description: '10 полных разборов товаров из Китая. Кредиты не сгорают.',
  },
  pack30: {
    stars: 335,
    label: '30 разборов ⭐',
    plan: 'pack30',
    description: '30 полных разборов — выгоднее! ~10 ⭐ за разбор. Кредиты не сгорают.',
  },
  week: {
    stars: 550,
    label: 'Неделя закупки',
    plan: 'week',
    description: '7 дней активного поиска (до 50 разборов). Для байеров в фазе закупки.',
  },
};

export async function sendInvoice(ctx: Context, packageId: string): Promise<void> {
  const pkg = PACKAGES[packageId];
  if (!pkg) return;

  await (ctx as any).replyWithInvoice({
    title: `CardZip — ${pkg.label}`,
    description: pkg.description,
    payload: JSON.stringify({ plan: pkg.plan, credits: pkg.stars === 1 ? 3 : undefined, userId: (ctx as any).dbUserId }),
    provider_token: '',
    currency: 'XTR',
    prices: [{ label: pkg.label, amount: pkg.stars }],
  });
}

export async function handleSuccessfulPayment(
  ctx: Context,
  userId: string
): Promise<void> {
  const payment = (ctx.message as any)?.successful_payment;
  if (!payment) return;

  let plan: Plan = 'pack10';
  let creditsOverride: number | undefined;
  try {
    const payloadData = JSON.parse(payment.invoice_payload);
    if (payloadData.plan) plan = payloadData.plan as Plan;
    if (payloadData.credits) creditsOverride = payloadData.credits;
  } catch {}

  await subscriptionService.activate(userId, plan, creditsOverride);
  track(userId, 'paid', { plan, stars: payment.total_amount, currency: payment.currency });

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

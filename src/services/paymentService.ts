import type { Context } from 'telegraf';
import * as subscriptionService from './subscriptionService';
import { track } from './analyticsService';

interface PackageConfig {
  stars: number;
  label: string;
  credits: number;
  unlimitedDays: number;
  unlimitedLimit: number;
  description: string;
}

const PACKAGES: Record<string, PackageConfig> = {
  test: {
    stars: 1,
    label: '1 анализ (тест)',
    credits: 1,
    unlimitedDays: 0,
    unlimitedLimit: 0,
    description: 'Тестовый анализ за 1 звезду.',
  },
  pack10: {
    stars: 150,
    label: '10 анализов',
    credits: 10,
    unlimitedDays: 0,
    unlimitedLimit: 0,
    description: '10 анализов товаров из Китая. Аналоги на WB, экономика и ТЗ байеру. Кредиты не сгорают.',
  },
  pack30: {
    stars: 300,
    label: '30 анализов',
    credits: 30,
    unlimitedDays: 0,
    unlimitedLimit: 0,
    description: '30 анализов товаров из Китая. Аналоги на WB, экономика и ТЗ байеру. Кредиты не сгорают.',
  },
  week: {
    stars: 500,
    label: '7 дней Pro',
    credits: 0,
    unlimitedDays: 7,
    unlimitedLimit: 100,
    description: 'Доступ на 7 дней: до 100 анализов товаров из Китая. Аналоги на WB, экономика и ТЗ байеру.',
  },
};

const processedCharges = new Set<string>();

function parsePayload(raw: unknown): { packageId: string } | null {
  try {
    const parsed = JSON.parse(String(raw ?? '{}'));
    const packageId = String(parsed.packageId ?? '');
    return PACKAGES[packageId] ? { packageId } : null;
  } catch {
    return null;
  }
}

export async function sendInvoice(ctx: Context, packageId: string): Promise<void> {
  const pkg = PACKAGES[packageId];
  if (!pkg) return;

  await (ctx as any).replyWithInvoice({
    title: `CardZip — ${pkg.label}`,
    description: pkg.description,
    payload: JSON.stringify({ packageId }),
    provider_token: '',
    currency: 'XTR',
    prices: [{ label: pkg.label, amount: pkg.stars }],
  });
}

export async function handlePreCheckout(ctx: Context): Promise<void> {
  const query = (ctx as any).preCheckoutQuery;
  if (!query) return;
  const payload = parsePayload(query.invoice_payload);
  const pkg = payload ? PACKAGES[payload.packageId] : null;
  const ok = Boolean(pkg && query.currency === 'XTR' && query.total_amount === pkg.stars);
  await (ctx as any).answerPreCheckoutQuery(ok, ok ? undefined : 'Платёж не прошёл проверку пакета. Попробуйте выбрать тариф заново.');
}

export async function handleSuccessfulPayment(
  ctx: Context,
  userId: string
): Promise<void> {
  const payment = (ctx.message as any)?.successful_payment;
  if (!payment) return;

  const payload = parsePayload(payment.invoice_payload);
  if (!payload) {
    await ctx.reply('⚠️ Не удалось определить оплаченный пакет. Напишите в поддержку.');
    return;
  }

  const pkg = PACKAGES[payload.packageId];
  if (payment.currency !== 'XTR' || payment.total_amount !== pkg.stars) {
    await ctx.reply('⚠️ Сумма платежа не совпала с выбранным пакетом. Кредиты не начислены, напишите в поддержку.');
    return;
  }

  const chargeId = String(payment.telegram_payment_charge_id || payment.provider_payment_charge_id || '');
  if (chargeId && processedCharges.has(chargeId)) {
    await ctx.reply('✅ Платёж уже был обработан. Баланс не дублирую.');
    return;
  }
  if (chargeId) processedCharges.add(chargeId);

  if (pkg.unlimitedDays > 0) {
    await subscriptionService.activateUnlimited(userId, pkg.unlimitedDays, pkg.unlimitedLimit);
  } else {
    await subscriptionService.addCredits(userId, pkg.credits);
  }

  track(userId, 'paid', { packageId: payload.packageId, stars: payment.total_amount, chargeId });

  const successMsg = pkg.unlimitedDays > 0
    ? `✅ Активировано: <b>${pkg.label}</b> (до ${pkg.unlimitedLimit} разборов за ${pkg.unlimitedDays} дней)`
    : `✅ Добавлено: <b>${pkg.credits} разборов</b>. Кредиты не сгорают.`;

  await ctx.reply(`${successMsg}\n\nОтправляйте ссылку на товар 👇`, { parse_mode: 'HTML' });
}

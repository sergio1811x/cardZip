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

const processedPayments = new Set<string>();
const MAX_PROCESSED_PAYMENTS = 1000;

function rememberPayment(key: string): boolean {
  if (!key) return true;
  if (processedPayments.has(key)) return false;

  processedPayments.add(key);
  if (processedPayments.size > MAX_PROCESSED_PAYMENTS) {
    const first = processedPayments.values().next().value;
    if (first) processedPayments.delete(first);
  }

  return true;
}

function parsePackageId(rawPayload: unknown): string | null {
  if (typeof rawPayload !== 'string' || !rawPayload.trim()) return null;

  try {
    const payload = JSON.parse(rawPayload) as { packageId?: unknown };
    return typeof payload.packageId === 'string' ? payload.packageId : null;
  } catch {
    return null;
  }
}

function getPaymentId(payment: any): string {
  return String(
    payment?.telegram_payment_charge_id ||
    payment?.provider_payment_charge_id ||
    payment?.invoice_payload ||
    ''
  );
}

function isValidPayment(payment: any, pkg: PackageConfig): boolean {
  if (!payment) return false;
  if (payment.currency !== 'XTR') return false;
  if (Number(payment.total_amount) !== pkg.stars) return false;
  return true;
}

export function getPackage(packageId: string): PackageConfig | null {
  return PACKAGES[packageId] ?? null;
}

export async function sendInvoice(ctx: Context, packageId: string): Promise<void> {
  const pkg = PACKAGES[packageId];
  if (!pkg) {
    await ctx.reply('Неизвестный тариф. Откройте /upgrade и выберите пакет заново.');
    return;
  }

  await (ctx as any).replyWithInvoice({
    title: `CardZip — ${pkg.label}`,
    description: pkg.description,
    payload: JSON.stringify({ packageId, v: 1 }),
    provider_token: '',
    currency: 'XTR',
    prices: [{ label: pkg.label, amount: pkg.stars }],
  });
}

export async function handlePreCheckout(ctx: Context): Promise<void> {
  const preCheckoutQuery = (ctx as any).preCheckoutQuery;
  if (!preCheckoutQuery) return;

  const packageId = parsePackageId(preCheckoutQuery.invoice_payload);
  const pkg = packageId ? PACKAGES[packageId] : null;
  const ok = Boolean(pkg && preCheckoutQuery.currency === 'XTR' && Number(preCheckoutQuery.total_amount) === pkg.stars);

  await (ctx as any).answerPreCheckoutQuery(ok, ok ? undefined : 'Пакет не найден или сумма платежа не совпадает. Выберите тариф заново.');
}

export async function handleSuccessfulPayment(
  ctx: Context,
  userId: string
): Promise<void> {
  const payment = (ctx.message as any)?.successful_payment;
  if (!payment || !userId) return;

  const packageId = parsePackageId(payment.invoice_payload);
  const pkg = packageId ? PACKAGES[packageId] : null;

  if (!pkg || !packageId || !isValidPayment(payment, pkg)) {
    console.warn('[payment] Invalid successful_payment payload/amount', {
      userId,
      packageId,
      currency: payment?.currency,
      totalAmount: payment?.total_amount,
    });
    await ctx.reply('⚠️ Платёж получен, но пакет не распознан. Напишите в поддержку — начислим вручную.');
    return;
  }

  const paymentId = getPaymentId(payment);
  if (!rememberPayment(`${userId}:${paymentId}`)) {
    console.warn('[payment] Duplicate successful_payment ignored', { userId, paymentId });
    await ctx.reply('✅ Этот платёж уже был обработан. Отправляйте ссылку на товар 👇');
    return;
  }

  if (pkg.unlimitedDays > 0) {
    await subscriptionService.activateUnlimited(userId, pkg.unlimitedDays, pkg.unlimitedLimit);
  } else {
    await subscriptionService.addCredits(userId, pkg.credits);
  }

  await track(userId, 'paid', {
    packageId,
    stars: payment.total_amount,
    currency: payment.currency,
    telegramPaymentChargeId: payment.telegram_payment_charge_id,
    providerPaymentChargeId: payment.provider_payment_charge_id,
  });

  const successMsg = pkg.unlimitedDays > 0
    ? `✅ Активировано: <b>${pkg.label}</b> (до ${pkg.unlimitedLimit} разборов за ${pkg.unlimitedDays} дней)`
    : `✅ Добавлено: <b>${pkg.credits} разборов</b>. Кредиты не сгорают.`;

  await ctx.reply(`${successMsg}\n\nОтправляйте ссылку на товар 👇`, { parse_mode: 'HTML' });
}

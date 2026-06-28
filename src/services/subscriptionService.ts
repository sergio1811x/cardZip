import { supabase } from '../db/supabase';
import type { SubscriptionStatus } from '../types';

type SubscriptionRow = Record<string, unknown>;

function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asPositiveInt(value: unknown, fallback = 0): number {
  const n = Math.floor(asNumber(value, fallback));
  return n > 0 ? n : fallback;
}

function parseDate(value: unknown): Date | null {
  if (!value) return null;
  const d = new Date(String(value));
  return Number.isFinite(d.getTime()) ? d : null;
}

async function getSub(userId: string): Promise<SubscriptionRow | null> {
  if (!userId) return null;

  const { data, error } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    console.warn('[subscription] getSub failed:', error.message ?? error);
    return null;
  }

  return data ?? null;
}

export async function getStatus(userId: string): Promise<SubscriptionStatus> {
  const sub = await getSub(userId);

  if (!sub) {
    return { plan: 'free', creditsRemaining: 0, creditsTotal: 0, canGenerate: false, isTrial: true };
  }

  const creditsRemaining = Math.max(0, asNumber(sub.credits_remaining, 0));
  const isTrial = Boolean(sub.is_trial ?? false);
  const unlimitedUntil = parseDate(sub.unlimited_until);
  const unlimitedUsed = Math.max(0, asNumber(sub.unlimited_used, 0));
  const unlimitedLimit = Math.max(0, asNumber(sub.unlimited_limit, 0));
  const unlimitedActive = unlimitedUntil ? unlimitedUntil > new Date() : false;
  const unlimitedRemaining = unlimitedActive ? Math.max(0, unlimitedLimit - unlimitedUsed) : 0;

  if (unlimitedActive && unlimitedRemaining > 0) {
    return {
      plan: 'week',
      creditsRemaining: unlimitedRemaining,
      creditsTotal: unlimitedLimit,
      canGenerate: true,
      isTrial: false,
      activeUntil: unlimitedUntil ?? undefined,
    };
  }

  return {
    plan: creditsRemaining > 0 ? 'pack10' : 'free',
    creditsRemaining,
    creditsTotal: creditsRemaining,
    canGenerate: creditsRemaining > 0,
    isTrial,
  };
}

async function updateUnlimitedUsageAtomically(userId: string, sub: SubscriptionRow): Promise<boolean> {
  const unlimitedUntil = parseDate(sub.unlimited_until);
  const unlimitedUsed = Math.max(0, asNumber(sub.unlimited_used, 0));
  const unlimitedLimit = Math.max(0, asNumber(sub.unlimited_limit, 0));

  if (!unlimitedUntil || unlimitedUntil <= new Date() || unlimitedUsed >= unlimitedLimit) {
    return false;
  }

  const { data, error } = await supabase
    .from('subscriptions')
    .update({
      unlimited_used: unlimitedUsed + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
    .eq('unlimited_used', unlimitedUsed)
    .gt('unlimited_until', new Date().toISOString())
    .select('user_id')
    .maybeSingle();

  if (error) {
    console.warn('[subscription] consume unlimited failed:', error.message ?? error);
    return false;
  }

  return Boolean(data);
}

async function updateCreditsAtomically(userId: string, sub: SubscriptionRow): Promise<boolean> {
  const creditsRemaining = Math.max(0, asNumber(sub.credits_remaining, 0));
  if (creditsRemaining <= 0) return false;

  const newRemaining = creditsRemaining - 1;
  const update: Record<string, unknown> = {
    credits_remaining: newRemaining,
    updated_at: new Date().toISOString(),
  };

  if (newRemaining <= 0 && Boolean(sub.is_trial)) {
    update.is_trial = false;
  }

  const { data, error } = await supabase
    .from('subscriptions')
    .update(update)
    .eq('user_id', userId)
    .eq('credits_remaining', creditsRemaining)
    .gt('credits_remaining', 0)
    .select('user_id')
    .maybeSingle();

  if (error) {
    console.warn('[subscription] consume credit failed:', error.message ?? error);
    return false;
  }

  return Boolean(data);
}

export async function tryConsumeCredit(userId: string): Promise<boolean> {
  const sub = await getSub(userId);
  if (!sub) return false;

  if (await updateUnlimitedUsageAtomically(userId, sub)) return true;
  if (await updateCreditsAtomically(userId, sub)) return true;

  // Если была гонка обновлений, перечитываем один раз и пробуем снова.
  const freshSub = await getSub(userId);
  if (!freshSub) return false;

  if (await updateUnlimitedUsageAtomically(userId, freshSub)) return true;
  if (await updateCreditsAtomically(userId, freshSub)) return true;

  return false;
}

export async function consumeCredit(userId: string): Promise<void> {
  const consumed = await tryConsumeCredit(userId);
  if (!consumed) {
    throw new Error('NO_AVAILABLE_CREDITS');
  }
}

export async function addCredits(userId: string, amount: number): Promise<void> {
  const safeAmount = asPositiveInt(amount, 0);
  if (!userId || safeAmount <= 0) return;

  const now = new Date().toISOString();

  for (let attempt = 0; attempt < 3; attempt++) {
    const sub = await getSub(userId);

    if (!sub) {
      const { error } = await supabase.from('subscriptions').insert({
        user_id: userId,
        credits_remaining: safeAmount,
        unlimited_until: null,
        unlimited_used: 0,
        unlimited_limit: 0,
        updated_at: now,
      });

      if (!error) return;
      // Если строка появилась параллельно, перечитываем и пробуем update.
      console.warn('[subscription] insert credits failed, retry update:', error.message ?? error);
      continue;
    }

    const currentCredits = Math.max(0, asNumber(sub.credits_remaining, 0));
    const { data, error } = await supabase.from('subscriptions')
      .update({
        credits_remaining: currentCredits + safeAmount,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .eq('credits_remaining', currentCredits)
      .select('user_id')
      .maybeSingle();

    if (!error && data) return;
    if (error) console.warn('[subscription] add credits failed, retry:', error.message ?? error);
  }

  throw new Error('ADD_CREDITS_FAILED');
}

export async function activateUnlimited(userId: string, days: number, limit: number): Promise<void> {
  const safeDays = asPositiveInt(days, 0);
  const safeLimit = asPositiveInt(limit, 0);
  if (!userId || safeDays <= 0 || safeLimit <= 0) return;

  const sub = await getSub(userId);
  const currentUntil = parseDate(sub?.unlimited_until);
  const base = currentUntil && currentUntil > new Date() ? currentUntil : new Date();
  const until = new Date(base);
  until.setDate(until.getDate() + safeDays);

  const now = new Date().toISOString();

  if (sub) {
    await supabase.from('subscriptions')
      .update({
        unlimited_until: until.toISOString(),
        unlimited_used: 0,
        unlimited_limit: safeLimit,
        updated_at: now,
      })
      .eq('user_id', userId);
  } else {
    await supabase.from('subscriptions').insert({
      user_id: userId,
      credits_remaining: 0,
      unlimited_until: until.toISOString(),
      unlimited_used: 0,
      unlimited_limit: safeLimit,
      updated_at: now,
    });
  }
}

// Legacy compat
export async function activate(userId: string, plan: string, creditsOverride?: number): Promise<void> {
  if (plan === 'week') {
    await activateUnlimited(userId, 7, 100);
  } else {
    const amount = creditsOverride ?? (plan === 'pack30' ? 30 : 10);
    await addCredits(userId, amount);
  }
}

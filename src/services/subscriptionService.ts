import { supabase } from '../db/supabase';
import type { SubscriptionStatus } from '../types';

async function getSub(userId: string) {
  if (!userId) return null;
  const { data } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('user_id', userId)
    .single();
  return data;
}

function toNumber(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value ?? fallback);
  return Number.isFinite(n) ? n : fallback;
}

export async function getStatus(userId: string): Promise<SubscriptionStatus> {
  const sub = await getSub(userId);

  if (!sub) {
    return { plan: 'free', creditsRemaining: 0, creditsTotal: 0, canGenerate: false, isTrial: true };
  }

  const creditsRemaining = Math.max(0, toNumber(sub.credits_remaining));
  const isTrial = Boolean(sub.is_trial ?? false);
  const unlimitedUntil = sub.unlimited_until ? new Date(sub.unlimited_until as string) : null;
  const unlimitedUsed = Math.max(0, toNumber(sub.unlimited_used));
  const unlimitedLimit = Math.max(0, toNumber(sub.unlimited_limit));
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

export async function tryConsumeCredit(userId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const sub = await getSub(userId);
    if (!sub) return false;

    const unlimitedUntil = sub.unlimited_until ? new Date(sub.unlimited_until as string) : null;
    const unlimitedActive = unlimitedUntil ? unlimitedUntil > new Date() : false;
    const unlimitedUsed = Math.max(0, toNumber(sub.unlimited_used));
    const unlimitedLimit = Math.max(0, toNumber(sub.unlimited_limit));

    if (unlimitedActive && unlimitedUsed < unlimitedLimit) {
      const { data, error } = await supabase.from('subscriptions')
        .update({ unlimited_used: unlimitedUsed + 1, updated_at: new Date().toISOString() })
        .eq('user_id', userId)
        .eq('unlimited_used', unlimitedUsed)
        .select('user_id')
        .single();
      if (!error && data) return true;
      continue;
    }

    const credits = Math.max(0, toNumber(sub.credits_remaining));
    if (credits <= 0) return false;

    const newRemaining = credits - 1;
    const update: any = { credits_remaining: newRemaining, updated_at: new Date().toISOString() };
    if (newRemaining <= 0 && sub.is_trial) update.is_trial = false;

    const { data, error } = await supabase.from('subscriptions')
      .update(update)
      .eq('user_id', userId)
      .eq('credits_remaining', credits)
      .select('user_id')
      .single();
    if (!error && data) return true;
  }
  return false;
}

export async function consumeCredit(userId: string): Promise<void> {
  const ok = await tryConsumeCredit(userId);
  if (!ok) throw new Error('NOT_ENOUGH_CREDITS');
}

export async function addCredits(userId: string, amount: number): Promise<void> {
  const safeAmount = Math.max(0, Math.floor(Number(amount) || 0));
  if (!userId || safeAmount <= 0) return;

  for (let attempt = 0; attempt < 3; attempt++) {
    const sub = await getSub(userId);
    if (sub) {
      const current = Math.max(0, toNumber(sub.credits_remaining));
      const { data, error } = await supabase.from('subscriptions')
        .update({ credits_remaining: current + safeAmount, updated_at: new Date().toISOString() })
        .eq('user_id', userId)
        .eq('credits_remaining', current)
        .select('user_id')
        .single();
      if (!error && data) return;
      continue;
    }

    const { error } = await supabase.from('subscriptions').insert({
      user_id: userId,
      credits_remaining: safeAmount,
      unlimited_until: null,
      unlimited_used: 0,
      unlimited_limit: 0,
      updated_at: new Date().toISOString(),
    });
    if (!error) return;
  }

  throw new Error('ADD_CREDITS_FAILED');
}

export async function activateUnlimited(userId: string, days: number, limit: number): Promise<void> {
  if (!userId) return;
  const safeDays = Math.max(1, Math.floor(Number(days) || 0));
  const safeLimit = Math.max(1, Math.floor(Number(limit) || 0));
  const sub = await getSub(userId);
  const now = new Date();
  const currentUntil = sub?.unlimited_until ? new Date(sub.unlimited_until as string) : null;
  const base = currentUntil && currentUntil > now ? currentUntil : now;
  const until = new Date(base);
  until.setDate(until.getDate() + safeDays);

  if (sub) {
    await supabase.from('subscriptions')
      .update({
        unlimited_until: until.toISOString(),
        unlimited_used: 0,
        unlimited_limit: Math.max(safeLimit, toNumber(sub.unlimited_limit)),
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId);
  } else {
    await supabase.from('subscriptions').insert({
      user_id: userId,
      credits_remaining: 0,
      unlimited_until: until.toISOString(),
      unlimited_used: 0,
      unlimited_limit: safeLimit,
      updated_at: new Date().toISOString(),
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

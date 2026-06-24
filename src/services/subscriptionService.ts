import { supabase } from '../db/supabase';
import type { SubscriptionStatus } from '../types';

async function getSub(userId: string) {
  const { data } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('user_id', userId)
    .single();
  return data;
}

export async function getStatus(userId: string): Promise<SubscriptionStatus> {
  const sub = await getSub(userId);

  if (!sub) {
    // Нет записи — новый юзер без subscription (не должно быть, но fallback)
    return { plan: 'free', creditsRemaining: 0, creditsTotal: 0, canGenerate: false };
  }

  const creditsRemaining = (sub.credits_remaining as number) ?? 0;
  const unlimitedUntil = sub.unlimited_until ? new Date(sub.unlimited_until as string) : null;
  const unlimitedUsed = (sub.unlimited_used as number) ?? 0;
  const unlimitedLimit = (sub.unlimited_limit as number) ?? 0;
  const unlimitedActive = unlimitedUntil ? unlimitedUntil > new Date() : false;
  const unlimitedRemaining = unlimitedActive ? Math.max(0, unlimitedLimit - unlimitedUsed) : 0;

  // Безлимит активен
  if (unlimitedActive && unlimitedRemaining > 0) {
    return {
      plan: 'week',
      creditsRemaining: unlimitedRemaining,
      creditsTotal: unlimitedLimit,
      canGenerate: true,
      activeUntil: unlimitedUntil ?? undefined,
    };
  }

  // Кредиты
  return {
    plan: creditsRemaining > 0 ? 'pack10' : 'free',
    creditsRemaining,
    creditsTotal: creditsRemaining,
    canGenerate: creditsRemaining > 0,
  };
}

export async function consumeCredit(userId: string): Promise<void> {
  const sub = await getSub(userId);
  if (!sub) return;

  const unlimitedUntil = sub.unlimited_until ? new Date(sub.unlimited_until as string) : null;
  const unlimitedActive = unlimitedUntil ? unlimitedUntil > new Date() : false;
  const unlimitedUsed = (sub.unlimited_used as number) ?? 0;
  const unlimitedLimit = (sub.unlimited_limit as number) ?? 0;

  if (unlimitedActive && unlimitedUsed < unlimitedLimit) {
    await supabase.from('subscriptions')
      .update({ unlimited_used: unlimitedUsed + 1 })
      .eq('user_id', userId);
  } else if ((sub.credits_remaining as number) > 0) {
    await supabase.from('subscriptions')
      .update({ credits_remaining: (sub.credits_remaining as number) - 1 })
      .eq('user_id', userId);
  }
}

export async function addCredits(userId: string, amount: number): Promise<void> {
  const sub = await getSub(userId);
  if (sub) {
    await supabase.from('subscriptions')
      .update({
        credits_remaining: ((sub.credits_remaining as number) ?? 0) + amount,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId);
  } else {
    await supabase.from('subscriptions').insert({
      user_id: userId,
      credits_remaining: amount,
      unlimited_until: null, unlimited_used: 0, unlimited_limit: 0,
      updated_at: new Date().toISOString(),
    });
  }
}

export async function activateUnlimited(userId: string, days: number, limit: number): Promise<void> {
  const until = new Date();
  until.setDate(until.getDate() + days);

  const sub = await getSub(userId);
  if (sub) {
    await supabase.from('subscriptions')
      .update({
        unlimited_until: until.toISOString(),
        unlimited_used: 0,
        unlimited_limit: limit,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId);
  } else {
    await supabase.from('subscriptions').insert({
      user_id: userId, credits_remaining: 0,
      unlimited_until: until.toISOString(),
      unlimited_used: 0, unlimited_limit: limit,
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

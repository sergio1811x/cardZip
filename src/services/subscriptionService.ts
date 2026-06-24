import { supabase } from '../db/supabase';
import type { Plan, SubscriptionStatus } from '../types';

const FREE_LIMIT = 3;

async function countFreeUsed(userId: string): Promise<number> {
  const { count } = await supabase
    .from('jobs')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .in('status', ['done', 'sent']);
  return count ?? 0;
}

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
    const used = await countFreeUsed(userId);
    return {
      plan: 'free',
      creditsRemaining: Math.max(0, FREE_LIMIT - used),
      creditsTotal: FREE_LIMIT,
      canGenerate: used < FREE_LIMIT,
    };
  }

  const creditsRemaining = (sub.credits_remaining as number) ?? 0;
  const unlimitedUntil = sub.unlimited_until ? new Date(sub.unlimited_until as string) : null;
  const unlimitedUsed = (sub.unlimited_used as number) ?? 0;
  const unlimitedLimit = (sub.unlimited_limit as number) ?? 0;
  const unlimitedActive = unlimitedUntil ? unlimitedUntil > new Date() : false;
  const unlimitedRemaining = unlimitedActive ? Math.max(0, unlimitedLimit - unlimitedUsed) : 0;

  // Безлимит активен и не исчерпан
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
  if (creditsRemaining > 0) {
    return {
      plan: 'pack10',
      creditsRemaining,
      creditsTotal: creditsRemaining,
      canGenerate: true,
    };
  }

  // Бесплатные
  const used = await countFreeUsed(userId);
  const freeRemaining = Math.max(0, FREE_LIMIT - used);
  return {
    plan: 'free',
    creditsRemaining: freeRemaining,
    creditsTotal: FREE_LIMIT,
    canGenerate: freeRemaining > 0,
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
    // Тратим из безлимита
    await supabase
      .from('subscriptions')
      .update({ unlimited_used: unlimitedUsed + 1 })
      .eq('user_id', userId);
  } else if ((sub.credits_remaining as number) > 0) {
    // Тратим кредит
    await supabase
      .from('subscriptions')
      .update({ credits_remaining: (sub.credits_remaining as number) - 1 })
      .eq('user_id', userId);
  }
}

export async function addCredits(userId: string, amount: number): Promise<void> {
  const sub = await getSub(userId);

  if (sub) {
    await supabase
      .from('subscriptions')
      .update({
        credits_remaining: ((sub.credits_remaining as number) ?? 0) + amount,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId);
  } else {
    await supabase.from('subscriptions').insert({
      user_id: userId,
      credits_remaining: amount,
      unlimited_until: null,
      unlimited_used: 0,
      unlimited_limit: 0,
      updated_at: new Date().toISOString(),
    });
  }
}

export async function activateUnlimited(userId: string, days: number, limit: number): Promise<void> {
  const until = new Date();
  until.setDate(until.getDate() + days);

  const sub = await getSub(userId);
  if (sub) {
    await supabase
      .from('subscriptions')
      .update({
        unlimited_until: until.toISOString(),
        unlimited_used: 0,
        unlimited_limit: limit,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId);
  } else {
    await supabase.from('subscriptions').insert({
      user_id: userId,
      credits_remaining: 0,
      unlimited_until: until.toISOString(),
      unlimited_used: 0,
      unlimited_limit: limit,
      updated_at: new Date().toISOString(),
    });
  }
}

// Legacy compat
export async function activate(userId: string, plan: Plan, creditsOverride?: number): Promise<void> {
  if (plan === 'week') {
    await activateUnlimited(userId, 7, 200);
  } else {
    const amount = creditsOverride ?? (plan === 'pack30' ? 30 : 10);
    await addCredits(userId, amount);
  }
}

import { supabase } from '../db/supabase';
import type { Plan, SubscriptionStatus } from '../types';

const FREE_LIMIT = 3;

const PLAN_CREDITS: Record<string, number> = {
  pack10: 10,
  pack30: 30,
  week: 50,
};

// Считаем использованные кредиты по завершённым jobs
async function countUsedCredits(userId: string): Promise<number> {
  const { count } = await supabase
    .from('jobs')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .in('status', ['done', 'sent']);
  return count ?? 0;
}

// Получаем подписку
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
  const plan: Plan = (sub?.plan as Plan) ?? 'free';
  const used = await countUsedCredits(userId);

  if (plan === 'free') {
    return {
      plan: 'free',
      creditsRemaining: Math.max(0, FREE_LIMIT - used),
      creditsTotal: FREE_LIMIT,
      canGenerate: used < FREE_LIMIT,
    };
  }

  // Пакет кредитов
  if (plan === 'pack10' || plan === 'pack30') {
    const totalCredits = (sub?.credits_total as number) ?? PLAN_CREDITS[plan] ?? 0;
    const creditsUsedSincePurchase = (sub?.credits_used as number) ?? 0;
    const remaining = Math.max(0, totalCredits - creditsUsedSincePurchase);
    return {
      plan,
      creditsRemaining: remaining,
      creditsTotal: totalCredits,
      canGenerate: remaining > 0,
    };
  }

  // Неделя безлимит
  if (plan === 'week') {
    const activeUntil = sub?.active_until ? new Date(sub.active_until) : null;
    const isActive = activeUntil ? activeUntil > new Date() : false;
    const weekCreditsUsed = (sub?.credits_used as number) ?? 0;
    const remaining = isActive ? Math.max(0, 50 - weekCreditsUsed) : 0;
    return {
      plan: 'week',
      creditsRemaining: remaining,
      creditsTotal: 50,
      canGenerate: isActive && remaining > 0,
      activeUntil: activeUntil ?? undefined,
    };
  }

  // Fallback — старые планы seller/business
  const activeUntil = sub?.active_until ? new Date(sub.active_until) : null;
  const isActive = activeUntil ? activeUntil > new Date() : false;
  return {
    plan,
    creditsRemaining: isActive ? 999 : 0,
    creditsTotal: 999,
    canGenerate: isActive,
    activeUntil: activeUntil ?? undefined,
  };
}

export async function consumeCredit(userId: string): Promise<void> {
  const sub = await getSub(userId);
  if (!sub) return;

  const plan = sub.plan as Plan;
  if (plan === 'free') return; // free считается по jobs

  await supabase
    .from('subscriptions')
    .update({ credits_used: (sub.credits_used ?? 0) + 1 })
    .eq('user_id', userId);
}

export async function activate(userId: string, plan: Plan, creditsOverride?: number): Promise<void> {
  const totalCredits = creditsOverride ?? PLAN_CREDITS[plan] ?? 0;
  const now = new Date();

  let activeUntil: Date | null = null;
  if (plan === 'week') {
    activeUntil = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  }

  await supabase.from('subscriptions').upsert(
    {
      user_id: userId,
      plan,
      credits_total: totalCredits,
      credits_used: 0,
      active_until: activeUntil?.toISOString() ?? null,
      updated_at: now.toISOString(),
    },
    { onConflict: 'user_id' }
  );
}

// Для обратной совместимости
export { getStatus as default };

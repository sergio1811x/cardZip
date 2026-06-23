import {
  getSubscription,
  upsertSubscription,
  countGenerations,
} from '../db/queries/subscriptions';
import type { Plan, SubscriptionStatus } from '../types';

const FREE_LIMIT = 5;

export async function getStatus(userId: string): Promise<SubscriptionStatus> {
  const sub = await getSubscription(userId);
  const plan: Plan = sub?.plan ?? 'free';

  if (plan === 'free') {
    const used = await countGenerations(userId);
    return {
      plan: 'free',
      isActive: used < FREE_LIMIT,
      generationsUsed: used,
      generationsLimit: FREE_LIMIT,
      canGenerate: used < FREE_LIMIT,
    };
  }

  // Платный план
  const activeUntil = sub?.active_until ? new Date(sub.active_until) : null;
  const isActive = activeUntil ? activeUntil > new Date() : false;

  return {
    plan,
    isActive,
    generationsUsed: 0,
    generationsLimit: Infinity,
    canGenerate: isActive,
    activeUntil: activeUntil ?? undefined,
  };
}

/** Только для бесплатного плана — paid план не расходует счётчик здесь */
export async function consumeGeneration(_userId: string): Promise<void> {
  // Счётчик генераций у free — считается через events('generation_done')
  // Ничего не нужно писать отдельно: analyticsService.track уже пишет событие
}

export async function activate(
  userId: string,
  plan: Plan,
  months: number
): Promise<void> {
  const activeUntil = new Date();
  activeUntil.setMonth(activeUntil.getMonth() + months);
  await upsertSubscription(userId, plan, activeUntil);
}

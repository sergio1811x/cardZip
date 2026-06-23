import { supabase } from '../supabase';
import type { DbSubscription, Plan } from '../../types';

export async function getSubscription(userId: string): Promise<DbSubscription | null> {
  const { data } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('user_id', userId)
    .single();
  return (data as DbSubscription) ?? null;
}

export async function upsertSubscription(
  userId: string,
  plan: Plan,
  activeUntil: Date | null
): Promise<void> {
  const now = new Date().toISOString();
  await supabase.from('subscriptions').upsert(
    {
      user_id: userId,
      plan,
      active_until: activeUntil?.toISOString() ?? null,
      updated_at: now,
    },
    { onConflict: 'user_id' }
  );
}

/** Возвращает количество генераций — считаем по завершённым jobs (без дублей) */
export async function countGenerations(userId: string): Promise<number> {
  const { count } = await supabase
    .from('jobs')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .in('status', ['done', 'sent']);
  return count ?? 0;
}

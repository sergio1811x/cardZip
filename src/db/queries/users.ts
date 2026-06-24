import { supabase } from '../supabase';
import type { DbUser } from '../../types';

const FREE_CREDITS = 3;

export async function getOrCreateUser(tgId: number): Promise<DbUser> {
  const { data: existing } = await supabase
    .from('users')
    .select('*')
    .eq('tg_id', tgId)
    .single();

  if (existing) return existing as DbUser;

  // Создаём нового
  const { data: created, error } = await supabase
    .from('users')
    .insert({ tg_id: tgId })
    .select()
    .single();

  if (error || !created) {
    const { data: retry } = await supabase
      .from('users')
      .select('*')
      .eq('tg_id', tgId)
      .single();
    if (!retry) throw new Error(`Не удалось создать пользователя tg_id=${tgId}`);
    return retry as DbUser;
  }

  // Создаём subscription с бесплатными кредитами
  try {
    await supabase.from('subscriptions').upsert({
      user_id: created.id,
      credits_remaining: FREE_CREDITS,
      is_trial: true,
      unlimited_until: null,
      unlimited_used: 0,
      unlimited_limit: 0,
    }, { onConflict: 'user_id' });
  } catch {}

  return created as DbUser;
}

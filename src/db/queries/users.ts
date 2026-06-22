import { supabase } from '../supabase';
import type { DbUser } from '../../types';

export async function getOrCreateUser(tgId: number): Promise<DbUser> {
  // Сначала пробуем найти
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
    // Race condition: другой запрос уже создал — читаем ещё раз
    const { data: retry } = await supabase
      .from('users')
      .select('*')
      .eq('tg_id', tgId)
      .single();
    if (!retry) throw new Error(`Не удалось создать пользователя tg_id=${tgId}`);
    return retry as DbUser;
  }

  return created as DbUser;
}

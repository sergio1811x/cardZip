import { supabase } from '../supabase';
import type { UserTariffs } from '../../types';

export async function getUserTariffs(userId: string): Promise<UserTariffs | null> {
  const { data } = await supabase
    .from('users')
    .select('custom_tariffs')
    .eq('id', userId)
    .single();

  return (data?.custom_tariffs as UserTariffs) ?? null;
}

export async function saveUserTariffs(userId: string, tariffs: UserTariffs): Promise<void> {
  await supabase
    .from('users')
    .update({ custom_tariffs: tariffs })
    .eq('id', userId);
}

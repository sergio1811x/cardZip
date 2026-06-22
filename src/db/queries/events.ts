import { supabase } from '../supabase';
import type { EventName } from '../../types';

export async function insertEvent(
  userId: string,
  eventName: EventName,
  payload: Record<string, unknown> = {}
): Promise<void> {
  await supabase.from('events').insert({
    user_id: userId,
    event_name: eventName,
    payload,
  });
}

// ─── Метрики для /admin ───────────────────────────────────────────────────────

export async function getAdminMetrics(): Promise<string> {
  const [
    { count: totalUsers },
    { count: totalGenerations },
    { count: paidEvents },
    { count: dau7 },
  ] = await Promise.all([
    supabase.from('users').select('*', { count: 'exact', head: true }),
    supabase
      .from('events')
      .select('*', { count: 'exact', head: true })
      .eq('event_name', 'generation_done'),
    supabase
      .from('events')
      .select('*', { count: 'exact', head: true })
      .eq('event_name', 'paid'),
    supabase
      .from('events')
      .select('*', { count: 'exact', head: true })
      .eq('event_name', 'generation_done')
      .gte('created_at', new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()),
  ]);

  // Топ-5 активных за 7 дней
  const { data: topUsers } = await supabase.rpc('admin_top_users_7d').limit(5);

  return [
    `📊 <b>Метрики бота</b>`,
    ``,
    `👤 Всего пользователей: <b>${totalUsers ?? 0}</b>`,
    `⚡️ Генераций всего: <b>${totalGenerations ?? 0}</b>`,
    `💳 Оплат всего: <b>${paidEvents ?? 0}</b>`,
    `📅 Генераций за 7 дней: <b>${dau7 ?? 0}</b>`,
    topUsers?.length
      ? `\n🏆 Топ пользователей (7д):\n` +
        topUsers
          .map(
            (u: { tg_id: number; cnt: number }, i: number) =>
              `${i + 1}. tg_id=${u.tg_id} — ${u.cnt} ген.`
          )
          .join('\n')
      : '',
  ].join('\n');
}

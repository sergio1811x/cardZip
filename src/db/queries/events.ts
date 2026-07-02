import { supabase } from '../supabase';
import type { EventName } from '../../types';

type QualityMetricRow = {
  stage: string;
  status: 'pass' | 'warn' | 'fail';
  issuesCount: number;
  warningsCount: number;
  durationMs: number | null;
  notes: string[];
};

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
    { data: qualityMetricEvents },
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
    supabase
      .from('events')
      .select('payload, created_at')
      .eq('event_name', 'quality_metrics_recorded')
      .order('created_at', { ascending: false })
      .limit(30),
  ]);

  // Топ-5 активных за 7 дней
  const { data: topUsers } = await supabase.rpc('admin_top_users_7d').limit(5);

  const metricRows: QualityMetricRow[] = (qualityMetricEvents ?? [])
    .flatMap((row: any) => Array.isArray(row?.payload?.metrics) ? row.payload.metrics : [])
    .map((row: any) => ({
      stage: String(row?.stage ?? 'unknown'),
      status: row?.status === 'fail' || row?.status === 'warn' ? row.status : 'pass',
      issuesCount: Number(row?.issuesCount ?? 0) || 0,
      warningsCount: Number(row?.warningsCount ?? 0) || 0,
      durationMs: row?.durationMs == null ? null : Number(row.durationMs) || null,
      notes: Array.isArray(row?.notes) ? row.notes.map(String) : [],
    }));

  const groupedMetrics = new Map<string, { pass: number; warn: number; fail: number }>();
  for (const row of metricRows) {
    const current = groupedMetrics.get(row.stage) ?? { pass: 0, warn: 0, fail: 0 };
    current[row.status] += 1;
    groupedMetrics.set(row.stage, current);
  }

  const metricsText = groupedMetrics.size
    ? [
        '',
        '📈 Качество пайплайна (последние 30 quality events):',
        ...Array.from(groupedMetrics.entries()).map(
          ([stage, stats]) => `• ${stage}: pass=${stats.pass}, warn=${stats.warn}, fail=${stats.fail}`,
        ),
      ].join('\n')
    : '';

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
    metricsText,
  ].join('\n');
}

import { supabase } from '../supabase';

export interface TelegramFileIds {
  wb_card?: string;
  buyer_brief?: string;
  photos_zip?: string;
}

export interface DbJob {
  id: string;
  user_id: string;
  tg_chat_id: number;
  tg_message_id: number | null;
  status: string;
  input_url: string;
  result_json: Record<string, unknown> | null;
  error: string | null;
  sent_to_telegram: boolean;
  telegram_file_ids: TelegramFileIds | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export async function createJob(
  userId: string,
  chatId: number,
  messageId: number | null,
  inputUrl: string
): Promise<DbJob> {
  const { data, error } = await supabase
    .from('jobs')
    .insert({ user_id: userId, tg_chat_id: chatId, tg_message_id: messageId, input_url: inputUrl })
    .select()
    .single();

  if (error || !data) throw new Error(`createJob failed: ${error?.message}`);
  return data as DbJob;
}

export async function claimPendingJob(): Promise<DbJob | null> {
  const { data, error } = await supabase
    .from('jobs')
    .update({ status: 'processing', started_at: new Date().toISOString() })
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .select()
    .single();

  if (error || !data) return null;
  return data as DbJob;
}

export async function completeJob(
  jobId: string,
  resultJson: Record<string, unknown>
): Promise<void> {
  await supabase
    .from('jobs')
    .update({
      status: 'done',
      result_json: resultJson,
      finished_at: new Date().toISOString(),
    })
    .eq('id', jobId);
}

export async function failJob(jobId: string, error: string): Promise<void> {
  await supabase
    .from('jobs')
    .update({
      status: 'failed',
      error,
      finished_at: new Date().toISOString(),
    })
    .eq('id', jobId);
}

export async function getUnsentJobs(): Promise<DbJob[]> {
  const { data } = await supabase
    .from('jobs')
    .select('*')
    .in('status', ['done', 'failed'])
    .eq('sent_to_telegram', false)
    .order('finished_at', { ascending: true })
    .limit(10);

  return (data as DbJob[]) ?? [];
}

export async function markSent(jobId: string, telegramFileIds?: TelegramFileIds): Promise<void> {
  await supabase
    .from('jobs')
    .update({
      sent_to_telegram: true,
      ...(telegramFileIds ? { telegram_file_ids: telegramFileIds } : {}),
    })
    .eq('id', jobId);
}

export interface UserAnalysis {
  id: string;
  input_url: string;
  result_json: Record<string, unknown>;
  telegram_file_ids: TelegramFileIds | null;
  created_at: string;
  finished_at: string;
}

/**
 * Canonical single-job loader used by EVERY inline-button handler.
 *
 * Rules that make callbacks reliable:
 * - `.maybeSingle()` (not `.single()`): 0 rows returns null WITHOUT a thrown/DB error,
 *   so a legitimately-missing job is distinguishable from a real query failure.
 * - The Supabase `error` is logged, never swallowed. Historically each handler had its
 *   own copy of this query with `const { data } = ...` (error dropped), which is why a
 *   failing "Вопросы поставщику" button was impossible to diagnose from logs.
 * - Selects `*` so callers get result_json + input_url + id from one shape. No handler
 *   should invent its own column subset again.
 */
export async function getJobForUser(userId: string, jobId: string): Promise<DbJob | null> {
  if (!userId || !jobId) {
    console.error('[getJobForUser] missing key', { hasUserId: !!userId, hasJobId: !!jobId });
    return null;
  }
  const { data, error } = await supabase
    .from('jobs')
    .select('*')
    .eq('id', jobId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    console.error('[getJobForUser] supabase error', {
      userId,
      jobId,
      message: error.message,
      code: (error as any).code,
      details: (error as any).details,
    });
    return null;
  }
  return (data as DbJob) ?? null;
}

export async function getUserAnalyses(userId: string, limit = 10, offset = 0): Promise<UserAnalysis[]> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from('jobs')
    .select('id, input_url, result_json, telegram_file_ids, created_at, finished_at')
    .eq('user_id', userId)
    .eq('sent_to_telegram', true)
    .gte('created_at', thirtyDaysAgo)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  return (data as UserAnalysis[]) ?? [];
}

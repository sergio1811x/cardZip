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

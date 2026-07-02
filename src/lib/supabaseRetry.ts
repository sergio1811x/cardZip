import { supabase } from '../db/supabase';

const DEFAULT_RETRIES = 5;
const BASE_DELAY_MS = 500;

async function withRetry<T>(fn: () => Promise<{ data: T | null; error: any }>, label: string, retries = DEFAULT_RETRIES): Promise<{ data: T | null; error: any }> {
  let lastError: any;
  for (let i = 0; i < retries; i++) {
    const result = await fn();
    if (!result.error) return result;
    lastError = result.error;
    const isRetryable = /terminated|fetch failed|network|ECONNRESET|ETIMEDOUT/i.test(String(result.error?.message ?? result.error));
    if (!isRetryable) return result;
    console.warn(`[supabase-retry] ${label} attempt ${i + 1}/${retries} failed (${result.error.message}), retrying in ${BASE_DELAY_MS * (i + 1)}ms...`);
    await new Promise(r => setTimeout(r, BASE_DELAY_MS * (i + 1)));
  }
  throw new Error(`[supabase-retry] ${label} failed after ${retries} attempts: ${lastError?.message}`);
}

export async function getJobById(jobId: string) {
  return withRetry(() => supabase.from('jobs').select('*').eq('id', jobId).single() as any, 'getJobById');
}

export async function updateJob(jobId: string, data: Record<string, unknown>) {
  return withRetry(() => supabase.from('jobs').update(data).eq('id', jobId) as any, 'updateJob');
}

import type { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
import { supabase } from '../src/db/supabase';

export const config = { maxDuration: 10 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const host = req.headers.host || 'card-zip.vercel.app';

  // Jobs stuck in elim_done > 30s without progressing to processing
  const { data: elimStuck } = await supabase
    .from('jobs')
    .select('id')
    .eq('status', 'elim_done')
    .lt('updated_at', new Date(Date.now() - 30_000).toISOString())
    .limit(3);

  // Jobs stuck in done but not sent > 30s
  const { data: sendStuck } = await supabase
    .from('jobs')
    .select('id')
    .eq('status', 'done')
    .eq('sent_to_telegram', false)
    .lt('updated_at', new Date(Date.now() - 30_000).toISOString())
    .limit(3);

  const retried: string[] = [];

  for (const job of elimStuck ?? []) {
    console.log(`[poll] Retrying step2 for stuck job ${job.id}`);
    fetch(`https://${host}/api/step2-process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: job.id }),
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});
    retried.push(`step2:${job.id}`);
  }

  for (const job of sendStuck ?? []) {
    console.log(`[poll] Retrying step3 for stuck job ${job.id}`);
    fetch(`https://${host}/api/step3-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: job.id }),
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});
    retried.push(`step3:${job.id}`);
  }

  res.status(200).json({ ok: true, retried });
}

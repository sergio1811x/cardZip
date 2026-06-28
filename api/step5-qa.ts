import type { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
import { supabase } from '../src/db/supabase';
import { acquireStepLock, extendProcessingLock } from '../src/lib/stepLock';

export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const { jobId } = req.body ?? {};
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  try {
    if (!await acquireStepLock('step5', jobId)) {
      console.log(`[step5] Duplicate blocked for job ${jobId}`);
      return res.status(200).json({ ok: true, skip: true });
    }

    console.log(`[step5] Waiting for snapshot: ${jobId}`);

    // Poll DB until step4 saves analysisSnapshot (up to 55s)
    let snapshotFound = false;
    const start = Date.now();
    while (Date.now() - start < 55_000) {
      const { data: job } = await supabase
        .from('jobs')
        .select('status, result_json')
        .eq('id', jobId)
        .single();

      if (!job || job.status === 'failed') {
        console.warn(`[step5] Job ${jobId} failed or missing while waiting`);
        return res.status(200).json({ ok: false, reason: 'job_failed' });
      }

      const result = job.result_json as any;
      if (result?.analysisSnapshot) {
        snapshotFound = true;
        break;
      }

      await new Promise(r => setTimeout(r, 3000));
    }

    if (!snapshotFound) {
      console.error(`[step5] Timeout 55s waiting for snapshot, job ${jobId}`);
      const { handleStepError } = require('../src/lib/stepError');
      const { Telegraf } = require('telegraf');
      const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
      await handleStepError(jobId, 'step5_snapshot_timeout', bot);
      return res.status(200).json({ ok: false, reason: 'snapshot_timeout' });
    }

    // Extend processing lock before triggering step6
    const { data: job } = await supabase.from('jobs').select('user_id').eq('id', jobId).single();
    if (job?.user_id) await extendProcessingLock(job.user_id);

    // Trigger step6 — explicit external URL (avoids Vercel 508 loop detection)
    console.log(`[step5] Snapshot found, triggering step6 for ${jobId}`);
    let step6Sent = false;
    for (let i = 0; i < 2 && !step6Sent; i++) {
      try {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 4000);
        const r = await fetch('https://card-zip.vercel.app/api/step6-send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId }),
          signal: ac.signal,
        });
        if (r.ok) step6Sent = true;
      } catch {
        if (i === 0) await new Promise(r => setTimeout(r, 500));
      }
    }

    if (!step6Sent) {
      console.error(`[step5] Failed to trigger step6 for job ${jobId}`);
      const { handleStepError } = require('../src/lib/stepError');
      const { Telegraf } = require('telegraf');
      const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
      await handleStepError(jobId, 'step6_trigger_failed', bot);
    }

    res.status(200).json({ ok: true, step6Sent });
  } catch (e: any) {
    console.error('[step5]', e.message);
    res.status(200).json({ ok: false });
  }
}

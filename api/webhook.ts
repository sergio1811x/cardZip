import type { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
import { bot } from '../src/bot';
import { getOrCreateUser } from '../src/db/queries/users';
import { createJob } from '../src/db/queries/jobs';
import { getStatus } from '../src/services/subscriptionService';
import { track } from '../src/services/analyticsService';
import { supabase } from '../src/db/supabase';
import { redis } from '../src/lib/redis';

export const config = { maxDuration: 10 };

async function isDuplicate(updateId: number): Promise<boolean> {
  if (!redis) return false;
  const key = `dedup:${updateId}`;
  const result = await redis.set(key, '1', { nx: true, ex: 60 });
  return result === null;
}

async function callStep(host: string, path: string, body: object): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 4000);
      await fetch(`https://${host}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      return true;
    } catch {
      if (attempt === 0) await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  console.log(`[webhook] update_id=${req.body?.update_id} type=${req.body?.callback_query ? 'cbq' : req.body?.message?.text ? 'text' : 'other'}`);

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) {
    console.log('[webhook] SECRET MISMATCH');
    return res.status(200).json({ ok: true });
  }

  const updateId = req.body?.update_id;
  if (!updateId) return res.status(200).json({ ok: true });

  if (await isDuplicate(updateId)) {
    console.log(`[webhook] DEDUP blocked ${updateId}`);
    return res.status(200).json({ ok: true });
  }

  const msg = req.body?.message;

  const urlText = msg?.text?.trim() ?? '';
  const urlMatch = !urlText.startsWith('/') ? urlText.match(/https?:\/\/[^\s]*(1688|taobao|tmall|qr\.1688)\.com[^\s]*/i) : null;

  console.log(`[webhook] urlMatch=${!!urlMatch} text="${urlText.slice(0, 50)}"`);

  if (urlMatch && msg?.from?.id && msg?.chat?.id) {
    try {
      const dbUser = await getOrCreateUser(msg.from.id);
      const status = await getStatus(dbUser.id);
      if (!status.canGenerate) {
        await track(dbUser.id, 'upgrade_shown');
        await bot.telegram.sendMessage(msg.chat.id,
          '❌ <b>Бесплатные генерации исчерпаны</b>\n\n/upgrade для продолжения',
          { parse_mode: 'HTML' }
        );
        return res.status(200).json({ ok: true });
      }

      if (redis) {
        const urlKey = `job:${dbUser.id}:${urlMatch[0].slice(0, 80)}`;
        const dup = await redis.set(urlKey, '1', { nx: true, ex: 60 });
        if (dup === null) return res.status(200).json({ ok: true });
      }

      const progressMsg = await bot.telegram.sendMessage(msg.chat.id,
        '🔄 Загружаем данные с площадки...', { parse_mode: 'HTML' }
      );

      const job = await createJob(dbUser.id, msg.chat.id, progressMsg.message_id, urlMatch[0]);
      await track(dbUser.id, 'sent_link', { url: urlMatch[0] });

      const host = req.headers.host || 'card-zip.vercel.app';
      const sent = await callStep(host, '/api/step1-elim', { jobId: job.id });

      if (!sent) {
        await bot.telegram.editMessageText(
          msg.chat.id, progressMsg.message_id, undefined,
          '❌ Не удалось запустить обработку. Попробуй ещё раз.',
          { parse_mode: 'HTML' }
        ).catch(() => {});
        await supabase.from('jobs').update({ status: 'failed', error: 'step1_trigger_failed' }).eq('id', job.id);
      }
    } catch (e) {
      console.error('[webhook] URL pipeline:', e);
    }
    return res.status(200).json({ ok: true });
  }

  // ─── Всё остальное: callbacks, /команды, текст (tariff input) ─────────────
  try {
    await bot.handleUpdate(req.body);
  } catch (e) {
    console.error('[webhook] handleUpdate:', e);
  }
  res.status(200).json({ ok: true });
}

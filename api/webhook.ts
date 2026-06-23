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

async function callWithRetry(url: string, body: object): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 4000);
      await fetch(url, {
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

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) {
    return res.status(200).json({ ok: true });
  }

  const updateId = req.body?.update_id;
  if (!updateId) return res.status(200).json({ ok: true });

  if (await isDuplicate(updateId)) {
    return res.status(200).json({ ok: true });
  }

  const msg = req.body?.message;
  const cbq = req.body?.callback_query;

  // ─── URL pipeline: ранний 200, fire-and-forget step1 ──────────────────────
  const isUrlMessage = msg?.text && !msg.text.trim().startsWith('/') &&
    /https?:\/\/[^\s]*(1688|taobao|tmall|qr\.1688)\.com/i.test(msg.text);

  if (isUrlMessage && msg.from?.id && msg.chat?.id) {
    // Отвечаем Telegram сразу — дальше работаем async
    res.status(200).json({ ok: true });

    try {
      const dbUser = await getOrCreateUser(msg.from.id);
      const status = await getStatus(dbUser.id);
      if (!status.canGenerate) {
        await track(dbUser.id, 'upgrade_shown');
        await bot.telegram.sendMessage(msg.chat.id,
          '❌ <b>Бесплатные генерации исчерпаны</b>\n\n/upgrade для продолжения',
          { parse_mode: 'HTML' }
        );
        return;
      }

      const urlMatch = msg.text.match(/https?:\/\/[^\s]*(1688|taobao|tmall|qr\.1688)\.com[^\s]*/);
      if (!urlMatch) return;

      // Дедупликация по URL
      if (redis) {
        const urlKey = `job:${dbUser.id}:${urlMatch[0].slice(0, 80)}`;
        const dup = await redis.set(urlKey, '1', { nx: true, ex: 60 });
        if (dup === null) return;
      }

      const progressMsg = await bot.telegram.sendMessage(msg.chat.id,
        '🔄 Загружаем данные с площадки...', { parse_mode: 'HTML' }
      );

      const job = await createJob(dbUser.id, msg.chat.id, progressMsg.message_id, urlMatch[0]);
      await track(dbUser.id, 'sent_link', { url: urlMatch[0] });

      const host = req.headers.host || 'card-zip.vercel.app';
      const sent = await callWithRetry(`https://${host}/api/step1-elim`, { jobId: job.id });

      if (!sent) {
        await bot.telegram.editMessageText(
          msg.chat.id, progressMsg.message_id, undefined,
          '❌ Не удалось запустить обработку. Попробуй ещё раз.',
          { parse_mode: 'HTML' }
        ).catch(() => {});
        await supabase.from('jobs').update({ status: 'failed', error: 'step1_trigger_failed' }).eq('id', job.id);
      }
    } catch (e) {
      console.error('[webhook] URL pipeline error:', e);
    }
    return;
  }

  // ─── Всё остальное: callbacks, команды, текст, tariff input ────────────────
  // Отвечаем Telegram сразу, потом обрабатываем
  res.status(200).json({ ok: true });

  try {
    await bot.handleUpdate(req.body);
  } catch (e) {
    console.error('[webhook] handleUpdate error:', e);
  }
}

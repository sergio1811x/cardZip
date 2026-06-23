import type { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
import { bot } from '../src/bot';
import { getOrCreateUser } from '../src/db/queries/users';
import { createJob } from '../src/db/queries/jobs';
import { getStatus } from '../src/services/subscriptionService';
import { track } from '../src/services/analyticsService';
import { supabase } from '../src/db/supabase';

export const config = { maxDuration: 10 };
const processed = new Set<number>();

async function callWithRetry(url: string, body: object): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 4000);
      const res = await fetch(url, {
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
    return res.status(403).end();
  }

  const updateId = req.body?.update_id;
  if (updateId && processed.has(updateId)) return res.status(200).json({ ok: true });
  if (updateId) { processed.add(updateId); if (processed.size > 1000) processed.clear(); }

  try {
    const msg = req.body?.message;
    const cbq = req.body?.callback_query;

    // Callback queries и команды — через bot.handleUpdate
    if (cbq || !msg?.text || !msg.from?.id || !msg.chat?.id) {
      await bot.handleUpdate(req.body);
      return res.status(200).json({ ok: true });
    }

    const text = msg.text.trim();
    if (text.startsWith('/')) {
      await bot.handleUpdate(req.body);
      return res.status(200).json({ ok: true });
    }

    const urlMatch = text.match(/https?:\/\/[^\s]*(1688|taobao|tmall|qr\.1688)\.com[^\s]*/);
    if (!urlMatch) {
      await bot.telegram.sendMessage(msg.chat.id,
        'Пришлите ссылку на товар с 1688 или Taobao.\n\n<code>https://detail.1688.com/offer/XXX.html</code>',
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      );
      return res.status(200).json({ ok: true });
    }

    const dbUser = await getOrCreateUser(msg.from.id);
    const status = await getStatus(dbUser.id);
    if (!status.canGenerate) {
      await track(dbUser.id, 'upgrade_shown');
      await bot.telegram.sendMessage(msg.chat.id,
        `❌ <b>Бесплатные генерации исчерпаны</b>\n\n/upgrade для продолжения`,
        { parse_mode: 'HTML' }
      );
      return res.status(200).json({ ok: true });
    }

    const progressMsg = await bot.telegram.sendMessage(msg.chat.id,
      '🔄 Загружаем данные с площадки...', { parse_mode: 'HTML' }
    );

    const job = await createJob(dbUser.id, msg.chat.id, progressMsg.message_id, urlMatch[0]);
    await track(dbUser.id, 'sent_link', { url: urlMatch[0] });

    const host = req.headers.host || 'card-zip.vercel.app';
    const sent = await callWithRetry(`https://${host}/api/step1-elim`, { jobId: job.id });

    if (!sent) {
      console.error('[webhook] Failed to trigger step1');
      await bot.telegram.editMessageText(
        msg.chat.id, progressMsg.message_id, undefined,
        '❌ Не удалось запустить обработку. Попробуй ещё раз.',
        { parse_mode: 'HTML' }
      ).catch(() => {});
      await supabase.from('jobs').update({ status: 'failed', error: 'step1_trigger_failed' }).eq('id', job.id);
    }

  } catch (e) {
    console.error('[webhook]', e);
  }

  res.status(200).json({ ok: true });
}

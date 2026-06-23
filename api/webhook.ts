import type { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { getOrCreateUser } from '../src/db/queries/users';
import { createJob } from '../src/db/queries/jobs';
import { getStatus } from '../src/services/subscriptionService';
import { track } from '../src/services/analyticsService';

export const config = { maxDuration: 10 };

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
const processed = new Set<number>();

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
    if (!msg?.text || !msg.from?.id || !msg.chat?.id) {
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
      '📡 <b>Шаг 1/4</b> — Получаем данные с площадки...', { parse_mode: 'HTML' }
    );

    const job = await createJob(dbUser.id, msg.chat.id, progressMsg.message_id, urlMatch[0]);
    await track(dbUser.id, 'sent_link', { url: urlMatch[0] });

    // Вызываем step1 — не ждём ответа, но ждём что fetch отправлен
    const host = req.headers.host || 'card-zip.vercel.app';
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    await fetch(`https://${host}/api/step1-elim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: job.id }),
      signal: controller.signal,
    }).catch(() => {}); // abort после 500ms — запрос уже ушёл

  } catch (e) {
    console.error('[webhook]', e);
  }

  res.status(200).json({ ok: true });
}

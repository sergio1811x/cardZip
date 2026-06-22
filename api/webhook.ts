import type { VercelRequest, VercelResponse } from '@vercel/node';
import { bot } from '../src/bot';

export const config = { maxDuration: 60 };

const processed = new Set<number>();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).end();
  }

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret) {
    const incoming = req.headers['x-telegram-bot-api-secret-token'];
    if (incoming !== secret) {
      return res.status(403).end();
    }
  }

  // Дедупликация: Telegram может повторить запрос при таймауте
  const updateId = req.body?.update_id;
  if (updateId && processed.has(updateId)) {
    return res.status(200).json({ ok: true, duplicate: true });
  }
  if (updateId) {
    processed.add(updateId);
    // Чистим старые ID (serverless может переиспользовать инстанс)
    if (processed.size > 1000) processed.clear();
  }

  try {
    await bot.handleUpdate(req.body);
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[webhook] Error:', e);
    res.status(200).json({ ok: false });
  }
}

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { bot } from '../src/bot';

export const config = { maxDuration: 60 };

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

  try {
    await bot.handleUpdate(req.body);
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[webhook] Error:', e);
    res.status(200).json({ ok: false });
  }
}

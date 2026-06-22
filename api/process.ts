import type { VercelRequest, VercelResponse } from '@vercel/node';
import { bot } from '../src/bot';

export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  try {
    await bot.handleUpdate(req.body);
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[process] Error:', e);
    res.status(200).json({ ok: false });
  }
}

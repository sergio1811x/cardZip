import 'dotenv/config';
import { bot } from '../bot';

// Vercel serverless function
// Требует Vercel Pro: maxDuration: 60 (pipeline может занять 15-25 сек)
export const config = { maxDuration: 60 };

export default async function handler(
  req: { method: string; headers: Record<string, string | string[] | undefined>; json: () => Promise<unknown> },
  res: { status: (code: number) => { end: () => void; json: (data: unknown) => void } }
): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  // Проверка webhook secret от Telegram
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret) {
    const incoming = req.headers['x-telegram-bot-api-secret-token'];
    if (incoming !== secret) {
      res.status(403).end();
      return;
    }
  }

  try {
    const update = await req.json();
    await bot.handleUpdate(update as any);
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[webhook] Error:', e);
    // Возвращаем 200 чтобы Telegram не повторял запрос
    res.status(200).json({ ok: false });
  }
}

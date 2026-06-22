import 'dotenv/config';
import express from 'express';
import { bot } from './bot/index';

const PORT = parseInt(process.env.BOT_PORT || '3002');
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';

const app = express();
app.use(express.json());

app.post('/webhook', (req, res) => {
  const incoming = req.headers['x-telegram-bot-api-secret-token'];
  if (WEBHOOK_SECRET && incoming !== WEBHOOK_SECRET) {
    return res.status(403).end();
  }

  bot.handleUpdate(req.body)
    .then(() => res.json({ ok: true }))
    .catch((e) => {
      console.error('[webhook] Error:', e);
      res.json({ ok: false });
    });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.listen(PORT, () => {
  console.log(`🤖 CardZip bot webhook running on port ${PORT}`);
});

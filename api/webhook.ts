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
  if (updateId && processed.has(updateId)) {
    return res.status(200).json({ ok: true, duplicate: true });
  }
  if (updateId) {
    processed.add(updateId);
    if (processed.size > 1000) processed.clear();
  }

  try {
    const msg = req.body?.message;
    if (!msg?.text || !msg.from?.id || !msg.chat?.id) {
      // Обработка callback_query, команд и т.д. — через бота напрямую
      await bot.handleUpdate(req.body);
      return res.status(200).json({ ok: true });
    }

    const text = msg.text.trim();
    const tgId = msg.from.id;
    const chatId = msg.chat.id;

    // Команды обрабатываем напрямую (быстро)
    if (text.startsWith('/')) {
      await bot.handleUpdate(req.body);
      return res.status(200).json({ ok: true });
    }

    // Ищем ссылку на 1688/Taobao/Tmall
    const urlMatch = text.match(/https?:\/\/[^\s]*(1688|taobao|tmall|qr\.1688)\.com[^\s]*/);
    if (!urlMatch) {
      await bot.telegram.sendMessage(chatId,
        'Пришлите ссылку на товар с 1688 или Taobao.\n\nПримеры:\n<code>https://detail.1688.com/offer/XXX.html</code>\n<code>https://item.taobao.com/item.htm?id=XXX</code>',
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      );
      return res.status(200).json({ ok: true });
    }

    // Создаём/находим юзера
    const dbUser = await getOrCreateUser(tgId);

    // Проверяем лимиты
    const status = await getStatus(dbUser.id);
    if (!status.canGenerate) {
      await track(dbUser.id, 'upgrade_shown');
      await bot.telegram.sendMessage(chatId,
        `❌ <b>Бесплатные генерации исчерпаны</b>\n\nВы использовали все ${status.generationsLimit} бесплатных анализа.\n\nДля продолжения — подключите подписку /upgrade`,
        { parse_mode: 'HTML' }
      );
      return res.status(200).json({ ok: true });
    }

    // Отправляем прогресс
    const progressMsg = await bot.telegram.sendMessage(chatId,
      '📡 <b>Шаг 1/4</b> — Получаем данные с площадки...',
      { parse_mode: 'HTML' }
    );

    // Создаём job
    await createJob(dbUser.id, chatId, progressMsg.message_id, urlMatch[0]);
    await track(dbUser.id, 'sent_link', { url: urlMatch[0] });

    // Через 30 секунд дёрнем send-results (fire-and-forget)
    const host = req.headers.host || 'card-zip.vercel.app';
    setTimeout(() => {
      fetch(`https://${host}/api/send-results`).catch(() => {});
    }, 30_000);

    // Через 60 секунд ещё раз
    setTimeout(() => {
      fetch(`https://${host}/api/send-results`).catch(() => {});
    }, 60_000);

  } catch (e) {
    console.error('[webhook] Error:', e);
  }

  res.status(200).json({ ok: true });
}

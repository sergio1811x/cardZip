import type { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
import { bot } from '../src/bot';
import { getOrCreateUser } from '../src/db/queries/users';
import { createJob } from '../src/db/queries/jobs';
import { getStatus } from '../src/services/subscriptionService';
import { track } from '../src/services/analyticsService';
import { supabase } from '../src/db/supabase';
import { redis } from '../src/lib/redis';
import { checkLinkLimit, checkCallbackLimit, checkGlobalLimit } from '../src/bot/middleware/rateLimit';
import { cleanupStuckJobs } from '../src/lib/jobCleanup';
import { triggerPipelineStep } from '../src/lib/pipelineStep';

export const config = { maxDuration: 10 };

async function isDuplicate(updateId: number): Promise<boolean> {
  if (!redis) return false;
  const key = `dedup:${updateId}`;
  const result = await redis.set(key, '1', { nx: true, ex: 60 });
  return result === null;
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
    // Дедуп по message_id — предотвращает двойную обработку одного сообщения
    if (redis && msg.message_id) {
      const msgLock = await redis.set(`msg:${msg.chat.id}:${msg.message_id}`, '1', { nx: true, ex: 120 });
      if (msgLock === null) {
        console.log(`[webhook] Duplicate message ${msg.message_id} blocked`);
        return res.status(200).json({ ok: true });
      }
    }

    try {
      const dbUser = await getOrCreateUser(msg.from.id);

      // Чистим зависшие jobs (всегда, даже если processing lock истёк)
      await cleanupStuckJobs(dbUser.id, msg.chat.id, bot);

      // Проверяем: есть ли активный job у этого юзера
      if (redis) {
        const processing = await redis.get(`processing:${dbUser.id}`);
        if (processing) {
          await bot.telegram.sendMessage(msg.chat.id, '⏳ Предыдущий анализ ещё выполняется. Дождитесь результата.');
          return res.status(200).json({ ok: true });
        }
      }

      // Rate limit: 1 ссылка в 30с
      const linkRL = await checkLinkLimit(dbUser.id);
      if (!linkRL.allowed) {
        await bot.telegram.sendMessage(msg.chat.id, `⏳ Подождите ${linkRL.retryAfterSec ?? 30}с перед следующим разбором.`);
        return res.status(200).json({ ok: true });
      }

      const status = await getStatus(dbUser.id);
      if (!status.canGenerate) {
        await track(dbUser.id, 'upgrade_shown');
        const { Markup } = require('telegraf');
        await bot.telegram.sendMessage(msg.chat.id,
          '🔎 <b>Лимит разборов исчерпан</b>\n\nВыберите формат работы:',
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('10 анализов · 150 ⭐', 'pay_pack10')],
              [Markup.button.callback('30 анализов · 300 ⭐', 'pay_pack30')],
              [Markup.button.callback('7 дней Pro · 500 ⭐', 'pay_week')],
            ]),
          }
        );
        return res.status(200).json({ ok: true });
      }

      if (redis) {
        const urlKey = `job:${dbUser.id}:${urlMatch[0].slice(0, 80)}`;
        const dup = await redis.set(urlKey, '1', { nx: true, ex: 120 });
        if (dup === null) return res.status(200).json({ ok: true });
      }

      const progressMsg = await bot.telegram.sendMessage(msg.chat.id,
        '🔍 <b>Анализирую товар с 1688...</b>\n\nЧто делаю:\n1. Получаю данные товара\n2. Разбираю SKU и цену\n3. Определяю риски закупки\n4. Готовлю вопросы поставщику\n5. Формирую файлы для байера, карго и карточки\n\n⏱ Обычно 40–70 секунд', { parse_mode: 'HTML' }
      );

      const job = await createJob(dbUser.id, msg.chat.id, progressMsg.message_id, urlMatch[0]);
      if (redis) await redis.set(`processing:${dbUser.id}`, job.id, { ex: Number(process.env.PROCESSING_LOCK_TTL_SEC ?? 900) });
      await track(dbUser.id, 'sent_link', { url: urlMatch[0] });

      const started = await triggerPipelineStep(req, '/api/step1-elim', { jobId: job.id }, { logPrefix: 'webhook', timeoutMs: 8_000 });
      if (!started) {
        await supabase.from('jobs').update({
          status: 'failed',
          error: 'step1_trigger_failed',
          finished_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('id', job.id);
        if (redis) await redis.del(`processing:${dbUser.id}`).catch(() => null);
        await bot.telegram.editMessageText(
          msg.chat.id, progressMsg.message_id, undefined,
          '⚠️ Не удалось запустить анализ. Сервер не принял первый шаг пайплайна.',
          { parse_mode: 'HTML' }
        ).catch(() => null);
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

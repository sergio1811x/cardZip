import type { Context } from 'telegraf';
import type { Message } from 'telegraf/typings/core/types/typegram';
import { Markup } from 'telegraf';
import { createJob } from '../../db/queries/jobs';
import { getStatus } from '../../services/subscriptionService';
import { track } from '../../services/analyticsService';
import { supabase } from '../../db/supabase';
import { redis } from '../../lib/redis';

function resolveAppHost(ctx: Context): string {
  const fromEnv = process.env.PUBLIC_APP_HOST || process.env.VERCEL_URL;
  if (fromEnv) return fromEnv.startsWith('http') ? fromEnv : `https://${fromEnv}`;
  const webhookHost = (ctx as any).webhookReply?.host;
  if (webhookHost) return `https://${webhookHost}`;
  return 'https://card-zip.vercel.app';
}

async function callStep1(host: string, jobId: string): Promise<boolean> {
  const url = `${host.replace(/\/$/, '')}/api/step1-elim`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 4000);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId }),
        signal: ac.signal,
      });
      if (response.ok) return true;
    } catch {
      // retry below
    } finally {
      clearTimeout(timeout);
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export async function handleLink(ctx: Context, url: string): Promise<void> {
  const userId = (ctx as any).dbUserId as string | undefined;
  const chatId = ctx.chat?.id;
  if (!userId || !chatId) return;

  const status = await getStatus(userId);
  if (!status.canGenerate) {
    track(userId, 'upgrade_shown');
    await ctx.reply(
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
    return;
  }

  if (redis) {
    const processing = await redis.get(`processing:${userId}`).catch(() => null);
    if (processing) {
      await ctx.reply('⏳ Предыдущий анализ ещё выполняется. Дождитесь результата.');
      return;
    }
  }

  await track(userId, 'sent_link', { url });

  const progressMsg = await ctx.reply('⏳ Запрос принят, начинаю анализ...', { parse_mode: 'HTML' });
  const progressMsgId = (progressMsg as Message.TextMessage).message_id;

  try {
    const job = await createJob(userId, chatId, progressMsgId, url);
    if (redis) await redis.set(`processing:${userId}`, job.id, { ex: 75 }).catch(() => {});

    const started = await callStep1(resolveAppHost(ctx), job.id);
    if (!started) {
      await supabase.from('jobs').update({
        status: 'failed',
        error: 'step1_trigger_failed',
        finished_at: new Date().toISOString(),
      }).eq('id', job.id).eq('user_id', userId);
      if (redis) await redis.del(`processing:${userId}`).catch(() => {});
      await ctx.telegram.editMessageText(
        chatId,
        progressMsgId,
        undefined,
        '❌ Сервер перегружен. Попробуйте ещё раз через минуту.',
        { parse_mode: 'HTML' },
      ).catch(() => {});
    }
  } catch (e) {
    console.error('[handleLink]', e);
    if (redis) await redis.del(`processing:${userId}`).catch(() => {});
    await ctx.telegram.editMessageText(
      chatId,
      progressMsgId,
      undefined,
      '❌ Не удалось создать анализ. Попробуйте ещё раз.',
      { parse_mode: 'HTML' },
    ).catch(() => ctx.reply('❌ Не удалось создать анализ. Попробуйте ещё раз.'));
  }
}

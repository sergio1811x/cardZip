import type { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { supabase } from '../src/db/supabase';
import { productImporter } from '../src/providers/productImporter';
import { normalizeCnText } from '../src/core/cnNormalize';
import { createStepProgress } from '../src/core/progress';

export const config = { maxDuration: 60 };

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const { jobId } = req.body ?? {};
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  try {
    // Получаем job
    const { data: job } = await supabase.from('jobs').select('*').eq('id', jobId).single();
    if (!job || job.status !== 'pending') return res.status(200).json({ ok: true, skip: true });

    // Обновляем статус
    await supabase.from('jobs').update({ status: 'elim', started_at: new Date().toISOString() }).eq('id', jobId);

    // Прогресс с анимацией
    const progress = job.tg_message_id
      ? createStepProgress(bot, job.tg_chat_id, job.tg_message_id, 'elim')
      : null;

    // Elim API
    let rawProduct;
    try {
      rawProduct = await productImporter.fetchProduct(job.input_url);
    } finally {
      progress?.stop();
    }
    rawProduct.titleCn = normalizeCnText(rawProduct.titleCn);
    if (rawProduct.description) rawProduct.description = normalizeCnText(rawProduct.description);

    console.log(`[step1] Elim: ${rawProduct.titleCn?.slice(0, 30)} | imgs:${rawProduct.images.length}`);

    // Сохраняем rawProduct (без тяжёлых полей)
    await supabase.from('jobs').update({
      status: 'elim_done',
      result_json: {
        rawProduct: {
          productId: rawProduct.productId,
          platform: rawProduct.platform,
          titleCn: rawProduct.titleCn,
          titleEn: rawProduct.titleEn,
          description: rawProduct.description?.slice(0, 500),
          priceYuan: rawProduct.priceYuan,
          priceRange: rawProduct.priceRange?.slice(0, 3),
          moq: rawProduct.moq,
          weightKg: rawProduct.weightKg,
          mainImageUrl: rawProduct.mainImageUrl,
          supplierName: rawProduct.supplierName,
          supplierRating: rawProduct.supplierRating,
          supplierType: rawProduct.supplierType,
          sold: rawProduct.sold,
          stock: rawProduct.stock,
          categoryName: rawProduct.categoryName,
          attributes: rawProduct.attributes?.slice(0, 15),
        },
        imageUrls: rawProduct.images,
      },
    }).eq('id', jobId);

    // Вызываем step2 — 2 попытки с увеличенным таймаутом
    const host = req.headers.host || 'card-zip.vercel.app';
    let step2Sent = false;
    for (let i = 0; i < 2 && !step2Sent; i++) {
      try {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 4000);
        await fetch(`https://${host}/api/step2-ai`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId }),
          signal: ac.signal,
        });
        step2Sent = true;
      } catch {
        if (i === 0) await new Promise(r => setTimeout(r, 500));
      }
    }

    if (!step2Sent) {
      console.error(`[step1] Failed to trigger step2 for job ${jobId}`);
      await supabase.from('jobs').update({ status: 'failed', error: 'step2ai_trigger_failed', finished_at: new Date().toISOString() }).eq('id', jobId);
      if (job.tg_message_id) {
        await bot.telegram.editMessageText(
          job.tg_chat_id, job.tg_message_id, undefined,
          '❌ Сервер перегружен. Попробуйте ещё раз через минуту.',
          { parse_mode: 'HTML' }
        ).catch(() => {});
      }
    }

    res.status(200).json({ ok: true });
    return;
  } catch (e: any) {
    console.error('[step1]', e.message);
    await supabase.from('jobs').update({ status: 'failed', error: e.message, finished_at: new Date().toISOString() }).eq('id', jobId);

    // Сообщаем юзеру
    const { data: job } = await supabase.from('jobs').select('tg_chat_id, tg_message_id').eq('id', jobId).single();
    if (job) {
      if (job.tg_message_id) await bot.telegram.deleteMessage(job.tg_chat_id, job.tg_message_id).catch(() => {});
      await bot.telegram.sendMessage(job.tg_chat_id, `❌ ${e.userMessage || 'Не удалось получить данные товара. Попробуйте ещё раз.'}`).catch(() => {});
    }
    res.status(200).json({ ok: false });
  }
}

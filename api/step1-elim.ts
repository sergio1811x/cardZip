import type { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { supabase } from '../src/db/supabase';
import { productImporter } from '../src/providers/productImporter';
import { normalizeCnText } from '../src/core/cnNormalize';
import { createStepProgress } from '../src/core/progress';
import { triggerPipelineStep } from '../src/lib/pipelineStep';
import { acquireStepLock } from '../src/lib/stepLock';

export const config = { maxDuration: 60 };

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

function compactSkuButtonLabel(value: unknown, fallback: string): string {
  let label = String(value ?? '').replace(/\s+/g, ' ').trim() || fallback;

  // Generic UI cleanup only. Do not translate or normalize product terms here:
  // SKU meaning belongs to the LLM translator because the product can be anything.
  label = label
    .replace(/^[-–—:：\s]+/, '')
    .replace(/[。；;]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Put a model/article-like code first so Telegram does not cut it on narrow screens.
  // This is format preservation, not a product dictionary.
  const model = label.match(/\b(?:[A-ZА-Я]{1,6}[- ]?)?\d{2,}[A-ZА-Я0-9-]*\b/i)?.[0];
  if (model && !label.toLowerCase().startsWith(model.toLowerCase())) {
    const withoutModel = label
      .replace(model, '')
      .replace(/[·,;|/\-–—]+$/g, '')
      .replace(/^[-–—·,;|/\s]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    label = withoutModel ? `${model} · ${withoutModel}` : model;
  }

  const max = 42;
  if (label.length > max) label = `${label.slice(0, max - 1).trim()}…`;
  return label || fallback;
}


export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const { jobId } = req.body ?? {};
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  try {
    if (!await acquireStepLock('step1', jobId)) {
      console.log(`[step1] Duplicate blocked for job ${jobId}`);
      return res.status(200).json({ ok: true, skip: true });
    }

    const { data: job } = await supabase.from('jobs').select('*').eq('id', jobId).single();
    const allowedStatuses = ['pending', 'processing'];
    if (!job || !allowedStatuses.includes(job.status)) {
      console.log(`[step1] Skip: job ${jobId} status=${job?.status ?? 'NOT_FOUND'}`);
      return res.status(200).json({ ok: true, skip: true });
    }

    console.log(`[step1] Start: ${jobId} url=${job.input_url.slice(0, 60)}`);

    // Обновляем статус
    await supabase.from('jobs').update({ status: 'elim', started_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', jobId);

    // Прогресс с анимацией
    const progress = job.tg_message_id
      ? createStepProgress(bot, job.tg_chat_id, job.tg_message_id, 'elim')
      : null;

    // Elim/RapidAPI can legitimately take 60–120s on Railway. Keep a safety timeout,
    // but do not use the old Vercel 40s limit.
    let rawProduct;
    try {
      const safetyTimeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Elim/RapidAPI не ответил за отведённое время')), Number(process.env.ELIM_TIMEOUT_MS ?? 120_000))
      );
      rawProduct = await Promise.race([
        productImporter.fetchProduct(job.input_url),
        safetyTimeout,
      ]);
    } finally {
      progress?.stop();
    }
    rawProduct.titleCn = normalizeCnText(rawProduct.titleCn);
    if (rawProduct.description) rawProduct.description = normalizeCnText(rawProduct.description);

    console.log(`[step1] Elim: ${rawProduct.titleCn?.slice(0, 30)} | imgs:${rawProduct.images.length} | skus:${rawProduct.skus?.length ?? 0}`);

    const rawForJob = {
      productId: rawProduct.productId,
      platform: rawProduct.platform,
      titleCn: rawProduct.titleCn,
      titleEn: rawProduct.titleEn,
      description: rawProduct.description?.slice(0, 500),
      priceYuan: rawProduct.priceYuan,
      priceRange: rawProduct.priceRange?.slice(0, 5),
      priceIsRange: rawProduct.priceIsRange,
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
      skus: rawProduct.skus?.slice(0, 15),
      selectedSkuName: rawProduct.selectedSkuName,
      normalized1688: rawProduct.normalized1688,
    };

    // SKU выбор: 2+ SKU с разными ценами или вариантами
    const skus = rawProduct.skus ?? [];
    const uniquePrices = new Set(skus.filter(s => s.price).map(s => s.price));
    const needSkuChoice = skus.length >= 2;

    if (needSkuChoice && job.tg_message_id) {
      const { Markup } = require('telegraf');
      const buttons = skus.slice(0, 8).map((sku: any, i: number) => {
        // Убираем китайские символы из названия для кнопки
        const label = compactSkuButtonLabel(sku.name, `Вариант ${i + 1}`);
        const priceLabel = sku.price ? ` · ${sku.price} ¥` : '';
        return [Markup.button.callback(`${label}${priceLabel}`, `sku_${i}_${jobId}`)];
      });
      buttons.push([Markup.button.callback('📊 Все варианты', `sku_all_${jobId}`)]);

      await supabase.from('jobs').update({
        status: 'sku_pending',
        result_json: { rawProduct: rawForJob, imageUrls: rawProduct.images },
      }).eq('id', jobId);

      await bot.telegram.editMessageText(
        job.tg_chat_id, job.tg_message_id, undefined,
        'Выберите вариант для расчёта:',
        { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }
      ).catch(() => {});

      res.status(200).json({ ok: true });
      return;
    }

    // Без SKU выбора — продолжаем как раньше
    await supabase.from('jobs').update({
      status: 'elim_done',
      result_json: { rawProduct: rawForJob, imageUrls: rawProduct.images },
    }).eq('id', jobId);

    // Вызываем step2. Важно: проверяем HTTP status и используем правильный origin
    // (на VPS это может быть http://..., а не всегда https://host).
    const step2Sent = await triggerPipelineStep(req, '/api/step2-ai', { jobId }, { logPrefix: 'step1', timeoutMs: 8_000 });

    if (!step2Sent) {
      console.error(`[step1] Failed to trigger step2 for job ${jobId}`);
      await supabase.from('jobs').update({
        status: 'failed',
        error: 'step2ai_trigger_failed',
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', jobId);
      if (job.tg_message_id) {
        await bot.telegram.editMessageText(
          job.tg_chat_id, job.tg_message_id, undefined,
          '❌ Анализ остановился после чтения карточки: сервер не запустил AI-шаг. Попробуйте ещё раз через минуту.',
          { parse_mode: 'HTML' }
        ).catch(() => {});
      }
    }

    res.status(200).json({ ok: true });
    return;
  } catch (e: any) {
    console.error('[step1]', e.message);
    const { handleStepError } = require('../src/lib/stepError');
    await handleStepError(jobId, e.message, bot);
    res.status(200).json({ ok: false });
  }
}

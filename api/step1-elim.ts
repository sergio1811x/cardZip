import type { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { supabase } from '../src/db/supabase';
import { productImporter } from '../src/providers/productImporter';
import { normalizeCnText } from '../src/core/cnNormalize';
import { createStepProgress } from '../src/core/progress';
import { findProductByKey } from '../src/db/queries/products';
import { buildCacheKey } from '../src/lib/cache';
import { acquireStepLock } from '../src/lib/stepLock';

export const config = { maxDuration: 60 };

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

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

    // Elim API с safety timeout (Vercel лимит 60с, нужен запас на error handling)
    let rawProduct;
    try {
      const safetyTimeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Elim не ответил за 40 секунд')), 40_000)
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

    // Кэш отключён — всегда полный pipeline
    const cacheValid = false;
    if (cacheValid) {
      console.log(`[step1] Cache hit: ${cacheKey.slice(0, 12)}`);
      await supabase.from('jobs').update({
        status: 'done',
        result_json: {
          rawProduct: cachedProduct,
          imageUrls: rawProduct.images,
          product: cachedProduct,
        },
        finished_at: new Date().toISOString(),
      }).eq('id', jobId);

      // Сразу в step4-send
      const host = req.headers.host || 'card-zip.vercel.app';
      for (let i = 0; i < 2; i++) {
        try {
          const ac = new AbortController();
          setTimeout(() => ac.abort(), 4000);
          await fetch(`https://${host}/api/step4-send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId }),
            signal: ac.signal,
          });
          break;
        } catch { if (i === 0) await new Promise(r => setTimeout(r, 500)); }
      }
      res.status(200).json({ ok: true, cached: true });
      return;
    }

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
        let label = (sku.name ?? `Вариант ${i + 1}`).slice(0, 28);
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
    const { handleStepError } = require('../src/lib/stepError');
    await handleStepError(jobId, e.message, bot);
    res.status(200).json({ ok: false });
  }
}

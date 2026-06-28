import type { Context } from 'telegraf';
import { supabase } from '../../db/supabase';
import { redis } from '../../lib/redis';

function positiveNumber(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function handleSkuSelect(ctx: Context) {
  const userId = (ctx as any).dbUserId as string | undefined;
  if (!userId) {
    console.warn('[skuSelect] No dbUserId');
    return;
  }

  const match = (ctx as any).match as RegExpMatchArray | undefined;
  if (!match) {
    console.warn('[skuSelect] No match');
    return;
  }

  const skuIndex = match[1]; // number or 'all'
  const jobId = match[2];
  console.log(`[skuSelect] sku=${skuIndex} job=${jobId}`);

  try {
    const { data: job } = await supabase
      .from('jobs')
      .select('*')
      .eq('id', jobId)
      .eq('user_id', userId)
      .single();

    if (!job || job.status !== 'sku_pending') {
      await ctx.answerCbQuery('Товар уже обрабатывается');
      return;
    }

    const result = (job.result_json ?? {}) as any;
    const raw = result.rawProduct;
    if (!raw) {
      await ctx.answerCbQuery('Данные товара не найдены');
      return;
    }

    const skus = Array.isArray(raw.skus) ? raw.skus : [];

    if (skuIndex !== 'all') {
      const idx = Number.parseInt(skuIndex, 10);
      if (!Number.isInteger(idx) || idx < 0 || idx >= skus.length) {
        await ctx.answerCbQuery('Вариант не найден');
        return;
      }

      const selectedSku = skus[idx];
      const skuPrice = positiveNumber(selectedSku?.price);
      const skuName = String(selectedSku?.name ?? '').trim();

      if (skuPrice) raw.priceYuan = skuPrice;
      if (selectedSku?.image) raw.mainImageUrl = selectedSku.image;
      if (skuName) raw.selectedSkuName = skuName;

      if (raw.normalized1688?.pricing) {
        if (skuName) raw.normalized1688.pricing.selectedSkuName = skuName;
        raw.normalized1688.pricing.selectedSkuPriceYuan = skuPrice;
        if (skuPrice) raw.normalized1688.pricing.displayPriceYuan = skuPrice;
      }
    }

    await supabase.from('jobs').update({
      status: 'elim_done',
      result_json: { ...result, rawProduct: raw },
    }).eq('id', jobId).eq('user_id', userId);

    // Clear step locks so step2/step3/step4/step5 can re-run for this job.
    if (redis) {
      for (const step of ['step1', 'step2', 'step3', 'step4', 'step5']) {
        await redis.del(`lock:${step}:${jobId}`).catch(() => {});
      }
    }

    await ctx.answerCbQuery(skuIndex === 'all' ? 'Считаем по диапазону' : 'Вариант выбран');
    await ctx.editMessageText('🔄 Обрабатываем выбранный вариант...', { parse_mode: 'HTML' }).catch(() => {});

    const host = 'card-zip.vercel.app';
    const url = `https://${host}/api/step2-ai`;
    console.log(`[skuSelect] Triggering step2: ${url}`);
    let step2Sent = false;
    for (let i = 0; i < 2 && !step2Sent; i++) {
      try {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 4000);
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId }),
          signal: ac.signal,
        });
        console.log(`[skuSelect] step2 response: ${r.status}`);
        step2Sent = true;
      } catch (fetchErr) {
        console.warn(`[skuSelect] step2 attempt ${i + 1} failed: ${fetchErr instanceof Error ? fetchErr.message : fetchErr}`);
        if (i === 0) await new Promise(r => setTimeout(r, 500));
      }
    }
    if (!step2Sent) console.error(`[skuSelect] Failed to trigger step2 for job ${jobId}`);
  } catch (e) {
    console.error('[skuSelect]', e);
    await ctx.answerCbQuery('Ошибка').catch(() => {});
  }
}

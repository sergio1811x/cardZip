import type { Context } from 'telegraf';
import { supabase } from '../../db/supabase';
import { redis } from '../../lib/redis';

export async function handleSkuSelect(ctx: Context) {
  const match = (ctx as any).match as RegExpMatchArray | undefined;
  if (!match) return;

  const skuIndex = match[1]; // number or 'all'
  const jobId = match[2];

  try {
    const { data: job } = await supabase.from('jobs').select('*').eq('id', jobId).single();
    if (!job || job.status !== 'sku_pending') {
      await ctx.answerCbQuery('Товар уже обрабатывается');
      return;
    }

    const raw = (job.result_json as any).rawProduct;
    const skus = raw.skus ?? [];

    if (skuIndex !== 'all') {
      const idx = parseInt(skuIndex);
      const selectedSku = skus[idx];
      if (selectedSku) {
        // Обновляем цену и данные на выбранный SKU
        if (selectedSku.price) raw.priceYuan = selectedSku.price;
        if (selectedSku.image) raw.mainImageUrl = selectedSku.image;
        raw.selectedSkuName = selectedSku.name;
        if (raw.normalized1688?.pricing) {
          raw.normalized1688.pricing.selectedSkuName = selectedSku.name;
          raw.normalized1688.pricing.selectedSkuPriceYuan = selectedSku.price;
          if (selectedSku.price && selectedSku.price > 0) {
            raw.normalized1688.pricing.displayPriceYuan = selectedSku.price;
          }
        }
      }
    }
    // 'all' — считаем по медианной цене (уже так работает в productImporter)

    await supabase.from('jobs').update({
      status: 'elim_done',
      result_json: { ...(job.result_json as any), rawProduct: raw },
    }).eq('id', jobId);

    // Clear step locks so step2/step3/step4 can re-run for this job
    if (redis) {
      for (const step of ['step1', 'step2', 'step3', 'step4']) {
        await redis.del(`lock:${step}:${jobId}`).catch(() => {});
      }
    }

    await ctx.answerCbQuery(skuIndex === 'all' ? 'Считаем по диапазону' : `Выбран: ${skus[parseInt(skuIndex)]?.name?.slice(0, 20) ?? skuIndex}`);

    // Удаляем кнопки выбора
    await ctx.editMessageText('🔄 Обрабатываем выбранный вариант...', { parse_mode: 'HTML' }).catch(() => {});

    // Запускаем step2-ai
    const host = process.env.VERCEL_URL || 'card-zip.vercel.app';
    for (let i = 0; i < 2; i++) {
      try {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 4000);
        await fetch(`https://${host}/api/step2-ai`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId }),
          signal: ac.signal,
        });
        return;
      } catch {
        if (i === 0) await new Promise(r => setTimeout(r, 500));
      }
    }

    await ctx.editMessageText('❌ Не удалось запустить обработку. Попробуйте ещё раз.').catch(() => {});
  } catch (e) {
    console.error('[skuSelect]', e);
    await ctx.answerCbQuery('Ошибка').catch(() => {});
  }
}

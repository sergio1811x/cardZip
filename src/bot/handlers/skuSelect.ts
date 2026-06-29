import type { Context } from 'telegraf';
import { supabase } from '../../db/supabase';
import { redis } from '../../lib/redis';
import { triggerPipelineStep } from '../../lib/pipelineStep';
import { buildProgressText } from '../../core/progress';

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
      updated_at: new Date().toISOString(),
    }).eq('id', jobId);

    // Clear step locks so step2/step3/step4 can re-run for this job
    if (redis) {
      for (const step of ['step1', 'step2', 'step3', 'step4']) {
        await redis.del(`lock:${step}:${jobId}`).catch(() => {});
      }
    }

    await ctx.answerCbQuery(skuIndex === 'all' ? 'Считаем по диапазону' : `Выбран: ${skus[parseInt(skuIndex)]?.name?.slice(0, 20) ?? skuIndex}`);

    // Удаляем кнопки выбора и сразу возвращаем нормальный loader вместо вечного
    // “Обрабатываем выбранный вариант...”. Дальше step2 подхватит этот же tg_message_id
    // и будет двигать прогресс уже штатно.
    await ctx.editMessageText(
      buildProgressText(34, 'SKU выбран, запускаю AI-разбор выбранного варианта'),
      { parse_mode: 'HTML' }
    ).catch(() => {});

    // Continue on the current deployment. Do not hardcode Vercel: on Railway/VPS
    // the old URL made jobs stop at sku_pending after the user selected a SKU.
    const sent = await triggerPipelineStep(undefined, '/api/step2-ai', { jobId }, {
      logPrefix: 'skuSelect',
      detachedAckTimeoutMs: 2_000,
    });
    if (!sent) {
      await supabase.from('jobs').update({
        status: 'failed',
        error: 'sku_step2_trigger_failed',
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', jobId);
      await ctx.telegram.editMessageText(
        job.tg_chat_id,
        job.tg_message_id,
        undefined,
        '❌ Не удалось продолжить анализ после выбора SKU. Проверьте APP_URL/INTERNAL_APP_URL и повторите анализ.',
        { parse_mode: 'HTML' }
      ).catch(() => {});
      return;
    }

    // Watchdog: if detached self-call did not actually move the job out of elim_done,
    // the user must not be left with a frozen SKU message. Retry once, then fail loudly.
    setTimeout(async () => {
      const { data: fresh } = await supabase.from('jobs').select('status, error').eq('id', jobId).single();
      if (!fresh || fresh.status !== 'elim_done') return;

      console.warn(`[skuSelect] step2 did not start after SKU selection for job ${jobId}; retrying trigger`);
      await ctx.telegram.editMessageText(
        job.tg_chat_id,
        job.tg_message_id,
        undefined,
        buildProgressText(36, 'Не зависло: повторно запускаю AI-разбор выбранного SKU'),
        { parse_mode: 'HTML' }
      ).catch(() => {});

      const retried = await triggerPipelineStep(undefined, '/api/step2-ai', { jobId }, {
        logPrefix: 'skuSelect-watchdog',
        detachedAckTimeoutMs: 2_000,
      });
      if (!retried) {
        await supabase.from('jobs').update({
          status: 'failed',
          error: 'sku_step2_retry_failed',
          finished_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('id', jobId);
        await ctx.telegram.editMessageText(
          job.tg_chat_id,
          job.tg_message_id,
          undefined,
          '❌ Анализ остановился после выбора SKU: не удалось запустить следующий шаг. Кредит не списан.',
          { parse_mode: 'HTML' }
        ).catch(() => {});
      }
    }, 12_000);

    setTimeout(async () => {
      const { data: fresh } = await supabase.from('jobs').select('status, error').eq('id', jobId).single();
      if (!fresh || fresh.status !== 'elim_done') return;

      console.error(`[skuSelect] job still stuck at elim_done after SKU selection: ${jobId}`);
      await supabase.from('jobs').update({
        status: 'failed',
        error: 'sku_step2_not_started_timeout',
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', jobId);
      if (redis) await redis.del(`processing:${job.user_id}`).catch(() => {});
      await ctx.telegram.editMessageText(
        job.tg_chat_id,
        job.tg_message_id,
        undefined,
        '❌ Анализ остановился после выбора SKU: следующий шаг не стартовал. Кредит не списан. Проверьте APP_URL/INTERNAL_APP_URL на Railway.',
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }, 60_000);
  } catch (e) {
    console.error('[skuSelect]', e);
    await ctx.answerCbQuery('Ошибка').catch(() => {});
  }
}

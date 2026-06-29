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
      // Не валим анализ сразу. На Railway лучше оставить job в elim_done, показать честный
      // loader и дать watchdog повторно запустить step2. Раньше здесь появлялась ложная
      // ошибка “Проверьте APP_URL/INTERNAL_APP_URL”, хотя проблема была в HTTP self-call.
      console.warn(`[skuSelect] initial step2 trigger returned false for job ${jobId}; watchdog will retry`);
      await ctx.telegram.editMessageText(
        job.tg_chat_id,
        job.tg_message_id,
        undefined,
        buildProgressText(35, 'SKU выбран, повторно готовлю запуск AI-разбора'),
        { parse_mode: 'HTML' }
      ).catch(() => {});
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
        console.error(`[skuSelect] retry trigger also returned false for job ${jobId}; leaving job for final watchdog`);
        await ctx.telegram.editMessageText(
          job.tg_chat_id,
          job.tg_message_id,
          undefined,
          buildProgressText(37, 'Запуск AI-разбора задерживается, пробую ещё раз без сброса анализа'),
          { parse_mode: 'HTML' }
        ).catch(() => {});
      }
    }, 12_000);

    setTimeout(async () => {
      const { data: fresh } = await supabase.from('jobs').select('status, error').eq('id', jobId).single();
      if (!fresh || fresh.status !== 'elim_done') return;

      console.error(`[skuSelect] job still stuck at elim_done after SKU selection: ${jobId}`);
      // Последняя попытка перед fail: на Railway иногда callback успевает обновить UI,
      // но step2 не стартует из-за сетевого self-call. triggerPipelineStep теперь умеет
      // local in-process runner, поэтому эта попытка уже не зависит от APP_URL.
      const finalRetry = await triggerPipelineStep(undefined, '/api/step2-ai', { jobId }, {
        logPrefix: 'skuSelect-final-watchdog',
        detachedAckTimeoutMs: 2_000,
      });

      await ctx.telegram.editMessageText(
        job.tg_chat_id,
        job.tg_message_id,
        undefined,
        buildProgressText(38, finalRetry
          ? 'Запустил AI-разбор выбранного SKU ещё раз, продолжаю анализ'
          : 'AI-разбор выбранного SKU не стартовал, фиксирую понятную ошибку'),
        { parse_mode: 'HTML' }
      ).catch(() => {});

      if (finalRetry) return;

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
        '❌ Анализ остановился после выбора SKU: не удалось запустить AI-разбор даже локально. Кредит не списан. Посмотрите Railway logs по тегу skuSelect-final-watchdog.',
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }, 90_000);
  } catch (e) {
    console.error('[skuSelect]', e);
    await ctx.answerCbQuery('Ошибка').catch(() => {});
  }
}

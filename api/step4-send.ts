import type { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { supabase } from '../src/db/supabase';
import { getStatus, consumeCredit } from '../src/services/subscriptionService';
import { track } from '../src/services/analyticsService';
import { createStepProgress } from '../src/core/progress';
import { acquireStepLock, extendProcessingLock } from '../src/lib/stepLock';
import { runExpertWriter } from '../src/providers/expertWriter';
import { redis } from '../src/lib/redis';
import type { ProductWithContent, AnalysisSnapshot } from '../src/types';

export const config = { maxDuration: 60 };

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

function buildAnalysisSnapshot(product: ProductWithContent, jobUrl: string): AnalysisSnapshot {
  const ctx = (product as any).productContext ?? null;
  const wbf = product.wbFiltered;
  const eco = product.economics;
  const hasRealMedian = !!(wbf && wbf.relevantCount > 0 && wbf.medianPrice > 0 && !eco?.isSyntheticPrice);

  return {
    offerId: product.productId,
    sourceUrl: jobUrl,
    productContext: ctx,
    supplier: {
      name: product.supplierName ?? '',
      type: product.supplierType ?? 'unknown',
      rating: product.supplierRating ?? null,
      orders: product.sold ?? null,
      moq: product.moq > 1 ? product.moq : null,
    },
    purchasePrice: {
      valueCny: product.priceYuan > 0 ? product.priceYuan : null,
      displayLabel: product.priceYuan > 0 ? `${product.priceYuan} ¥` : 'не определена',
      source: product.normalized1688?.pricing?.quoteType ?? 'unknown',
      needsConfirmation: !!(product.normalized1688?.pricing?.quoteType === 'by_sku' && !product.skus?.length),
    },
    weight: {
      valueKg: product.weightKg > 0 ? product.weightKg : null,
      source: product.weightKg > 0 ? 'parsed' : 'unknown',
    },
    market: {
      confirmedCount: hasRealMedian ? wbf!.relevantCount : 0,
      medianPriceRub: hasRealMedian ? wbf!.medianPrice : null,
      marketConfirmed: hasRealMedian,
      wb429: !!(product as any).wb429,
    },
    economics: {
      status: !eco ? 'not_calculated'
        : !product.priceYuan ? 'not_calculated'
        : eco.weightMissing ? 'preliminary'
        : !hasRealMedian ? 'partial'
        : 'confirmed',
      costRub: eco?.costRub ?? null,
      roiPercent: eco?.roiPercent ?? null,
      canShowRoi: hasRealMedian && !eco?.weightMissing && !eco?.isSyntheticPrice,
      missing: [
        ...(!product.priceYuan ? ['цена'] : []),
        ...(eco?.weightMissing ? ['вес'] : []),
        ...(!hasRealMedian ? ['рынок WB'] : []),
      ],
    },
    missingData: ctx?.missingCritical ?? [],
    riskFlags: ctx?.riskTags ?? [],
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const { jobId } = req.body ?? {};
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  try {
    if (!await acquireStepLock('step4', jobId)) return res.status(200).json({ ok: true, skip: true });

    const { data: job } = await supabase.from('jobs').select('*').eq('id', jobId).single();
    if (!job || job.status !== 'done' || job.sent_to_telegram) return res.status(200).json({ ok: true, skip: true });

    await extendProcessingLock(job.user_id);

    const result = job.result_json as any;
    const product = result.product as ProductWithContent;

    const progress = job.tg_message_id
      ? createStepProgress(bot, job.tg_chat_id, job.tg_message_id, 'send')
      : null;

    // ─── Step 4A: Build AnalysisSnapshot ─────────────────────────────────
    const snapshot = buildAnalysisSnapshot(product, job.input_url);

    // ─── Step 4B: Expert Writer (LLM) ──────────────────────────────────
    const writerResult = await runExpertWriter(snapshot).catch(() => null);
    if (writerResult) {
      // Update seoContent from writer
      product.seoContent = {
        ...product.seoContent,
        titleRu: writerResult.seoTitle || product.seoContent?.titleRu,
        description: writerResult.seoDescription || product.seoContent?.description || '',
        bullets: writerResult.seoBullets?.length ? writerResult.seoBullets : product.seoContent?.bullets ?? [],
        keywords: writerResult.seoKeywords?.length ? writerResult.seoKeywords : product.seoContent?.keywords ?? [],
        characteristics: writerResult.seoCharacteristics ?? product.seoContent?.characteristics ?? {},
      };
    }

    // ─── Consume credit ──────────────────────────────────────────────────
    await track(job.user_id, 'generation_done', { url: job.input_url });
    await consumeCredit(job.user_id);
    const freshStatus = await getStatus(job.user_id);

    progress?.stop();
    if (job.tg_message_id) {
      await bot.telegram.deleteMessage(job.tg_chat_id, job.tg_message_id).catch(() => {});
    }

    // ─── Save snapshot + artifacts, chain to step5 ───────────────────────
    await supabase.from('jobs').update({
      result_json: {
        ...result,
        product: { ...product, seoContent: product.seoContent },
        analysisSnapshot: snapshot,
        writerResult,
        freshStatus: {
          creditsRemaining: freshStatus.creditsRemaining,
          plan: freshStatus.plan,
          isTrial: freshStatus.isTrial,
        },
      },
    }).eq('id', jobId);

    // Chain → step5-qa
    const host = req.headers.host || 'card-zip.vercel.app';
    for (let i = 0; i < 2; i++) {
      try {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 4000);
        await fetch(`https://${host}/api/step5-qa`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId }),
          signal: ac.signal,
        });
        break;
      } catch (e: any) {
        console.warn(`[step4] step5 chain attempt ${i + 1} failed: ${e.message}`);
        if (i === 0) await new Promise(r => setTimeout(r, 500));
      }
    }

    console.log(`[step4] Job ${jobId} snapshot built, chaining step5`);
    res.status(200).json({ ok: true });
  } catch (e: any) {
    console.error('[step4]', e.message);
    const { handleStepError } = require('../src/lib/stepError');
    await handleStepError(jobId, e.message, bot);
    res.status(200).json({ ok: false });
  }
}

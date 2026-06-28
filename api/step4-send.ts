import type { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { supabase } from '../src/db/supabase';
import { createStepProgress } from '../src/core/progress';
import { acquireStepLock, extendProcessingLock } from '../src/lib/stepLock';
import { runExpertWriter } from '../src/providers/expertWriter';
import { redis } from '../src/lib/redis';
import type { ProductWithContent } from '../src/types';
import { buildAnalysisSnapshot as buildCoreAnalysisSnapshot, type AnalysisSnapshot } from '../src/core/analysisSnapshot';

export const config = { maxDuration: 60 };

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

function buildAnalysisSnapshot(product: ProductWithContent, result: any, jobUrl: string): AnalysisSnapshot {
  const directAnalogs = ((product as any).marketEvidence?.directAnalogs ?? product.wbData?.allCards ?? [])
    .filter((card: any) => card && Number(card.price) > 0)
    .map((card: any) => ({
      title: String(card.title ?? card.name ?? '').trim(),
      priceRub: Number(card.price),
      matchLevel: 'direct' as const,
      confidence: Math.max(0, Math.min(100, Number(card.similarity ?? card.confidence ?? 0))),
    }))
    .filter((card: any) => card.title || card.priceRub > 0);

  const similarityData = (product as any).similarityData ?? {};
  const wbFiltered = product.wbFiltered as any;
  const economics = product.economics as any;
  const marketConfirmed = Boolean(
    wbFiltered?.relevantCount >= 3 &&
    wbFiltered?.medianPrice > 0 &&
    directAnalogs.length >= 3 &&
    !economics?.isSyntheticPrice
  );

  return buildCoreAnalysisSnapshot({
    offerId: product.productId,
    sourceUrl: jobUrl,
    raw1688: {
      ...((result?.rawProduct ?? {}) as Record<string, unknown>),
      ...product,
      attributesRaw: Object.fromEntries(((product as any).attributes ?? []).map((a: any) => [String(a.name ?? ''), a.value]).filter(([k]) => Boolean(k))),
      photosCount: Array.isArray(result?.imageUrls) ? result.imageUrls.length : 0,
    },
    productContext: (product as any).productContext ?? result?.productContext ?? null,
    supplier: {
      name: product.supplierName,
      type: product.supplierType,
      rating: product.supplierRating,
      orders: product.sold,
      moq: product.moq,
    },
    selectedSkuId: (product as any).selectedSkuId ?? null,
    market: {
      directAnalogsCount: marketConfirmed ? directAnalogs.length : 0,
      similarAnalogsCount: Number(similarityData.similarCount ?? 0),
      broadCategoryCount: Number(similarityData.categoryCount ?? 0),
      crossBorderCount: Number(similarityData.crossBorderCount ?? 0),
      marketConfirmed,
      displayedMainPriceRub: marketConfirmed ? wbFiltered.medianPrice : null,
      displayedMainPriceType: marketConfirmed ? 'median' : 'unknown',
      canUseForEconomics: marketConfirmed,
      rejectedReason: marketConfirmed ? undefined : 'Недостаточно прямых локальных аналогов WB 85%+ для экономики.',
      directAnalogs,
    },
    economics: {
      status: economics?.status,
      purchasePriceCny: product.priceYuan,
      costRub: economics?.costRub,
      sellPriceRub: marketConfirmed ? wbFiltered?.medianPrice : null,
      marginRub: marketConfirmed ? economics?.marginRub : null,
      roiPercent: marketConfirmed ? economics?.roiPercent : null,
      assumptions: economics?.assumptions ?? [],
      missing: [
        ...(!product.priceYuan || product.priceYuan <= 0 ? ['purchasePriceCny'] : []),
        ...(!product.weightKg || product.weightKg <= 0 ? ['packedWeightKg'] : []),
        ...(!marketConfirmed ? ['confirmedMarketPrice'] : []),
      ],
      canShowRoi: Boolean(marketConfirmed && economics?.roiPercent != null && !economics?.weightMissing && !economics?.isSyntheticPrice),
      canShowMargin: Boolean(marketConfirmed && economics?.marginRub != null && !economics?.weightMissing && !economics?.isSyntheticPrice),
    },
    missingData: [],
    riskFlags: (product as any).productContext?.riskTags ?? [],
  });
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
    const snapshot = buildAnalysisSnapshot(product, result, job.input_url);

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

    // Кредит списывается только в step5 после Hard Validator + QA Gate и перед отправкой.
    progress?.stop();
    // Progress message will be deleted by step5

    // ─── Save snapshot + artifacts, chain to step5 ───────────────────────
    await supabase.from('jobs').update({
      result_json: {
        ...result,
        product: { ...product, seoContent: product.seoContent },
        analysisSnapshot: snapshot,
        writerResult,
      },
    }).eq('id', jobId);

    // Chain → step5-qa
    const host = req.headers.host || 'card-zip.vercel.app';
    let step5Sent = false;
    for (let i = 0; i < 2 && !step5Sent; i++) {
      try {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 4000);
        const response = await fetch(`https://${host}/api/step5-qa`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId }),
          signal: ac.signal,
        });
        if (!response.ok) throw new Error(`step5 HTTP ${response.status}`);
        step5Sent = true;
      } catch (e: any) {
        console.warn(`[step4] step5 chain attempt ${i + 1} failed: ${e.message}`);
        if (i === 0) await new Promise(r => setTimeout(r, 500));
      }
    }

    if (!step5Sent) {
      const { handleStepError } = require('../src/lib/stepError');
      await handleStepError(jobId, 'step5_trigger_failed', bot);
    }

    console.log(`[step4] Job ${jobId} snapshot built, chaining step5=${step5Sent}`);
    res.status(200).json({ ok: true, step5Sent });
  } catch (e: any) {
    console.error('[step4]', e.message);
    const { handleStepError } = require('../src/lib/stepError');
    await handleStepError(jobId, e.message, bot);
    res.status(200).json({ ok: false });
  }
}

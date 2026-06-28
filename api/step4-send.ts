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
      ? createStepProgress(bot, job.tg_chat_id, job.tg_message_id, 'writer')
      : null;

    // ─── Build AnalysisSnapshot ─────────────────────────────────────────
    const snapshot = buildAnalysisSnapshot(product, result, job.input_url);

    // ─── Expert Writer (LLM, 20с per model) ─────────────────────────────
    const writerResult = await runExpertWriter(snapshot).catch(() => null);
    if (writerResult) {
      product.seoContent = {
        ...product.seoContent,
        titleRu: writerResult.seoTitle || product.seoContent?.titleRu,
        description: writerResult.seoDescription || product.seoContent?.description || '',
        bullets: writerResult.seoBullets?.length ? writerResult.seoBullets : product.seoContent?.bullets ?? [],
        keywords: writerResult.seoKeywords?.length ? writerResult.seoKeywords : product.seoContent?.keywords ?? [],
        characteristics: writerResult.seoCharacteristics ?? product.seoContent?.characteristics ?? {},
      };
    }

    progress?.stop();

    // ─── Save snapshot + writer result ──────────────────────────────────
    await supabase.from('jobs').update({
      status: 'qa_pending',
      result_json: {
        ...result,
        product: { ...product, seoContent: product.seoContent },
        analysisSnapshot: snapshot,
        writerResult,
      },
    }).eq('id', jobId);

    console.log(`[step4] Job ${jobId} writer done, snapshot saved, status=qa_pending`);
    res.status(200).json({ ok: true });
  } catch (e: any) {
    console.error('[step4]', e.message);
    const { handleStepError } = require('../src/lib/stepError');
    await handleStepError(jobId, e.message, bot);
    res.status(200).json({ ok: false });
  }
}

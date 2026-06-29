import type { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { supabase } from '../src/db/supabase';
import { getStatus } from '../src/services/subscriptionService';
import { track } from '../src/services/analyticsService';
import { createStepProgress } from '../src/core/progress';
import { acquireStepLock, extendProcessingLock } from '../src/lib/stepLock';
import { runExpertWriter } from '../src/providers/expertWriter';
import { buildDecisionContext } from '../src/core/decisionLayer';
import { redis } from '../src/lib/redis';
import type { ProductWithContent, AnalysisSnapshot } from '../src/types';

export const config = { maxDuration: 60 };

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

function positive(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').replace(',', '.').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

function buildAnalysisSnapshot(product: ProductWithContent & Record<string, any>, jobUrl: string): AnalysisSnapshot {
  const ctx = product.productContext ?? {};
  const intel = product.intelligence ?? product.productIntelligence ?? {};
  const decision = buildDecisionContext(product);
  const eco = product.economics ?? {};
  const directCount = decision.market.confirmedDirectCount;
  const similarCount = decision.market.similarLocalCount;
  const crossBorderCount = decision.market.crossBorderCount;
  const categoryOnlyCount = decision.market.categoryOnlyCount;
  const medianPrice = decision.market.canShowMedianPrice ? decision.market.medianPriceRub : null;
  const marketConfirmed = decision.market.canCalculateRoi && !!medianPrice;
  const purchasePriceCny = positive(decision.price.calculationPriceYuan);
  const weightKg = decision.weight.source === 'category_default' ? null : positive(decision.weight.weightKg);
  const skuCount = decision.sku.skuCount;

  return {
    offerId: product.productId ?? 'unknown_offer',
    sourceUrl: jobUrl,
    createdAt: new Date().toISOString(),
    raw1688: {
      titleCn: product.titleCn ?? '',
      attributesRaw: Object.fromEntries((product.attributes ?? []).map((a: any) => [a.name, a.value]).filter(([k]: any[]) => !!k)),
      skus: product.skus ?? product.normalized1688?.skuVariants ?? [],
      photosCount: Array.isArray(product.images) ? product.images.length : 0,
    },
    productContext: { ...ctx, productIntelligence: intel },
    supplier: {
      name: product.supplierName ?? '',
      type: product.supplierType ?? 'unknown',
      rating: product.supplierRating ?? '',
      orders: String(product.sold ?? ''),
      moq: {
        value: positive(product.moq),
        source: positive(product.moq) ? 'parsed' : 'unknown',
        displayLabel: positive(product.moq) ? `${Math.round(positive(product.moq)!)} шт.` : 'MOQ уточняется',
      },
    },
    purchasePrice: {
      valueCny: purchasePriceCny,
      minCny: purchasePriceCny,
      maxCny: purchasePriceCny,
      displayLabel: decision.price.displayPriceText,
      source: purchasePriceCny ? (decision.price.priceSource === 'sku' ? 'explicit_sku_price' : decision.price.priceSource === 'price_range' || decision.price.priceSource === 'fallback_min' ? 'price_range_min' : decision.price.priceSource === 'promotion' ? 'visible_1688_price' : 'visible_1688_price') : 'unknown',
      isSyntheticPrice: decision.price.isEstimated,
      needsSkuConfirmation: decision.price.needsSkuConfirmation,
    },
    weight: {
      valueKg: weightKg,
      packedWeightKg: weightKg,
      source: weightKg ? (decision.weight.source === 'manual' ? 'supplier_answer' : 'parsed') : 'unknown',
      displayLabel: weightKg ? `${weightKg} кг` : 'вес уточняется',
    },
    sku: {
      count: skuCount,
      selectedSkuId: null,
      needsSelection: decision.sku.needsSelection,
      variants: (product.skus ?? product.normalized1688?.skuVariants ?? []).slice(0, 20).map((s: any, i: number) => ({ id: String(s.id ?? s.name ?? i), label: String(s.name ?? s.label ?? `SKU ${i + 1}`), priceCny: positive(s.price ?? s.priceYuan) })),
    },
    market: {
      directAnalogsCount: directCount,
      similarAnalogsCount: similarCount,
      broadCategoryCount: categoryOnlyCount,
      crossBorderCount,
      marketConfirmed,
      displayedMainPriceRub: marketConfirmed ? medianPrice : null,
      displayedMainPriceType: marketConfirmed ? 'median' : 'unknown',
      canUseForEconomics: marketConfirmed,
      rejectedReason: marketConfirmed ? undefined : 'Для расчёта ROI нужно минимум 5 прямых локальных аналогов WB с уверенностью 85%+.',
      directAnalogs: (product.wbData?.allCards ?? []).slice(0, 10).map((c: any) => ({ title: c.title, priceRub: positive(c.price), matchLevel: 'direct', confidence: Number(c.similarity ?? c.matchConfidence ?? 85) || 85 })),
    },
    economics: {
      status: decision.economy.canShowRoi ? 'confirmed' : decision.economy.canShowCost ? 'partial' : 'not_calculated',
      purchasePriceCny,
      costRub: positive(decision.economy.costRub ?? eco.costRub),
      sellPriceRub: decision.economy.canShowRoi ? medianPrice : null,
      marginRub: decision.economy.canShowMargin ? positive(decision.economy.profitRub ?? eco.grossProfitRub) : null,
      roiPercent: decision.economy.canShowRoi ? positive(decision.economy.roiPercent ?? eco.roiPercent) : null,
      assumptions: decision.economy.warnings ?? [],
      missing: [
        ...(!purchasePriceCny ? ['цена выбранного SKU'] : []),
        ...(!weightKg ? ['вес с упаковкой'] : []),
        ...(!marketConfirmed ? ['5+ прямых локальных аналогов WB'] : []),
        ...(decision.price.needsSkuConfirmation ? ['выбранный SKU и цена'] : []),
      ],
      canShowRoi: decision.economy.canShowRoi,
      canShowMargin: decision.economy.canShowMargin,
      warning: decision.economy.canShowRoi ? undefined : 'Рыночная цена/SKU/вес не подтверждены. ROI и маржу считать нельзя.',
    },
    missingData: intel.dataQuality?.missingCriticalFields ?? ctx.missingCritical ?? [],
    conflicts: ctx.conflicts ?? [],
    riskFlags: intel.reportRules?.riskFlags ?? ctx.riskTags ?? [],
  } as AnalysisSnapshot;
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
    const product = { ...(result.product as ProductWithContent), intelligence: result.productIntelligence ?? result.intelligence ?? (result.product as any)?.intelligence } as ProductWithContent;

    const progress = job.tg_message_id
      ? createStepProgress(bot, job.tg_chat_id, job.tg_message_id, 'send')
      : null;

    // ─── Step 4A: Build AnalysisSnapshot ─────────────────────────────────
    const snapshot = buildAnalysisSnapshot(product, job.input_url);

    // ─── Step 4B: Optional Expert Writer (LLM) ──────────────────────────
    // The deterministic Decision Layer already builds the user report/files.
    // Keep the expensive writer opt-in: it should not spend tokens and then get
    // blocked by validators on every ordinary analysis.
    const writerMode = String(process.env.CARDZIP_EXPERT_WRITER_MODE ?? 'off').toLowerCase();
    const shouldRunWriter = writerMode === 'always' || (writerMode === 'confirmed_market' && snapshot.market.marketConfirmed);
    const writerResult = shouldRunWriter ? await runExpertWriter(snapshot).catch(() => null) : null;
    if (writerResult) {
      // Update seoContent from writer only with fields that validators can still repair.
      product.seoContent = {
        ...product.seoContent,
        titleRu: writerResult.seoTitle || product.seoContent?.titleRu,
        description: writerResult.seoDescription || product.seoContent?.description || '',
        bullets: writerResult.seoBullets?.length ? writerResult.seoBullets : product.seoContent?.bullets ?? [],
        keywords: writerResult.seoKeywords?.length ? writerResult.seoKeywords : product.seoContent?.keywords ?? [],
        characteristics: writerResult.seoCharacteristics ?? product.seoContent?.characteristics ?? {},
      };
    }

    // ─── Track generation. Credit is consumed only in step5 after validation/QA.
    await track(job.user_id, 'generation_done', { url: job.input_url });
    const freshStatus = await getStatus(job.user_id);

    progress?.stop();
    // Progress message will be deleted by step5

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

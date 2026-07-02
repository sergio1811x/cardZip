import type { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { supabase } from '../src/db/supabase';
import { getStatus } from '../src/services/subscriptionService';
import { track } from '../src/services/analyticsService';
import { createStepProgress } from '../src/core/progress';
import { triggerPipelineStep } from '../src/lib/pipelineStep';
import { acquireStepLock, extendProcessingLock } from '../src/lib/stepLock';
import { runExpertWriter } from '../src/providers/expertWriter';
import { runGapPlanner } from '../src/providers/gapPlanner';
import { buildDecisionContext } from '../src/core/decisionLayer';
import { ensureProductProcurementProfile } from '../src/core/procurementProfile';
import { buildAnalysisSnapshot as buildCoreAnalysisSnapshot, type AnalysisSnapshot } from '../src/core/analysisSnapshot';
import { buildQualityMetricsPayload } from '../src/core/qualityMetrics';
import { redis } from '../src/lib/redis';
import type { ProductWithContent } from '../src/types';

export const config = { maxDuration: 60 };

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

function positive(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').replace(',', '.').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

function buildAnalysisSnapshot(product: ProductWithContent & Record<string, any>, jobUrl: string): AnalysisSnapshot {
  const ctx: any = product.productContext ?? {};
  const intel = product.intelligence ?? product.productIntelligence ?? {};
  const profile = ensureProductProcurementProfile(product, { sourceUrl: jobUrl });
  const decision = buildDecisionContext(product);
  const purchasePriceCny = positive(decision.price.calculationPriceYuan);
  const weightKg = decision.weight.source === 'category_default' ? null : positive(decision.weight.weightKg);

  return buildCoreAnalysisSnapshot({
    offerId: product.productId ?? 'unknown_offer',
    sourceUrl: jobUrl,
    raw1688: {
      titleCn: product.titleCn ?? '',
      titleEn: product.titleEn ?? product.titleRu ?? '',
      description: product.description ?? '',
      price: purchasePriceCny ?? undefined,
      moq: product.moq,
      weightKg,
      mainImageUrl: product.mainImageUrl,
      images: product.images ?? [],
      sold: product.sold,
      stock: product.stock,
      categoryName: product.categoryName,
      attributes: product.attributes ?? [],
      attributesRaw: Object.fromEntries((product.attributes ?? []).map((a: any) => [a.name, a.value]).filter(([k]: any[]) => !!k)),
      skus: product.skus ?? product.normalized1688?.skuVariants ?? [],
      photosCount: Array.isArray(product.images) ? product.images.length : 0,
    },
    productContext: { ...ctx, productIntelligence: intel },
    supplier: {
      name: product.supplierName ?? '',
      type: profile.supplier.displayType,
      rating: product.supplierRating ?? '',
      orders: String(product.sold ?? ''),
      moq: product.moq,
    },
    selectedSkuId: null,
    market: {
      directAnalogsCount: 0,
      similarAnalogsCount: 0,
      broadCategoryCount: 0,
      crossBorderCount: 0,
      marketConfirmed: false,
      displayedMainPriceRub: null,
      displayedMainPriceType: 'unknown',
      canUseForEconomics: false,
      rejectedReason: 'Не используется в закупочном пакете.',
      directAnalogs: [],
    },
    economics: {
      status: decision.cost.status,
      purchasePriceCny,
      costRub: positive(decision.cost.totalCostRub ?? decision.cost.costWithoutCargoRub),
      sellPriceRub: null,
      marginRub: null,
      roiPercent: null,
      assumptions: decision.cost.warnings ?? [],
      missing: [
        ...(!purchasePriceCny ? ['цена выбранного SKU'] : []),
        ...(!weightKg ? ['вес с упаковкой'] : []),
        ...(decision.price.needsSkuConfirmation ? ['выбранный SKU и цена'] : []),
        'ответ поставщика по недостающим данным',
      ],
      canShowRoi: false,
      canShowMargin: false,
      warning: 'Себестоимость является предварительной и зависит от веса, упаковки и условий доставки.',
    },
    missingData: decision.readiness.missingData,
    riskFlags: intel.reportRules?.riskFlags ?? ctx.riskTags ?? [],
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
    const product = { ...(result.product as ProductWithContent), intelligence: result.productIntelligence ?? result.intelligence ?? (result.product as any)?.intelligence } as ProductWithContent;

    const progress = job.tg_message_id
      ? createStepProgress(bot, job.tg_chat_id, job.tg_message_id, 'send')
      : null;

    // ─── Step 4A: Build AnalysisSnapshot ─────────────────────────────────
    const snapshot = buildAnalysisSnapshot(product, job.input_url);

    // ─── Step 4B: Expert Writer (LLM) ───────────────────────────────────
    progress?.step('writer');
    // Runs by default for paid MVP, but uses compact prompt/input.
    // It enriches SEO/files; deterministic Decision Layer remains source of truth.
    const writerMode = String(process.env.CARDZIP_EXPERT_WRITER_MODE ?? 'off').toLowerCase();
    const shouldRunWriter = writerMode !== 'off' && writerMode === 'always';
    const writerResult = shouldRunWriter ? await runExpertWriter(snapshot).catch(() => null) : null;
    const gapPlannerMode = String(process.env.CARDZIP_GAP_PLANNER_MODE ?? 'if_missing').toLowerCase();
    const shouldRunGapPlanner = gapPlannerMode === 'always' || (gapPlannerMode === 'if_missing' && ((snapshot.factSheet?.missingRequired?.length ?? 0) > 0 || (snapshot.factSheet?.conflicts?.length ?? 0) > 0));
    const gapPlan = shouldRunGapPlanner ? await runGapPlanner(snapshot).catch(() => null) : null;
    const qualityMetrics = buildQualityMetricsPayload({
      jobId,
      offerId: snapshot.offerId,
      categoryType: snapshot.productContext?.identity?.categoryType,
      productKind: snapshot.productContext?.identity?.productType,
      metrics: [
        {
          stage: 'fact_sheet',
          status: (snapshot.factSheet?.summary?.blockingIssues?.length ?? 0) > 0 ? 'warn' : 'pass',
          issuesCount: snapshot.factSheet?.conflicts?.length ?? 0,
          warningsCount: snapshot.factSheet?.missingRequired?.length ?? 0,
        },
        {
          stage: 'writer',
          status: shouldRunWriter ? (writerResult ? 'pass' : 'warn') : 'pass',
          issuesCount: writerResult ? 0 : shouldRunWriter ? 1 : 0,
        },
        {
          stage: 'gap_planner',
          status: shouldRunGapPlanner ? (gapPlan ? 'pass' : 'warn') : 'pass',
          issuesCount: gapPlan?.missingFacts?.length ?? 0,
          warningsCount: gapPlan?.warnings?.length ?? 0,
        },
      ],
    });
    if (writerResult) {
      // Update seoContent from writer only with fields that validators can still repair.
      product.seoContent = {
        ...product.seoContent,
        titleRu: product.seoContent?.titleRu,
        description: writerResult.seoDescription || product.seoContent?.description || '',
        bullets: writerResult.seoBullets?.length ? writerResult.seoBullets : product.seoContent?.bullets ?? [],
        keywords: writerResult.seoKeywords?.length ? writerResult.seoKeywords : product.seoContent?.keywords ?? [],
        characteristics: writerResult.seoCharacteristics ?? product.seoContent?.characteristics ?? {},
      };
    }

    // ─── Track generation. Credit is consumed only in step5 after validation/QA.
    await track(job.user_id, 'generation_done', { url: job.input_url });
    const freshStatus = await getStatus(job.user_id);

    progress?.step('files');
    progress?.stop({ clear: false });
    // Progress message continues in step5 and will be deleted after final send

    // ─── Save snapshot + artifacts, chain to step5 ───────────────────────
    await supabase.from('jobs').update({
      result_json: {
        ...result,
        product: { ...product, seoContent: product.seoContent, productProcurementProfile: ensureProductProcurementProfile(product, { sourceUrl: job.input_url }), procurementProfile: ensureProductProcurementProfile(product, { sourceUrl: job.input_url }) },
        productProcurementProfile: ensureProductProcurementProfile(product, { sourceUrl: job.input_url }),
        procurementProfile: ensureProductProcurementProfile(product, { sourceUrl: job.input_url }),
        analysisSnapshot: snapshot,
        writerResult,
        gapPlan,
        qualityMetrics,
        freshStatus: {
          creditsRemaining: freshStatus.creditsRemaining,
          plan: freshStatus.plan,
          isTrial: freshStatus.isTrial,
        },
      },
    }).eq('id', jobId);

    // Chain → step5-qa
    const sent = await triggerPipelineStep(req, '/api/step5-qa', { jobId }, { logPrefix: 'step4', timeoutMs: 8_000 });
    if (!sent) {
      const { handleStepError } = require('../src/lib/stepError');
      await handleStepError(jobId, 'step5_trigger_failed', bot);
    }

    console.log(`[step4] Job ${jobId} snapshot built, chaining step5 sent=${sent}`);
    res.status(200).json({ ok: true });
  } catch (e: any) {
    console.error('[step4]', e.message);
    const { handleStepError } = require('../src/lib/stepError');
    await handleStepError(jobId, e.message, bot);
    res.status(200).json({ ok: false });
  }
}

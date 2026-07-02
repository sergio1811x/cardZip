import type { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { supabase } from '../src/db/supabase';
import { canonicalizeProduct } from '../src/providers/productCanonicalizer';
import { createStepProgress } from '../src/core/progress';
import { cleanChineseTitle } from '../src/core/cnNormalize';
import { buildProductProcurementProfile, preprocessMainImageForProductIntelligence, validateProfile } from '../src/core/procurementProfile';
import { triggerPipelineStep } from '../src/lib/pipelineStep';
import { acquireStepLock, extendProcessingLock } from '../src/lib/stepLock';

export const config = { maxDuration: 60 };

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

function toProductIntelligence(raw: any, productContext: any) {
  const ctx = productContext ?? {};
  const identity = ctx.identity ?? {};
  const titles = ctx.titles ?? {};
  const wbSearch = ctx.wbSearch ?? {};
  const seoPolicy = ctx.seoPolicy ?? {};
  const missing = ctx.missingCritical ?? [];
  const cleanCn = cleanChineseTitle(raw?.titleCn ?? titles.titleCn ?? '');
  const titleRu = titles.cleanRu || raw?.titleEn || cleanCn || raw?.titleCn || 'Товар 1688';
  return {
    productIdentity: {
      marketNameRu: titleRu,
      shortNameRu: titles.shortRu || titleRu,
      productKind: identity.productType || titleRu,
      categoryType: identity.categoryType || 'other',
      subCategoryType: '',
      categoryPath: [identity.categoryType || 'other'].filter(Boolean),
      coreObject: identity.coreObject || identity.productType || titleRu,
      formFactor: '',
      audience: identity.audience || 'неизвестно',
      gender: identity.gender || 'неизвестно',
      season: identity.season || 'неизвестно',
      useCases: identity.useCases || [],
      materials: Object.entries(ctx.facts ?? {}).filter(([k]) => /материал/i.test(k)).map(([, v]) => String(v)),
      powerType: Object.entries(ctx.facts ?? {}).filter(([k]) => /питание|аккумулятор|батар/i.test(k)).map(([, v]) => String(v)),
      visibleFeatures: [],
      importantFeatures: Object.values(ctx.facts ?? {}).map(String).slice(0, 8),
      notConfirmedFeatures: [],
      possibleConfusions: identity.notThis || [],
    },
    cleanTitles: {
      titleCnClean: cleanCn,
      titleRuClean: titleRu,
      titleForReport: titles.shortRu || titleRu,
      titleForWb: titles.wbTitleDraft || titleRu,
    },
    wbSearch: {
      wbCoreQuery: wbSearch.coreQuery || titleRu,
      queryCandidates: wbSearch.queryLadder || [wbSearch.coreQuery || titleRu].filter(Boolean),
      negativeSearchTerms: wbSearch.mustExclude || [],
      tooBroadQueries: [],
      tooNarrowQueries: [],
    },
    matchingRules: {
      mustHaveForDirectAnalog: wbSearch.directMatchRules || wbSearch.mustInclude || [],
      allowedDifferences: ['цвет как SKU', 'размер как SKU'],
      directAnalogBlockers: wbSearch.rejectRules || [],
      similarOnlyIf: [],
      rejectIf: wbSearch.mustExclude || [],
    },
    reportRules: {
      buyerMustCheck: missing,
      buyerMustNotAsk: [],
      seoAllowedClaims: seoPolicy.allowedClaims || [],
      seoForbiddenClaims: seoPolicy.forbiddenClaims || ['сертифицированный', 'безопасный', 'лечебный', 'премиальный', 'водонепроницаемый', 'IP67', 'для детей'],
      importantAttributesToShow: Object.keys(ctx.facts ?? {}),
      attributesToHide: [],
      riskFlags: ctx.riskTags || [],
    },
    supplierQuestions: ctx.supplierQuestions || { ru: [], cn: [] },
    dataQuality: {
      missingCriticalFields: missing,
      skuRisk: ctx.sku?.needsSelection ? 'SKU нужно выбрать' : '',
      priceRisk: ctx.price?.needsConfirmation ? 'цену SKU/партии нужно подтвердить' : '',
      weightRisk: raw?.weightKg > 0 ? '' : 'нужен вес с упаковкой',
      marketRisk: 'рынок проверяется вручную; WB/Ozon не блокирует закупочный пакет',
      visionConfidence: 'medium',
      textConfidence: 'medium',
      overallConfidence: ctx.dataQuality?.status === 'reliable' ? 'high' : 'medium',
      reason: ctx.dataQuality?.explanation || 'Product Intelligence собран из ProductContext и raw данных.',
    },
  };
}


export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const { jobId } = req.body ?? {};
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  try {
    console.log(`[step2] Start: ${jobId}`);
    const { data: job, error: jobErr } = await supabase.from('jobs').select('*').eq('id', jobId).single();
    if (jobErr) console.error('[step2] supabase error', jobErr.message);
    if (!job || job.status !== 'elim_done') {
      console.warn(`[step2] Skip: job=${!!job} status=${job?.status}`);
      return res.status(200).json({ ok: true, skip: true });
    }
    if (!await acquireStepLock('step2', jobId)) {
      console.warn(`[step2] Skip: lock already held`);
      return res.status(200).json({ ok: true, skip: true });
    }
    await extendProcessingLock(job.user_id);

    await supabase.from('jobs').update({ status: 'ai_processing', updated_at: new Date().toISOString() }).eq('id', jobId);

    const raw = (job.result_json as any).rawProduct;

    const progress = job.tg_message_id
      ? createStepProgress(bot, job.tg_chat_id, job.tg_message_id, 'ai')
      : null;

    // Main image preprocessing: pass only main photo metadata to Product Intelligence.
    // Price, MOQ, weight and SKU are still taken only from provider/API fields.
    const mainImageForProductIntelligence = preprocessMainImageForProductIntelligence(raw);

    // Single product-intelligence call: Product Canonicalizer with image-aware input.
    const productContext = await canonicalizeProduct({
      offerId: raw.productId,
      titleCn: raw.titleCn,
      titleRu: raw.titleEn,
      titleEn: raw.titleEn,
      categoryName: raw.categoryName,
      attributes: raw.attributes ?? raw.normalized1688?.attributes,
      skus: raw.skus ?? raw.normalized1688?.skuVariants,
      normalizedSkuTable: (raw.normalized1688?.skuVariants ?? raw.skus ?? []).map((s: any, i: number) => ({
        id: String(s.skuId ?? s.id ?? i),
        label: String(s.name ?? s.label ?? s.skuName ?? `SKU ${i + 1}`),
        priceYuan: Number(s.priceYuan ?? s.price ?? s.discountPrice ?? 0) || undefined,
        stock: typeof s.stock === 'number' ? s.stock : undefined,
        image: s.image ?? s.imageUrl,
      })),
      selectedSkuId: raw.selectedSkuId ?? raw.normalized1688?.pricing?.selectedSkuId,
      selectedSkuName: raw.selectedSkuName ?? raw.normalized1688?.pricing?.selectedSkuName,
      selectedSkuPriceYuan: raw.selectedSkuPriceYuan ?? raw.normalized1688?.pricing?.selectedSkuPriceYuan,
      selectedSkuImage: raw.selectedSkuImage ?? raw.normalized1688?.pricing?.selectedSkuImage,
      moq: raw.moq ?? raw.normalized1688?.moq,
      supplierName: raw.supplierName,
      supplierType: raw.supplierType ?? raw.normalized1688?.supplierType,
      supplierRating: raw.supplierRating,
      orders: raw.sold ?? raw.normalized1688?.salesCount ?? raw.normalized1688?.soldCountText,
      price: raw.priceYuan,
      priceRange: raw.priceRange,
      weightKg: raw.weightKg,
      mainImageUrl: mainImageForProductIntelligence.url ?? raw.mainImageUrl,
      imageUrls: mainImageForProductIntelligence.images,
      sold: raw.sold,
      stock: raw.stock,
    }).catch(() => null);

    const productIntelligence = toProductIntelligence(raw, productContext);
    const productProcurementProfile = buildProductProcurementProfile({ ...raw, intelligence: productIntelligence, productContext, sourceUrl: job.input_url }, { sourceUrl: job.input_url, intelligence: productIntelligence });
    const profileValidation = validateProfile(productProcurementProfile);
    if (!profileValidation.ok) console.warn('[step2-ai] profile validator:', profileValidation.errors.join('; '));

    // Backward-compatible fields from productContext
    const wbCoreQuery = productContext?.wbSearch?.coreQuery ?? '';
    const categoryType = productContext?.identity?.categoryType ?? 'other';
    const validatedQueries = productContext?.wbSearch?.queryLadder ?? [];

    // Temporary SEO (will be regenerated in step4 with market data)
    const seoContent = {
      titleRu: productContext?.titles?.cleanRu ?? raw.titleEn ?? raw.titleCn,
      description: '',
      bullets: [] as string[],
      keywords: productContext?.wbSearch?.queryLadder ?? [],
      characteristics: productContext?.facts ?? {},
    };

    progress?.stop();

    console.log(`[step2-ai] ${seoContent.titleRu?.slice(0, 40)} | cat: ${categoryType} | wbCore: ${wbCoreQuery}`);

    const { error: updateErr } = await supabase.from('jobs').update({
      status: 'ai_done',
      result_json: {
        ...(job.result_json as any),
        seoContent,
        productContext,
        productIntelligence,
        intelligence: productIntelligence,
        productProcurementProfile: profileValidation.fixedProfile,
        procurementProfile: profileValidation.fixedProfile,
        mainImageForProductIntelligence,
        wbCoreQuery,
        categoryType,
        validatedQueries,
        // backward compat for step3
        productStructure: productContext ? {
          coreObject: productContext.identity.coreObject,
          productType: productContext.identity.productType,
          material: Object.entries(productContext.facts).filter(([k]) => k.includes('материал')).map(([,v]) => v),
          hardConflicts: productContext.conflicts.filter(c => c.severity === 'high').map(c => c.field),
          softConflicts: productContext.conflicts.filter(c => c.severity !== 'high').map(c => c.field),
          directAnalogBlockers: productContext.wbSearch.rejectRules,
          marketSynonyms: productContext.wbSearch.queryLadder,
          mustKeep: productContext.wbSearch.mustInclude,
          doNotSearch: productContext.wbSearch.mustExclude,
          audience: productContext.identity.audience,
        } : null,
        queryPlan: productContext ? {
          L1_exact: productContext.wbSearch.queryLadder.slice(0, 2),
          L2_commercial: productContext.wbSearch.queryLadder.slice(2, 4),
          L3_subtype: [],
          L4_core: [productContext.identity.coreObject],
          L5_category: [],
        } : null,
        productLexicon: productContext ? {
          mainTerms: [productContext.identity.coreObject],
          hardNegativeTerms: productContext.wbSearch.mustExclude,
        } : null,
      },
    }).eq('id', jobId);
    if (updateErr) console.error('[step2] Supabase update ai_done failed:', updateErr.message);
    else console.log('[step2] Status set to ai_done');

    // Chain → step3-package (legacy endpoint name step3-market)
    const sent = await triggerPipelineStep(req, '/api/step3-market', { jobId }, { logPrefix: 'step2', timeoutMs: 8_000 });

    if (!sent) {
      const { handleStepError } = require('../src/lib/stepError');
      await handleStepError(jobId, 'step3_trigger_failed', bot);
    }

    res.status(200).json({ ok: true });
  } catch (e: any) {
    console.error('[step2-ai]', e.message);
    const { handleStepError } = require('../src/lib/stepError');
    await handleStepError(jobId, e.message, bot);
    res.status(200).json({ ok: false });
  }
}

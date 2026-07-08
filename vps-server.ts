import 'dotenv/config';
import express from 'express';
import { bot } from './src/bot';
import { supabase } from './src/db/supabase';
import { redis } from './src/lib/redis';
import { productImporter } from './src/providers/productImporter';
import { normalizeCnText } from './src/core/cnNormalize';
import { canonicalizeProduct } from './src/providers/productCanonicalizer';
import { generateSupplierQuestions, type GeneratorInput } from './src/providers/supplierQuestionsGenerator';
import { generateSeoCard } from './src/providers/seoCardGenerator';
import { generateCargoBrief } from './src/providers/cargoBriefGenerator';
import { buildProductProcurementProfile, buildCargoBriefFromProfile, buildSampleChecklistFromProfile } from './src/core/procurementProfile';
import { writeDocument, writeSeoProse, type DocWriterInput } from './src/providers/documentWriter';
import { translateQuestionsToCn } from './src/core/cnTranslate';
import { rankCandidates } from './src/core/wbSimilarity';
import { filterWbData } from './src/core/wbFilter';
import { calcEconomics, calcBudgetScenarios, calcMaxPurchasePrice } from './src/core/economicsCalc';
import { buildConclusion } from './src/core/verdict';
import { buildRiskFlags } from './src/core/riskFlags';
import { getUserTariffs } from './src/db/queries/userSettings';
import { buildCandidatePool, selectTopQueries } from './src/core/querySelector';
import { judgeCandidateBatch, repairSearch } from './src/providers/productUnderstanding';
import { fetchWbTrends, filterRelevantTrends, type WbTrend } from './src/providers/wbconTrends';
import { runExpertWriter } from './src/providers/expertWriter';
import { runQaGate } from './src/providers/expertQaGate';
import { runAutoFix } from './src/providers/autoFix';
import { buildMainMessage, buildSafeSummary } from './src/core/messageBuilder';
import { validateReport, runHardValidator } from './src/core/reportValidator';
import { validateGeneratedText, buildDecisionContext } from './src/core/decisionLayer';
import { formatSeoText } from './src/core/seoFormatter';
import { formatOrderBrief } from './src/core/orderBrief';
import { buildAnalysisSnapshot as buildCoreAnalysisSnapshot } from './src/core/analysisSnapshot';
import { createStepProgress } from './src/core/progress';
import { getOrCreateUser } from './src/db/queries/users';
import { createJob, markSent } from './src/db/queries/jobs';
import { getStatus, tryConsumeCredit } from './src/services/subscriptionService';
import { track } from './src/services/analyticsService';
import { upsertProduct } from './src/db/queries/products';
import { buildCacheKey } from './src/lib/cache';
import { findWbCategoriesByKeywords } from './src/db/queries/wbCategories';
import { checkLinkLimit } from './src/bot/middleware/rateLimit';
import { cleanupStuckJobs } from './src/lib/jobCleanup';
import { Markup } from 'telegraf';
import type { WbCard, WbSearchResult, ProductWithContent } from './src/types';

const app = express();
app.use(express.json());

const WB_PARSER_URL = process.env.WB_PARSER_URL || '';
const WB_PARSER_SECRET = process.env.WB_PARSER_SECRET || '';
const MAX_WB_QUERIES = 3;

// ─── WB Search ──────────────────────────────────────────────────────────────

function parseCards(products: any[]): WbCard[] {
  return products.map((p: any) => {
    const time1 = p.time1 ?? null;
    const brand = (p.brand || '').toLowerCase();
    const isCrossBorder = (time1 !== null && time1 > 5) || /aliexpress|ali express/i.test(brand);
    const marketType = isCrossBorder ? 'crossborder_market' as const
      : time1 !== null && time1 <= 5 ? 'local_wb_market' as const
      : 'unknown_market' as const;
    return {
      title: p.name || '', price: p.price,
      url: `https://www.wildberries.ru/catalog/${p.id}/detail.aspx`,
      rating: p.rating || 0, feedbacks: p.feedbacks || 0,
      wh: p.wh, time1, time2: p.time2, dist: p.dist,
      seller: p.seller || '', supplierId: p.supplierId,
      brand: p.brand || '', marketType,
    };
  }).filter((c: WbCard) => c.price > 0);
}

async function searchWb(queries: string[]): Promise<{ cards: WbCard[]; seenUrls: Set<string>; is429?: boolean }> {
  const seenUrls = new Set<string>();
  const cards: WbCard[] = [];
  if (!WB_PARSER_URL || !WB_PARSER_SECRET) return { cards, seenUrls };
  try {
    const res = await fetch(`${WB_PARSER_URL}/search-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: WB_PARSER_SECRET, queries, limit: 100 }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      if (res.status === 429) return { cards, seenUrls, is429: true };
      return { cards, seenUrls };
    }
    const data = await res.json() as any;
    for (const result of data.results ?? []) {
      for (const card of parseCards(result.products ?? [])) {
        if (!seenUrls.has(card.url)) { seenUrls.add(card.url); cards.push(card); }
      }
    }
  } catch (e: any) {
    console.warn('[pipeline] WB search failed:', e.message);
  }
  return { cards, seenUrls };
}

// ─── Analysis Snapshot builder ──────────────────────────────────────────────

function buildAnalysisSnapshot(product: ProductWithContent, result: any, jobUrl: string) {
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
    wbFiltered?.relevantCount >= 3 && wbFiltered?.medianPrice > 0 &&
    directAnalogs.length >= 3 && !economics?.isSyntheticPrice
  );

  return buildCoreAnalysisSnapshot({
    offerId: product.productId, sourceUrl: jobUrl,
    raw1688: {
      ...((result?.rawProduct ?? {}) as Record<string, unknown>), ...product,
      attributesRaw: Object.fromEntries(((product as any).attributes ?? []).map((a: any) => [String(a.name ?? ''), a.value]).filter(([k]: any) => Boolean(k))),
      photosCount: Array.isArray(result?.imageUrls) ? result.imageUrls.length : 0,
    },
    productContext: (product as any).productContext ?? result?.productContext ?? null,
    supplier: { name: product.supplierName, type: product.supplierType, rating: product.supplierRating, orders: product.sold, moq: product.moq },
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
      status: economics?.status, purchasePriceCny: product.priceYuan,
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

// ─── Pipeline: продолжение после SKU или с нуля (step2-6) ───────────────────

export async function continuePipeline(jobId: string) {
  const { data: job } = await supabase.from('jobs').select('*').eq('id', jobId).single();
  if (!job) return;

  const chatId = job.tg_chat_id;
  const messageId = job.tg_message_id;
  const progress = messageId ? createStepProgress(bot, chatId, messageId, 'ai') : null;

  try {
    const resultJson = job.result_json as any;
    const raw = resultJson.rawProduct;
    const imageUrls = resultJson.imageUrls ?? [];

    // ─── STEP 2: AI Canonicalizer ───────────────────────────────────────
    const productContext = await canonicalizeProduct({
      offerId: raw.productId, titleCn: raw.titleCn, titleRu: raw.titleEn, titleEn: raw.titleEn,
      categoryName: raw.categoryName, attributes: raw.attributes, skus: raw.skus,
      price: raw.priceYuan, priceRange: raw.priceRange, weightKg: raw.weightKg,
      mainImageUrl: raw.mainImageUrl, sold: raw.sold, stock: raw.stock,
    }).catch(() => null);

    // ─── Focused, independently-failing LLM document generators ─────────
    // Populate the product-specific procurement content (supplier questions,
    // SEO, cargo) via small resilient generators. Each returns null on failure;
    // whatever succeeds is merged into procurementProfileDraft.domainRules — the
    // exact path the profile builders (buildSupplierQuestionsFromProfile /
    // buildSeoDraftFromProfile / buildCargoBriefFromProfile) consume as PRIMARY.
    if (productContext) {
      try {
        const genInput: GeneratorInput = {
          titleRu: productContext.titles?.cleanRu || raw.titleEn || undefined,
          titleCn: raw.titleCn || undefined,
          priceYuan: Number.isFinite(raw.priceYuan) && raw.priceYuan > 0 ? raw.priceYuan : null,
          attributes: Array.isArray(raw.attributes) ? raw.attributes.slice(0, 30) : [],
          skuNames: Array.isArray(raw.skus) ? raw.skus.map((s: any) => String(s?.name ?? s?.raw ?? '').trim()).filter(Boolean).slice(0, 30) : [],
          coreObject: productContext.identity?.coreObject || undefined,
          categoryType: productContext.identity?.categoryType || raw.categoryName || undefined,
          useCases: Array.isArray(productContext.identity?.useCases) ? productContext.identity.useCases.map(String) : [],
          materials: Object.entries(productContext.facts ?? {}).filter(([k]) => k.includes('материал')).map(([, v]) => String(v)),
        };
        const [genQ, genSeo, genCargo] = await Promise.all([
          generateSupplierQuestions(genInput).catch(() => null),
          generateSeoCard(genInput).catch(() => null),
          generateCargoBrief(genInput).catch(() => null),
        ]);
        const draft: any = ((productContext as any).procurementProfileDraft = (productContext as any).procurementProfileDraft ?? {});
        const dr: any = (draft.domainRules = draft.domainRules ?? {});
        if (genQ?.ru?.length) dr.buyerMustCheck = genQ.ru;
        if (genSeo) dr.seo = { title: genSeo.title, description: genSeo.description, sellingBullets: genSeo.bullets, keywords: genSeo.keywords, characteristics: genSeo.characteristics };
        if (genCargo) dr.cargo = { cargoNature: genCargo.cargoNature, sensitiveIssues: genCargo.considerations, whatToRequest: genCargo.whatToRequest, packagingNotes: '' };
        console.log(`[doc-generators] questions:${genQ?.ru?.length ?? 0} seo:${genSeo ? 'ok' : 'none'} cargo:${genCargo?.cargoNature ?? 'none'}`);
      } catch (e: any) {
        console.error('[doc-generators] failed:', e?.message);
      }
    }

    const fallbackQuery = raw?.titleEn || raw?.categoryName || raw?.titleCn || '';
    const wbCoreQuery = productContext?.wbSearch?.coreQuery || fallbackQuery;
    const categoryType = productContext?.identity?.categoryType ?? 'other';
    const validatedQueries = productContext?.wbSearch?.queryLadder?.length ? productContext.wbSearch.queryLadder : [fallbackQuery].filter(Boolean);

    const seoContent = {
      titleRu: productContext?.titles?.cleanRu ?? raw.titleEn ?? raw.titleCn,
      description: '', bullets: [] as string[], keywords: validatedQueries,
      characteristics: productContext?.facts ?? {},
    };

    const structure = productContext ? {
      coreObject: productContext.identity.coreObject || fallbackQuery,
      productType: productContext.identity.productType || fallbackQuery,
      material: Object.entries(productContext.facts).filter(([k]) => k.includes('материал')).map(([, v]) => v),
      hardConflicts: productContext.conflicts.filter(c => c.severity === 'high').map(c => c.field),
      softConflicts: productContext.conflicts.filter(c => c.severity !== 'high').map(c => c.field),
      directAnalogBlockers: productContext.wbSearch.rejectRules,
      marketSynonyms: productContext.wbSearch.queryLadder,
      mustKeep: productContext.wbSearch.mustInclude,
      doNotSearch: productContext.wbSearch.mustExclude,
      audience: productContext.identity.audience,
    } : { coreObject: fallbackQuery, productType: fallbackQuery, material: [], hardConflicts: [], softConflicts: [], directAnalogBlockers: [], marketSynonyms: validatedQueries, mustKeep: [], doNotSearch: [], audience: '' };

    const queryPlan = productContext ? {
      L1_exact: productContext.wbSearch.queryLadder.slice(0, 2),
      L2_commercial: productContext.wbSearch.queryLadder.slice(2, 4),
      L3_subtype: [], L4_core: [productContext.identity.coreObject], L5_category: [],
    } : { L1_exact: validatedQueries.slice(0, 1), L2_commercial: validatedQueries.slice(1, 2), L3_subtype: [], L4_core: [fallbackQuery].filter(Boolean), L5_category: [] };

    const lexicon = productContext ? {
      mainTerms: [productContext.identity.coreObject],
      hardNegativeTerms: productContext.wbSearch.mustExclude,
    } : { mainTerms: [fallbackQuery].filter(Boolean), hardNegativeTerms: [] };

    const intelligence = productContext ?? null;

    console.log(`[pipeline] AI: ${seoContent.titleRu?.slice(0, 40)} | cat: ${categoryType} | wbCore: ${wbCoreQuery}`);

    await supabase.from('jobs').update({
      status: 'ai_done',
      result_json: { ...resultJson, seoContent, productContext, wbCoreQuery, categoryType, validatedQueries, productStructure: structure, queryPlan, productLexicon: lexicon, intelligence },
    }).eq('id', jobId);

    // ─── STEP 3: Market ─────────────────────────────────────────────────
    progress?.step('market');

    const trendsPromise = wbCoreQuery
      ? fetchWbTrends(wbCoreQuery).catch(() => ({ query: wbCoreQuery, trends: [] as WbTrend[], latencyMs: 0 }))
      : Promise.resolve(null);

    let allCards: WbCard[] = [];
    let allQueries: string[] = [];
    let similarity: any = { buckets: { directLocalAnalogs: [], similarLocalProducts: [], crossBorderAnalogs: [], categoryOnly: [], wrong: [] }, confidence: 'no_market', leaders: [] };
    let wbSearchCount = 0;
    let wb429 = false;

    try {
      const trendsResult = await trendsPromise;
      const filteredTrends = trendsResult?.trends?.length
        ? filterRelevantTrends(trendsResult.trends, wbCoreQuery, structure.productType, structure.material, intelligence?.wbSearch?.negativeSearchTerms ?? lexicon.hardNegativeTerms, intelligence?.matchingRules?.directAnalogBlockers ?? structure.directAnalogBlockers)
        : [];

      const pool = buildCandidatePool(queryPlan, validatedQueries, filteredTrends, structure, seoContent.keywords);
      const context = { coreObject: structure.coreObject, productType: structure.productType, audience: structure.audience ?? '', materials: structure.material, hardConflicts: structure.hardConflicts, softConflicts: structure.softConflicts, mustKeep: structure.mustKeep, doNotSearch: structure.doNotSearch };
      const selected = selectTopQueries(pool, MAX_WB_QUERIES, context);
      const searchQueries = selected.map(c => c.query);

      if (searchQueries.length > 0) {
        const searchResult = await searchWb(searchQueries);
        if (searchResult.is429) wb429 = true;
        allCards = searchResult.cards;
        allQueries = searchQueries;
        wbSearchCount = searchQueries.length;

        let ranked = rankCandidates(allCards, structure, lexicon, allQueries);

        if (ranked.buckets.directLocalAnalogs.length === 0 && wbSearchCount < MAX_WB_QUERIES) {
          const rejected = ranked.buckets.wrong.slice(0, 5).map((c: any) => c.title);
          const found = ranked.buckets.similarLocalProducts.slice(0, 5).map((c: any) => c.title);
          const repair = await repairSearch(structure, allQueries, found, rejected, { tokens: [], bigrams: [] }).catch(() => ({ newQueries: [] as string[], reason: '' }));
          if (repair.newQueries.length) {
            const repairQ = repair.newQueries.slice(0, Math.max(0, MAX_WB_QUERIES - wbSearchCount));
            const { cards: repairCards } = await searchWb(repairQ);
            for (const c of repairCards) {
              if (!searchResult.seenUrls.has(c.url)) { searchResult.seenUrls.add(c.url); allCards.push(c); }
            }
            allQueries.push(...repairQ);
            wbSearchCount += repairQ.length;
          }
        }

        similarity = rankCandidates(allCards, structure, lexicon, allQueries);

        if (similarity.buckets.directLocalAnalogs.length + similarity.buckets.similarLocalProducts.length > 0) {
          const borderline = [...similarity.buckets.directLocalAnalogs.slice(0, 15), ...similarity.buckets.similarLocalProducts.slice(0, 10)]
            .filter((c: any) => c.similarity >= 35 && c.similarity <= 70).slice(0, 10);
          if (borderline.length > 0) {
            const judgments = await judgeCandidateBatch(structure, borderline.map((c: any) => ({ title: c.title, price: c.price, detectedConflicts: [...(c.hardConflictsFound ?? []), ...(c.softConflictsFound ?? [])] }))).catch(() => [] as any[]);
            if (judgments.length === borderline.length) {
              borderline.forEach((card: any, i: number) => {
                if (judgments[i]?.matchLevel) { card.matchLevel = judgments[i].matchLevel; }
              });
              const all = [...similarity.buckets.directLocalAnalogs, ...similarity.buckets.similarLocalProducts, ...similarity.buckets.categoryOnly];
              similarity.buckets.directLocalAnalogs = all.filter((c: any) => c.matchLevel === 'direct_analog' && c.marketType !== 'crossborder_market');
              similarity.buckets.similarLocalProducts = all.filter((c: any) => c.matchLevel === 'similar' && c.marketType !== 'crossborder_market');
              similarity.buckets.categoryOnly = all.filter((c: any) => c.matchLevel === 'category_only');
            }
          }
        }
      }
    } catch (e: any) {
      console.warn('[pipeline] WB search error:', e.message);
      if (e.message?.includes('429')) wb429 = true;
    }

    console.log(`[pipeline] Market: direct=${similarity.buckets.directLocalAnalogs.length} similar=${similarity.buckets.similarLocalProducts.length} cross=${similarity.buckets.crossBorderAnalogs.length}`);

    const directCards = similarity.buckets.directLocalAnalogs.filter((c: any) => (c.similarity ?? 0) >= 85 && c.marketType !== 'crossborder_market');
    const economyDirectCards = directCards.length >= 5 ? directCards : [];
    const wbData: WbSearchResult | null = economyDirectCards.length > 0 ? {
      avgPrice: Math.round(economyDirectCards.reduce((s: number, c: any) => s + c.price, 0) / economyDirectCards.length),
      minPrice: Math.min(...economyDirectCards.map((c: any) => c.price)),
      maxPrice: Math.max(...economyDirectCards.map((c: any) => c.price)),
      totalCards: allCards.length, topExamples: economyDirectCards.slice(0, 3),
      allCards: economyDirectCards, photoSearchConfirmed: false,
    } : null;

    const filterKeywords = seoContent?.filterKeywords ?? { required: [], optional: [], exclude: [] };
    const wbFiltered = filterWbData(wbData, filterKeywords as any, allQueries);
    const marketDecision = {
      status: directCards.length >= 5 ? 'confirmed' : directCards.length > 0 ? 'weak' : wb429 ? 'rate_limited' : 'not_confirmed',
      rawCandidatesCount: allCards.length, confirmedDirectCount: directCards.length,
      similarLocalCount: similarity.buckets.similarLocalProducts.length,
      crossBorderCount: similarity.buckets.crossBorderAnalogs.length,
      categoryOnlyCount: similarity.buckets.categoryOnly.length,
      medianPriceRub: directCards.length >= 5 ? wbFiltered?.medianPrice ?? null : null,
      canCalculateRoi: directCards.length >= 5 && !!wbFiltered?.medianPrice,
      reason: directCards.length >= 5 ? '5+ прямых аналогов.' : directCards.length > 0 ? 'Меньше 5 прямых аналогов.' : 'Прямые аналоги не найдены.',
    };

    const userTariffs = await getUserTariffs(job.user_id).catch(() => null);
    const economics = await calcEconomics({
      platform: raw.platform, priceYuan: raw.priceYuan, weightKg: raw.weightKg,
      categoryHint: raw.categoryName, tariffs: userTariffs ?? undefined,
      ...(marketDecision.canCalculateRoi && wbFiltered && wbFiltered.medianPrice > 0 ? { wbMedianPrice: wbFiltered.medianPrice } : {}),
    });

    const riskFlags = buildRiskFlags(raw, wbFiltered);
    const budgets = calcBudgetScenarios(economics.costRub, economics.weightMissing, raw.moq);
    const maxPurchasePrice = marketDecision.canCalculateRoi && wbFiltered?.medianPrice
      ? calcMaxPurchasePrice(wbFiltered.medianPrice, raw.weightKg, economics.yuanToRub, userTariffs ?? undefined, raw.priceYuan) : null;
    const conclusion = buildConclusion(raw.platform, economics, wbFiltered, riskFlags);

    const similarityData = {
      queries: allQueries.filter((q: string) => /[а-яё]/i.test(q)).slice(0, 5),
      totalAnalyzed: allCards.length,
      directCount: similarity.buckets.directLocalAnalogs.length,
      similarCount: similarity.buckets.similarLocalProducts.length,
      crossBorderCount: similarity.buckets.crossBorderAnalogs.length,
      categoryCount: similarity.buckets.categoryOnly.length,
      confidence: similarity.confidence,
      leaders: (similarity.leaders ?? []).slice(0, 10).map((c: any) => ({ title: c.title, price: c.price, url: c.url, rating: c.rating, feedbacks: c.feedbacks, similarity: c.similarity, matchLevel: c.matchLevel })),
    };

    const product: any = {
      ...raw, titleRu: seoContent.titleRu ?? raw.titleEn ?? raw.titleCn,
      seoContent, wbData, wbFiltered, riskFlags, economics, budgets,
      maxPurchasePrice, conclusion, similarityData, marketDecision,
      wbCoreQuery, categoryType, intelligence,
      // Carry the canonicalizer context (incl. procurementProfileDraft.domainRules
      // populated by the focused generators) so the ZIP document builders in
      // detailButtons — which read result_json.product — get the product-specific
      // supplier questions / SEO / cargo instead of the generic floor.
      productContext,
      ...(wb429 ? { wb429: true } : {}),
    };

    // Translate the final supplier questions to Chinese so the ZIP questions file
    // ships a valid CN version (the buyer sends it to the 1688 supplier). Uses the
    // SAME resolved RU list the doc builder will render. RU-only stays as the safe
    // fallback if translation fails.
    try {
      const cnProfile = buildProductProcurementProfile(product);
      const ruQuestions = (cnProfile.procurement.mustAskSupplier ?? []).slice(0, 10);
      if (ruQuestions.length) {
        const cnQuestions = await translateQuestionsToCn(ruQuestions).catch(() => []);
        if (Array.isArray(cnQuestions) && cnQuestions.length === ruQuestions.length) {
          // Persist the EXACT RU list that was translated so the doc builder renders
          // the matching RU+CN pair. Re-deriving the questions there can yield a
          // different count (hard-gate/reserve), which drops CN to RU-only.
          product.supplierQuestionsRu = ruQuestions;
          product.supplierQuestionsCn = cnQuestions;
          product.supplierQuestionsCnValid = true;
          console.log(`[cn-translate] supplier questions RU→CN: ${cnQuestions.length}`);
        } else {
          console.log('[cn-translate] supplier questions RU→CN failed — RU-only');
        }
      }
    } catch (e: any) {
      console.error('[cn-translate] failed:', e?.message);
    }

    // ─── LLM document writer ────────────────────────────────────────────
    // Turn the deterministic cargo/checklist TEMPLATE drafts into polished,
    // prioritized documents. The writer may only reorganize the profile facts;
    // its output is safety-validated and, on any failure, we keep the template.
    try {
      const profile = buildProductProcurementProfile(product);
      const base: Omit<DocWriterInput, 'docType' | 'draftMd'> = {
        titleRu: profile.identity.titleForReport,
        coreObject: profile.identity.coreObject,
        categoryType: profile.identity.categoryType,
        productKind: profile.identity.productKind,
        useCases: profile.identity.useCases ?? [],
        materials: profile.identity.materials ?? [],
        selectedSku: profile.sku.selectedSkuText,
        priceText: profile.pricing.displayPriceText,
        sourceUrl: job.input_url,
        supplierType: profile.supplier.displayType,
        cargoNature: profile.cargo.cargoNature ?? 'none',
        weightKnown: typeof profile.logistics?.weightKg === 'number',
        dimsKnown: !!profile.logistics?.dimensionsCm,
        mustAskSupplier: profile.procurement.mustAskSupplier ?? [],
        mustCheckBeforeSample: profile.procurement.mustCheckBeforeSample ?? [],
        mustCheckOnSample: profile.procurement.mustCheckOnSample ?? [],
        redFlags: profile.procurement.redFlags ?? [],
        cargoMustAsk: profile.cargo.mustAsk ?? [],
        cargoWhatToRequest: profile.cargo.whatToRequest ?? [],
        cargoConsiderations: profile.cargo.likelySensitiveCargoIssues ?? [],
      };
      const forbidden = profile.content.seoForbiddenClaims ?? [];
      const cargoDraft = buildCargoBriefFromProfile(product, { sourceUrl: job.input_url });
      const checklistDraft = buildSampleChecklistFromProfile(product, { sourceUrl: job.input_url });
      // Confirmed attributes = raw card attributes with a concrete value (used to
      // gate invented numbers in SEO bullets).
      const confirmedAttributes = (Array.isArray(raw.attributes) ? raw.attributes : [])
        .map((a: any) => ({ name: String(a?.name ?? '').trim(), value: String(a?.value ?? '').trim() }))
        .filter((a: any) => a.name && a.value)
        .slice(0, 30);
      const [cargoMd, checklistMd, seoProse] = await Promise.all([
        writeDocument({ ...base, docType: 'cargo', draftMd: cargoDraft }, forbidden).catch(() => null),
        writeDocument({ ...base, docType: 'checklist', draftMd: checklistDraft }, forbidden).catch(() => null),
        writeSeoProse({
          titleRu: profile.identity.titleForSeo || profile.identity.titleForReport,
          coreObject: profile.identity.coreObject,
          categoryType: profile.identity.categoryType,
          useCases: profile.identity.useCases ?? [],
          materials: profile.identity.materials ?? [],
          claimedFeatures: [
            ...(profile.identity.claimedFeatures ?? []),
            ...(profile.identity.unconfirmedFeatures ?? []),
          ],
          skuReliable: profile.sku.selectedSkuReliable,
          confirmedAttributes,
          forbidden,
        }).catch(() => null),
      ]);
      if (cargoMd || checklistMd || seoProse) {
        product.polishedDocs = {
          ...(cargoMd ? { cargo: cargoMd } : {}),
          ...(checklistMd ? { checklist: checklistMd } : {}),
          ...(seoProse ? { seoProse } : {}),
        };
      }
      console.log(`[doc-writer] cargo:${cargoMd ? 'ok' : 'floor'} checklist:${checklistMd ? 'ok' : 'floor'} seoProse:${seoProse ? 'ok' : 'floor'}`);
    } catch (e: any) {
      console.error('[doc-writer] failed:', e?.message);
    }

    // ─── STEP 4: Writer ─────────────────────────────────────────────────
    progress?.step('writer');

    const updatedResult = { ...resultJson, rawProduct: raw, imageUrls, seoContent, productContext, wbCoreQuery, categoryType, validatedQueries, product, intelligence };

    const snapshot = buildAnalysisSnapshot(product, updatedResult, job.input_url);
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

    console.log(`[pipeline] Writer done`);

    // ─── STEP 5: QA + Send ──────────────────────────────────────────────
    progress?.step('send');

    const safeRiskFlags = product.riskFlags ?? {
      hasBrand: false, isElectrical: false, isChildren: false,
      isCosmetic: false, isFood: false, isMedical: false,
      supplierOrdersLow: false, supplierTypeUnknown: false,
      weightMissing: false, sizeGridRelevant: false, marketDataUnreliable: true,
    };

    const seoText = formatSeoText(product, product.seoContent ?? {}, safeRiskFlags);
    const briefText = formatOrderBrief(product, product.seoContent ?? {}, product.economics, safeRiskFlags, job.input_url, product.budgets, product.conclusion);

    const currentStatus = await getStatus(job.user_id);
    const statusForMsg = { plan: currentStatus.plan ?? 'free', creditsRemaining: currentStatus.creditsRemaining ?? 0, creditsTotal: 0, canGenerate: true, isTrial: currentStatus.isTrial ?? false };

    const keywords2 = (product.seoContent?.keywords ?? []).slice(0, 3);
    if (!keywords2.length && product.titleRu) keywords2.push(product.titleRu.split(' ').slice(0, 2).join(' '));
    const wbCats = keywords2.length ? await findWbCategoriesByKeywords(keywords2).catch(() => []) : [];
    const wbCategory = wbCats[0] ?? null;

    const { text: mainText, keyboard } = buildMainMessage(product, jobId, statusForMsg as any, wbCategory);

    const softValidation = validateReport(mainText, categoryType, {
      hasPrice: product.priceYuan > 0, hasWeight: product.weightKg > 0,
      hasDirectAnalogs: !!(similarityData.directCount && similarityData.directCount > 0),
      wb429, intelligence: intelligence as any,
    });
    let finalText = softValidation.ok ? mainText : softValidation.fixedText;

    let hardResult = runHardValidator({ analysisSnapshot: snapshot, artifacts: { userCard: finalText, seoText, buyerBrief: briefText, lastMessage: writerResult?.lastMessage ?? '' } });
    if (hardResult.fixedArtifacts?.userCard && !hardResult.block) finalText = String(hardResult.fixedArtifacts.userCard);

    if (hardResult.block || !hardResult.canShowFullReport) {
      console.warn(`[pipeline] HARD BLOCKED: ${hardResult.issues.map(i => i.problem).join('; ')}`);
      progress?.stop();
      if (messageId) await bot.telegram.deleteMessage(chatId, messageId).catch(() => {});
      await bot.telegram.sendMessage(chatId, buildSafeSummary(product, 'Полный отчёт не показан: сработал кодовый валидатор.'), { parse_mode: 'HTML' });
      await markSent(jobId);
      if (redis) await redis.del(`processing:${job.user_id}`).catch(() => {});
      return;
    }

    // QA Gate отключён: не блокируем отчёт и не показываем safe summary из-за QA.
    const qaResult = {
      decision: 'PASS',
      issues: [],
      qualityScore: 8,
      summary: 'QA Gate отключён.',
    } as any;

    console.log('[pipeline] QA: skipped (disabled)');

    await tryConsumeCredit(job.user_id);
    await track(job.user_id, 'generation_done', { url: job.input_url });

    progress?.stop();

    if (messageId) await bot.telegram.deleteMessage(chatId, messageId).catch(() => {});
    await bot.telegram.sendMessage(chatId, finalText, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...keyboard });

    await markSent(jobId);
    await supabase.from('jobs').update({
      status: 'sent',
      result_json: { ...updatedResult, product, analysisSnapshot: snapshot, writerResult, generatedFiles: { seoText, briefText } },
      finished_at: new Date().toISOString(),
    }).eq('id', jobId);

    if (redis) await redis.del(`processing:${job.user_id}`).catch(() => {});

    const cacheKey = buildCacheKey(product.productId, product.titleCn, product.mainImageUrl);
    upsertProduct(job.user_id, { ...product, cacheKey }).catch(() => {});

    console.log(`[pipeline] Job ${jobId} sent | QA: ${qaResult?.decision ?? 'skipped'} | hard: ${hardResult.ok ? 'PASS' : hardResult.issues.length + ' issues'}`);

  } catch (e: any) {
    console.error(`[pipeline] Error job ${jobId}:`, e.message);
    progress?.stop();
    const { data: failedJob } = await supabase.from('jobs').select('tg_chat_id, tg_message_id, user_id').eq('id', jobId).single();
    if (failedJob) {
      if (failedJob.tg_message_id) {
        await bot.telegram.editMessageText(failedJob.tg_chat_id, failedJob.tg_message_id, undefined, '❌ Не удалось завершить анализ.\n\nПопробуйте ещё раз.\nКредит не списан.').catch(() => {});
      }
      await supabase.from('jobs').update({ status: 'failed', error: e.message, finished_at: new Date().toISOString() }).eq('id', jobId);
      if (redis) await redis.del(`processing:${failedJob.user_id}`).catch(() => {});
    }
  }
}

// ─── Pipeline: полный запуск (step1 + step2-5) ──────────────────────────────

async function runPipeline(jobId: string) {
  const { data: job } = await supabase.from('jobs').select('*').eq('id', jobId).single();
  if (!job) return;

  const chatId = job.tg_chat_id;
  const messageId = job.tg_message_id;
  const progress = messageId ? createStepProgress(bot, chatId, messageId, 'elim') : null;

  try {
    await supabase.from('jobs').update({ status: 'elim', started_at: new Date().toISOString() }).eq('id', jobId);

    // ─── STEP 1: Elim (parse product) ─────────────────────────────────
    let rawProduct = await productImporter.fetchProduct(job.input_url);
    rawProduct.titleCn = normalizeCnText(rawProduct.titleCn);
    if (rawProduct.description) rawProduct.description = normalizeCnText(rawProduct.description);

    console.log(`[pipeline] Elim: ${rawProduct.titleCn?.slice(0, 30)} | imgs:${rawProduct.images.length} | skus:${rawProduct.skus?.length ?? 0}`);

    const rawForJob = {
      productId: rawProduct.productId, platform: rawProduct.platform,
      titleCn: rawProduct.titleCn, titleEn: rawProduct.titleEn,
      description: rawProduct.description?.slice(0, 500),
      priceYuan: rawProduct.priceYuan, priceRange: rawProduct.priceRange?.slice(0, 5),
      priceIsRange: rawProduct.priceIsRange, moq: rawProduct.moq, weightKg: rawProduct.weightKg,
      mainImageUrl: rawProduct.mainImageUrl, supplierName: rawProduct.supplierName,
      supplierRating: rawProduct.supplierRating, supplierType: rawProduct.supplierType,
      sold: rawProduct.sold, stock: rawProduct.stock, categoryName: rawProduct.categoryName,
      attributes: rawProduct.attributes?.slice(0, 15), skus: rawProduct.skus?.slice(0, 15),
      selectedSkuName: rawProduct.selectedSkuName, normalized1688: rawProduct.normalized1688,
    };

    // ─── SKU check ──────────────────────────────────────────────────────
    const skus = rawProduct.skus ?? [];
    if (skus.length >= 2 && messageId) {
      const buttons = skus.slice(0, 8).map((sku: any, i: number) => {
        let label = normalizeCnText(String(sku.name ?? sku.label ?? `Вариант ${i + 1}`)).replace(/[一-鿿]/g, '').replace(/\s+/g, ' ').trim() || `Вариант ${i + 1}`;
        label = label.slice(0, 28);
        const priceLabel = sku.price && Number(sku.price) > 0 ? ` · ${sku.price} ¥` : '';
        return [Markup.button.callback(`${label}${priceLabel}`, `sku_${i}_${jobId}`)];
      });
      buttons.push([Markup.button.callback('📊 Все варианты', `sku_all_${jobId}`)]);

      await supabase.from('jobs').update({
        status: 'sku_pending',
        result_json: { rawProduct: rawForJob, imageUrls: rawProduct.images },
      }).eq('id', jobId);

      progress?.stop();
      await bot.telegram.editMessageText(chatId, messageId, undefined, 'Выберите вариант для расчёта:', { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }).catch(() => {});
      return;
    }

    // ─── No SKU — continue pipeline ─────────────────────────────────────
    await supabase.from('jobs').update({
      status: 'elim_done',
      result_json: { rawProduct: rawForJob, imageUrls: rawProduct.images },
    }).eq('id', jobId);

    progress?.stop();
    await continuePipeline(jobId);

  } catch (e: any) {
    console.error(`[pipeline] Elim error job ${jobId}:`, e.message);
    progress?.stop();
    if (messageId) {
      await bot.telegram.editMessageText(chatId, messageId, undefined, '❌ Не удалось загрузить товар.\n\nПопробуйте другую ссылку.\nКредит не списан.').catch(() => {});
    }
    await supabase.from('jobs').update({ status: 'failed', error: e.message, finished_at: new Date().toISOString() }).eq('id', jobId);
    if (redis) await redis.del(`processing:${job.user_id}`).catch(() => {});
  }
}

// Make continuePipeline available for skuSelect handler
(global as any).__continuePipeline = continuePipeline;

// ─── Webhook dedup ──────────────────────────────────────────────────────────

async function isDuplicate(updateId: number): Promise<boolean> {
  if (!redis) return false;
  const result = await redis.set(`dedup:${updateId}`, '1', { nx: true, ex: 60 });
  return result === null;
}

// ─── Webhook endpoint ───────────────────────────────────────────────────────

app.post('/webhook', async (req, res) => {
  const updateId = req.body?.update_id;
  if (!updateId) return res.status(200).json({ ok: true });

  if (await isDuplicate(updateId)) return res.status(200).json({ ok: true });

  const msg = req.body?.message;
  const urlText = msg?.text?.trim() ?? '';
  const urlMatch = !urlText.startsWith('/') ? urlText.match(/https?:\/\/[^\s]*(1688|taobao|tmall|qr\.1688)\.com[^\s]*/i) : null;

  if (urlMatch && msg?.from?.id && msg?.chat?.id) {
    try {
      const dbUser = await getOrCreateUser(msg.from.id);
      await cleanupStuckJobs(dbUser.id, msg.chat.id, bot);

      if (redis) {
        const processing = await redis.get(`processing:${dbUser.id}`);
        if (processing) {
          await bot.telegram.sendMessage(msg.chat.id, '⏳ Предыдущий анализ ещё выполняется.');
          return res.status(200).json({ ok: true });
        }
      }

      const linkRL = await checkLinkLimit(dbUser.id);
      if (!linkRL.allowed) {
        await bot.telegram.sendMessage(msg.chat.id, `⏳ Подождите ${linkRL.retryAfterSec ?? 30}с.`);
        return res.status(200).json({ ok: true });
      }

      const status = await getStatus(dbUser.id);
      if (!status.canGenerate) {
        await bot.telegram.sendMessage(msg.chat.id, '🔎 <b>Лимит разборов исчерпан</b>\n\nИспользуйте /upgrade', { parse_mode: 'HTML' });
        return res.status(200).json({ ok: true });
      }

      const progressMsg = await bot.telegram.sendMessage(msg.chat.id, '⏳ Запрос принят, начинаю анализ...', { parse_mode: 'HTML' });
      const job = await createJob(dbUser.id, msg.chat.id, progressMsg.message_id, urlMatch[0]);
      if (redis) await redis.set(`processing:${dbUser.id}`, job.id, { ex: 300 });
      await track(dbUser.id, 'sent_link', { url: urlMatch[0] });

      runPipeline(job.id).catch(e => console.error('[pipeline] Unhandled:', e));
    } catch (e) {
      console.error('[webhook] URL pipeline error:', e);
    }
    return res.status(200).json({ ok: true });
  }

  try {
    await bot.handleUpdate(req.body);
  } catch (e) {
    console.error('[webhook] handleUpdate error:', e);
  }
  res.status(200).json({ ok: true });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', mode: 'vps', uptime: process.uptime() });
});

// ─── Start ──────────────────────────────────────────────────────────────────

import { readFileSync, existsSync } from 'fs';
import { createServer } from 'https';

const PORT = process.env.PORT || 3000;
const SSL_KEY = process.env.SSL_KEY || '/opt/cardzip-bot/webhook.key';
const SSL_CERT = process.env.SSL_CERT || '/opt/cardzip-bot/webhook.pem';

if (existsSync(SSL_KEY) && existsSync(SSL_CERT)) {
  const httpsServer = createServer({ key: readFileSync(SSL_KEY), cert: readFileSync(SSL_CERT) }, app);
  httpsServer.listen(PORT, () => {
    console.log(`CardZip VPS server (HTTPS) running on port ${PORT}`);
    const webhookUrl = process.env.WEBHOOK_URL;
    if (webhookUrl) {
      const certPem = readFileSync(SSL_CERT, 'utf8');
      bot.telegram.setWebhook(webhookUrl, { certificate: { source: Buffer.from(certPem), filename: 'webhook.pem' } })
        .then(() => console.log(`Webhook set: ${webhookUrl}`))
        .catch((e) => console.warn(`Webhook set failed (set manually): ${e.message}`));
    }
  });
} else {
  app.listen(PORT, () => {
    console.log(`CardZip VPS server (HTTP) running on port ${PORT}`);
    const webhookUrl = process.env.WEBHOOK_URL;
    if (webhookUrl) {
      bot.telegram.setWebhook(webhookUrl)
        .then(() => console.log(`Webhook set: ${webhookUrl}`))
        .catch((e) => console.warn(`Webhook set failed (set manually): ${e.message}`));
    }
  });
}

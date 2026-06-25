import type { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { supabase } from '../src/db/supabase';
import { calcEconomics, calcBudgetScenarios, calcMaxPurchasePrice } from '../src/core/economicsCalc';
import { buildConclusion } from '../src/core/verdict';
import { buildRiskFlags } from '../src/core/riskFlags';
import { rankCandidates, mineResults } from '../src/core/wbSimilarity';
import { filterWbData } from '../src/core/wbFilter';
import { createStepProgress } from '../src/core/progress';
import { getUserTariffs } from '../src/db/queries/userSettings';
import { expandQueries, judgeCandidateBatch, validateQueries, repairSearch } from '../src/providers/productUnderstanding';
import { acquireStepLock, extendProcessingLock } from '../src/lib/stepLock';
import type { WbFilterKeywords, WbCard, WbSearchResult } from '../src/types';
import { fetchWbTrends, filterRelevantTrends, type WbTrend } from '../src/providers/wbconTrends';

export const config = { maxDuration: 60 };

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
const WB_PARSER_URL = process.env.WB_PARSER_URL || 'http://50fc4ca33bd1.vps.myjino.ru';
const WB_PARSER_SECRET = process.env.WB_PARSER_SECRET || 'cardzip-wb-2024';

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

// Batch search через VPS — последовательный с throttling на стороне VPS
async function batchSearch(queries: string[]): Promise<{ cards: WbCard[]; seenUrls: Set<string> }> {
  const seenUrls = new Set<string>();
  const cards: WbCard[] = [];

  try {
    const res = await fetch(`${WB_PARSER_URL}/search-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: WB_PARSER_SECRET, queries, limit: 100 }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) {
      console.warn(`[step3] Batch search HTTP ${res.status}`);
      return { cards, seenUrls };
    }
    const data = await res.json() as any;

    for (const result of data.results ?? []) {
      for (const card of parseCards(result.products ?? [])) {
        if (!seenUrls.has(card.url)) { seenUrls.add(card.url); cards.push(card); }
      }
    }
  } catch (e: any) {
    console.warn('[step3] Batch search failed:', e.message);
  }

  return { cards, seenUrls };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end();
  const { jobId } = req.body ?? {};
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  try {
    const { data: job } = await supabase.from('jobs').select('*').eq('id', jobId).single();
    if (!job || job.status !== 'ai_done') return res.status(200).json({ ok: true, skip: true });
    if (!await acquireStepLock('step3', jobId)) return res.status(200).json({ ok: true, skip: true });
    await extendProcessingLock(job.user_id);

    await supabase.from('jobs').update({ status: 'market_processing', updated_at: new Date().toISOString() }).eq('id', jobId);

    const raw = (job.result_json as any).rawProduct;
    const seoContent = (job.result_json as any).seoContent;
    const resultJson = job.result_json as any;
    const structure = resultJson.productStructure ?? null;
    const lexicon = resultJson.productLexicon ?? null;
    const queryPlan = resultJson.queryPlan ?? null;
    const validatedQueries: string[] = resultJson.validatedQueries ?? [];
    const wbCoreQuery: string = resultJson.wbCoreQuery ?? structure?.coreObject ?? '';

    // WBCON trends — запускаем параллельно, не блокируем
    const trendsPromise = wbCoreQuery
      ? fetchWbTrends(wbCoreQuery).catch(() => ({ query: wbCoreQuery, trends: [] as WbTrend[], latencyMs: 0 }))
      : Promise.resolve(null);

    const progress = job.tg_message_id
      ? createStepProgress(bot, job.tg_chat_id, job.tg_message_id, 'market')
      : null;

    // ─── WB Search (все pass'ы с safety timeout) ──────────────────────
    let allCards: WbCard[] = [];
    let allQueries: string[] = [];
    let similarity: any = { buckets: { directLocalAnalogs: [], similarLocalProducts: [], crossBorderAnalogs: [], categoryOnly: [], wrong: [] }, confidence: 'no_market' };

    const wbSearchStart = Date.now();
    try {

    const ladder = queryPlan ?? {} as any;
    const pass1Queries = validatedQueries.length >= 3
      ? validatedQueries.slice(0, 10)
      : [
          ...(ladder.L1_exact ?? []),
          ...(ladder.L2_commercial ?? []),
          ...(ladder.L3_subtype ?? []),
          seoContent?.titleRu,
          ...(seoContent?.keywords?.slice(0, 2) ?? []),
        ].filter((q): q is string => !!q && q.length > 2 && /[а-яё]/i.test(q))
         .filter((q, i, a) => a.indexOf(q) === i).slice(0, 8);

    console.log(`[step3] PASS 1 (L1-L3): ${pass1Queries.length} queries`);
    const { cards: pass1Cards, seenUrls } = await batchSearch(pass1Queries);
    console.log(`[step3] PASS 1: ${pass1Cards.length} cards`);

    const mining = mineResults(pass1Cards);
    allCards = [...pass1Cards];
    allQueries = [...pass1Queries];
    let preRank = rankCandidates(allCards, structure, lexicon, allQueries);

    // ─── PASS 2: L4-L5 + Adaptive (if direct < 10) ─────────────────────
    if (preRank.buckets.directLocalAnalogs.length < 10) {
      const pass2Queries = [
        ...(ladder.L4_core ?? []),
        ...(ladder.L5_category ?? []),
      ].filter((q): q is string => !!q && q.length > 2 && !allQueries.includes(q));

      // Adaptive from mining
      const adaptiveQueries = structure
        ? await expandQueries(structure, mining.tokens, mining.bigrams).catch(() => [] as string[])
        : [];

      const combined = [...pass2Queries, ...adaptiveQueries]
        .filter((q, i, a) => a.indexOf(q) === i && !allQueries.includes(q)).slice(0, 8);

      if (combined.length) {
        console.log(`[step3] PASS 2 (L4-L5+adaptive): ${combined.length} queries`);
        const { cards: p2Cards } = await batchSearch(combined);
        for (const c of p2Cards) { if (!seenUrls.has(c.url)) { seenUrls.add(c.url); allCards.push(c); } }
        allQueries.push(...combined);
        preRank = rankCandidates(allCards, structure, lexicon, allQueries);
        console.log(`[step3] After PASS 2: ${allCards.length} cards, direct=${preRank.buckets.directLocalAnalogs.length}`);
      }
    }

    // ─── PASS 3: Search Repair Agent (if direct < 3) ────────────────────
    if (preRank.buckets.directLocalAnalogs.length < 3 && structure) {
      const rejected = preRank.buckets.wrong.slice(0, 5).map(c => c.title);
      const found = [...preRank.buckets.directLocalAnalogs, ...preRank.buckets.similarLocalProducts].slice(0, 10).map(c => c.title);
      const repair = await repairSearch(structure, allQueries, found, rejected, mining);

      if (repair.newQueries.length) {
        console.log(`[step3] PASS 3 (repair): ${repair.newQueries.length} queries. Reason: ${repair.reason}`);
        const { cards: p3Cards } = await batchSearch(repair.newQueries);
        for (const c of p3Cards) { if (!seenUrls.has(c.url)) { seenUrls.add(c.url); allCards.push(c); } }
        allQueries.push(...repair.newQueries);
        preRank = rankCandidates(allCards, structure, lexicon, allQueries);
        console.log(`[step3] After PASS 3: ${allCards.length} cards, direct=${preRank.buckets.directLocalAnalogs.length}`);
      }
    }

    // ─── PASS 4: Fallback by coreObject (if still < 3) ──────────────────
    if (preRank.buckets.directLocalAnalogs.length < 3 && structure?.coreObject) {
      const fbQueries = [
        structure.coreObject,
        structure.productType !== structure.coreObject ? structure.productType : null,
        ...(structure.marketSynonyms ?? []).slice(0, 2),
      ].filter((q): q is string => !!q && q.length > 2 && !allQueries.includes(q)).slice(0, 4);

      if (fbQueries.length) {
        console.log(`[step3] PASS 4 (fallback): ${fbQueries.join(' | ')}`);
        const { cards: fbCards } = await batchSearch(fbQueries);
        for (const c of fbCards) { if (!seenUrls.has(c.url)) { seenUrls.add(c.url); allCards.push(c); } }
        allQueries.push(...fbQueries);
      }
    }

    // ─── Final ranking ───────────────────────────────────────────────────
    similarity = rankCandidates(allCards, structure, lexicon, pass1Queries);

    // ─── LLM Judge batch (1 вызов на все borderline кандидаты) ──────────
    if (structure && similarity.buckets.directLocalAnalogs.length + similarity.buckets.similarLocalProducts.length > 0) {
      const topCandidates = [
        ...similarity.buckets.directLocalAnalogs.slice(0, 15),
        ...similarity.buckets.similarLocalProducts.slice(0, 10),
      ];
      const borderline = topCandidates.filter(c => c.similarity >= 35 && c.similarity <= 70).slice(0, 10);

      if (borderline.length > 0) {
        console.log(`[step3] LLM Judge batch: ${borderline.length} candidates`);
        const judgments = await judgeCandidateBatch(structure, borderline.map(c => ({
          title: c.title, price: c.price,
          detectedConflicts: [...c.hardConflictsFound, ...c.softConflictsFound],
        }))).catch(() => [] as any[]);

        if (judgments.length === borderline.length) {
          borderline.forEach((card, i) => {
            if (judgments[i]?.matchLevel) {
              card.matchLevel = judgments[i].matchLevel;
              card.matchedTerms = judgments[i].matchedAttributes ?? card.matchedTerms;
              card.missingTerms = judgments[i].missingAttributes ?? card.missingTerms;
            }
          });
          const all = [...similarity.buckets.directLocalAnalogs, ...similarity.buckets.similarLocalProducts, ...similarity.buckets.categoryOnly];
          similarity.buckets.directLocalAnalogs = all.filter(c => c.matchLevel === 'direct_analog' && c.marketType !== 'crossborder_market').sort((a, b) => b.similarity - a.similarity);
          similarity.buckets.similarLocalProducts = all.filter(c => c.matchLevel === 'similar' && c.marketType !== 'crossborder_market').sort((a, b) => b.similarity - a.similarity);
          similarity.buckets.categoryOnly = all.filter(c => c.matchLevel === 'category_only');
        }
      }
    }

    console.log(`[step3] Final: directLocal=${similarity.buckets.directLocalAnalogs.length} similarLocal=${similarity.buckets.similarLocalProducts.length} crossBorder=${similarity.buckets.crossBorderAnalogs.length} category=${similarity.buckets.categoryOnly.length} confidence=${similarity.confidence}`);

    } catch (wbErr: any) {
      console.error(`[step3] WB search failed after ${Date.now() - wbSearchStart}ms:`, wbErr.message);
    }

    // ─── Build WbData for economics (only from LOCAL direct analogs) ────
    const directCards = similarity.buckets.directLocalAnalogs;
    const wbData: WbSearchResult | null = directCards.length > 0 ? {
      avgPrice: Math.round(directCards.reduce((s, c) => s + c.price, 0) / directCards.length),
      minPrice: Math.min(...directCards.map(c => c.price)),
      maxPrice: Math.max(...directCards.map(c => c.price)),
      totalCards: allCards.length,
      topExamples: directCards.slice(0, 3),
      allCards: directCards,
      photoSearchConfirmed: false,
    } : null;

    const filterKeywords = seoContent?.filterKeywords ?? { required: [], optional: [], exclude: [] };
    const wbFiltered = filterWbData(wbData, filterKeywords, pass1Queries);

    // ─── Economics ───────────────────────────────────────────────────────
    const userTariffs = await getUserTariffs(job.user_id).catch(() => null);
    const economics = await calcEconomics({
      platform: raw.platform,
      priceYuan: raw.priceYuan,
      weightKg: raw.weightKg,
      categoryHint: raw.categoryName,
      tariffs: userTariffs ?? undefined,
      ...(wbFiltered && wbFiltered.medianPrice > 0 ? { wbMedianPrice: wbFiltered.medianPrice } : {}),
    });

    const riskFlags = buildRiskFlags(raw, wbFiltered);
    const budgets = calcBudgetScenarios(economics.costRub, economics.weightMissing, raw.moq);
    const maxPurchasePrice = wbFiltered?.medianPrice
      ? calcMaxPurchasePrice(wbFiltered.medianPrice, raw.weightKg, economics.yuanToRub, userTariffs ?? undefined, raw.priceYuan)
      : null;
    const conclusion = buildConclusion(raw.platform, economics, wbFiltered, riskFlags);

    progress?.stop();

    // ─── Similarity data for display ─────────────────────────────────────
    const similarityData = {
      queries: pass1Queries.filter(q => /[а-яё]/i.test(q)).slice(0, 5),
      totalAnalyzed: allCards.length,
      directCount: similarity.buckets.directLocalAnalogs.length,
      similarCount: similarity.buckets.similarLocalProducts.length,
      crossBorderCount: similarity.buckets.crossBorderAnalogs.length,
      categoryCount: similarity.buckets.categoryOnly.length,
      confidence: similarity.confidence,
      leaders: similarity.leaders.slice(0, 10).map(c => ({
        title: c.title, price: c.price, url: c.url,
        rating: c.rating, feedbacks: c.feedbacks,
        similarity: c.similarity, matchLevel: c.matchLevel,
      })),
    };

    // ─── Debug trace ─────────────────────────────────────────────────────
    const debugTrace = {
      queryLadder: queryPlan,
      allQueriesTried: allQueries,
      pass1Cards: pass1Cards.length,
      mining: { tokens: mining.tokens.slice(0, 10), bigrams: mining.bigrams.slice(0, 5) },
      totalCards: allCards.length,
      finalBuckets: {
        directLocal: similarity.buckets.directLocalAnalogs.length,
        similarLocal: similarity.buckets.similarLocalProducts.length,
        crossBorder: similarity.buckets.crossBorderAnalogs.length,
        category: similarity.buckets.categoryOnly.length,
        wrong: similarity.buckets.wrong.length,
      },
      confidence: similarity.confidence,
      searchFailureReason: similarity.buckets.directLocalAnalogs.length === 0
        ? (similarity.buckets.categoryOnly.length > 0 ? 'category_only_found' : 'no_relevant_cards')
        : '',
    };

    // WBCON trends — фильтруем
    const trendsResult = await trendsPromise;
    const materials = structure?.material ?? [];
    const productType = structure?.productType ?? '';
    const wbTrends = trendsResult?.trends?.length
      ? filterRelevantTrends(trendsResult.trends, wbCoreQuery, productType, materials)
      : [];

    console.log(`[step3] wbcon: query="${wbCoreQuery}" raw=${trendsResult?.trends?.length ?? 0} filtered=${wbTrends.length} ${trendsResult?.latencyMs ?? 0}ms`);

    await supabase.from('jobs').update({
      status: 'done',
      result_json: {
        ...resultJson,
        product: {
          ...raw,
          titleRu: seoContent?.titleRu ?? raw.titleEn ?? raw.titleCn,
          seoContent, wbData, wbFiltered, riskFlags,
          economics, budgets, maxPurchasePrice, conclusion,
          similarityData,
          wbTrends,
          wbCoreQuery,
        },
        debugTrace,
      },
      finished_at: new Date().toISOString(),
    }).eq('id', jobId);

    // ─── Chain → step4 ──────────────────────────────────────────────────
    const host = req.headers.host || 'card-zip.vercel.app';
    for (let i = 0; i < 2; i++) {
      try {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 4000);
        await fetch(`https://${host}/api/step4-send`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId }), signal: ac.signal,
        });
        break;
      } catch { if (i === 0) await new Promise(r => setTimeout(r, 500)); }
    }

    res.status(200).json({ ok: true });
  } catch (e: any) {
    console.error('[step3]', e.message);
    const { handleStepError } = require('../src/lib/stepError');
    await handleStepError(jobId, e.message, bot);

    res.status(200).json({ ok: false });
  }
}

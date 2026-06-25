import type { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { supabase } from '../src/db/supabase';
import { calcEconomics, calcBudgetScenarios, calcMaxPurchasePrice } from '../src/core/economicsCalc';
import { buildConclusion } from '../src/core/verdict';
import { buildRiskFlags } from '../src/core/riskFlags';
import { rankCandidates } from '../src/core/wbSimilarity';
import { filterWbData } from '../src/core/wbFilter';
import { createStepProgress } from '../src/core/progress';
import { getUserTariffs } from '../src/db/queries/userSettings';
import { judgeCandidateBatch, repairSearch } from '../src/providers/productUnderstanding';
import { acquireStepLock, extendProcessingLock } from '../src/lib/stepLock';
import { buildCandidatePool, selectTopQueries } from '../src/core/querySelector';
import type { WbCard, WbSearchResult } from '../src/types';
import { fetchWbTrends, filterRelevantTrends, type WbTrend } from '../src/providers/wbconTrends';

export const config = { maxDuration: 60 };

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
const WB_PARSER_URL = process.env.WB_PARSER_URL || 'http://50fc4ca33bd1.vps.myjino.ru';
const WB_PARSER_SECRET = process.env.WB_PARSER_SECRET || 'cardzip-wb-2024';
const MAX_WB_QUERIES = 3;

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

async function searchWb(queries: string[]): Promise<{ cards: WbCard[]; seenUrls: Set<string> }> {
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
      console.warn(`[step3] WB search HTTP ${res.status}`);
      return { cards, seenUrls };
    }
    const data = await res.json() as any;
    for (const result of data.results ?? []) {
      for (const card of parseCards(result.products ?? [])) {
        if (!seenUrls.has(card.url)) { seenUrls.add(card.url); cards.push(card); }
      }
    }
  } catch (e: any) {
    console.warn('[step3] WB search failed:', e.message);
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

    // WBCON trends — параллельно
    const trendsPromise = wbCoreQuery
      ? fetchWbTrends(wbCoreQuery).catch(() => ({ query: wbCoreQuery, trends: [] as WbTrend[], latencyMs: 0 }))
      : Promise.resolve(null);

    const progress = job.tg_message_id
      ? createStepProgress(bot, job.tg_chat_id, job.tg_message_id, 'market')
      : null;

    // ─── WB Search Pipeline v2 ──────────────────────────────────────────
    let allCards: WbCard[] = [];
    let allQueries: string[] = [];
    let similarity: any = { buckets: { directLocalAnalogs: [], similarLocalProducts: [], crossBorderAnalogs: [], categoryOnly: [], wrong: [] }, confidence: 'no_market', leaders: [] };
    let wbSearchCount = 0;

    const wbSearchStart = Date.now();
    try {

    // 1. Собираем WBCON trends (уже запущен параллельно)
    const trendsResult = await trendsPromise;
    const materials = structure?.material ?? [];
    const productType = structure?.productType ?? '';
    const filteredTrends = trendsResult?.trends?.length
      ? filterRelevantTrends(trendsResult.trends, wbCoreQuery, productType, materials)
      : [];

    // 2. Строим пул кандидатов
    const pool = buildCandidatePool(
      queryPlan, validatedQueries, filteredTrends,
      structure, seoContent?.keywords ?? [],
    );

    // 3. Скоринг и выбор top queries
    const context = {
      coreObject: structure?.coreObject ?? '',
      productType: structure?.productType ?? '',
      audience: structure?.audience ?? '',
      materials: structure?.material ?? [],
      hardConflicts: structure?.hardConflicts ?? [],
      softConflicts: structure?.softConflicts ?? [],
      mustKeep: structure?.mustKeep ?? [],
      doNotSearch: structure?.doNotSearch ?? [],
    };
    const selected = selectTopQueries(pool, MAX_WB_QUERIES, context);
    const searchQueries = selected.map((c) => c.query);

    console.log(`[step3] Pool: ${pool.length} candidates → Selected: ${searchQueries.length} queries: ${searchQueries.join(' | ')}`);

    // 4. Один batch search
    if (searchQueries.length > 0) {
      const { cards, seenUrls } = await searchWb(searchQueries);
      allCards = cards;
      allQueries = searchQueries;
      wbSearchCount = searchQueries.length;

      console.log(`[step3] Search: ${allCards.length} cards from ${wbSearchCount} queries`);

      // 5. Rank
      let ranked = rankCandidates(allCards, structure, lexicon, allQueries);

      // 6. Repair (max 1 query, only if direct=0, within hard cap)
      if (ranked.buckets.directLocalAnalogs.length === 0 && structure && wbSearchCount < 5) {
        const rejected = ranked.buckets.wrong.slice(0, 5).map((c: any) => c.title);
        const found = ranked.buckets.similarLocalProducts.slice(0, 5).map((c: any) => c.title);
        const repair = await repairSearch(structure, allQueries, found, rejected, { tokens: [], bigrams: [] }).catch(() => ({ newQueries: [] as string[], reason: '' }));

        if (repair.newQueries.length) {
          const repairQ = repair.newQueries.slice(0, 1); // max 1
          console.log(`[step3] Repair: "${repairQ[0]}" (${repair.reason})`);
          const { cards: repairCards } = await searchWb(repairQ);
          for (const c of repairCards) {
            if (!seenUrls.has(c.url)) { seenUrls.add(c.url); allCards.push(c); }
          }
          allQueries.push(...repairQ);
          wbSearchCount += repairQ.length;
        }
      }

      // 7. Final ranking
      similarity = rankCandidates(allCards, structure, lexicon, allQueries);

      // 8. LLM Judge batch (borderline candidates)
      if (structure && similarity.buckets.directLocalAnalogs.length + similarity.buckets.similarLocalProducts.length > 0) {
        const borderline = [
          ...similarity.buckets.directLocalAnalogs.slice(0, 15),
          ...similarity.buckets.similarLocalProducts.slice(0, 10),
        ].filter((c: any) => c.similarity >= 35 && c.similarity <= 70).slice(0, 10);

        if (borderline.length > 0) {
          console.log(`[step3] LLM Judge: ${borderline.length} candidates`);
          const judgments = await judgeCandidateBatch(structure, borderline.map((c: any) => ({
            title: c.title, price: c.price,
            detectedConflicts: [...(c.hardConflictsFound ?? []), ...(c.softConflictsFound ?? [])],
          }))).catch(() => [] as any[]);

          if (judgments.length === borderline.length) {
            borderline.forEach((card: any, i: number) => {
              if (judgments[i]?.matchLevel) {
                card.matchLevel = judgments[i].matchLevel;
                card.matchedTerms = judgments[i].matchedAttributes ?? card.matchedTerms;
                card.missingTerms = judgments[i].missingAttributes ?? card.missingTerms;
              }
            });
            const all = [...similarity.buckets.directLocalAnalogs, ...similarity.buckets.similarLocalProducts, ...similarity.buckets.categoryOnly];
            similarity.buckets.directLocalAnalogs = all.filter((c: any) => c.matchLevel === 'direct_analog' && c.marketType !== 'crossborder_market').sort((a: any, b: any) => b.similarity - a.similarity);
            similarity.buckets.similarLocalProducts = all.filter((c: any) => c.matchLevel === 'similar' && c.marketType !== 'crossborder_market').sort((a: any, b: any) => b.similarity - a.similarity);
            similarity.buckets.categoryOnly = all.filter((c: any) => c.matchLevel === 'category_only');
          }
        }
      }

      console.log(`[step3] Final: direct=${similarity.buckets.directLocalAnalogs.length} similar=${similarity.buckets.similarLocalProducts.length} crossBorder=${similarity.buckets.crossBorderAnalogs.length} category=${similarity.buckets.categoryOnly.length} | ${wbSearchCount} WB queries | ${Date.now() - wbSearchStart}ms`);
    }

    } catch (wbErr: any) {
      console.error(`[step3] WB search failed after ${Date.now() - wbSearchStart}ms:`, wbErr.message);
    }

    // ─── Build WbData for economics (only LOCAL direct analogs) ─────────
    const directCards = similarity.buckets.directLocalAnalogs;
    const wbData: WbSearchResult | null = directCards.length > 0 ? {
      avgPrice: Math.round(directCards.reduce((s: number, c: any) => s + c.price, 0) / directCards.length),
      minPrice: Math.min(...directCards.map((c: any) => c.price)),
      maxPrice: Math.max(...directCards.map((c: any) => c.price)),
      totalCards: allCards.length,
      topExamples: directCards.slice(0, 3),
      allCards: directCards,
      photoSearchConfirmed: false,
    } : null;

    const filterKeywords = seoContent?.filterKeywords ?? { required: [], optional: [], exclude: [] };
    const wbFiltered = filterWbData(wbData, filterKeywords, allQueries);

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

    // ─── WBCON trends for display ───────────────────────────────────────
    const trendsResult2 = await trendsPromise;
    const wbTrends = trendsResult2?.trends?.length
      ? filterRelevantTrends(trendsResult2.trends, wbCoreQuery, structure?.productType ?? '', structure?.material ?? [])
      : [];

    // ─── Similarity data for display ────────────────────────────────────
    const similarityData = {
      queries: allQueries.filter((q: string) => /[а-яё]/i.test(q)).slice(0, 5),
      totalAnalyzed: allCards.length,
      directCount: similarity.buckets.directLocalAnalogs.length,
      similarCount: similarity.buckets.similarLocalProducts.length,
      crossBorderCount: similarity.buckets.crossBorderAnalogs.length,
      categoryCount: similarity.buckets.categoryOnly.length,
      confidence: similarity.confidence,
      leaders: (similarity.leaders ?? []).slice(0, 10).map((c: any) => ({
        title: c.title, price: c.price, url: c.url,
        rating: c.rating, feedbacks: c.feedbacks,
        similarity: c.similarity, matchLevel: c.matchLevel,
      })),
    };

    const debugTrace = {
      pipelineVersion: 'v2',
      poolSize: 0,
      selectedQueries: allQueries,
      wbSearchCount,
      totalCards: allCards.length,
      finalBuckets: {
        directLocal: similarity.buckets.directLocalAnalogs.length,
        similarLocal: similarity.buckets.similarLocalProducts.length,
        crossBorder: similarity.buckets.crossBorderAnalogs.length,
        category: similarity.buckets.categoryOnly.length,
        wrong: similarity.buckets.wrong.length,
      },
      confidence: similarity.confidence,
      wbSearchMs: Date.now() - wbSearchStart,
    };

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

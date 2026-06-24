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
import { expandQueries, judgeCandidate, validateQueries } from '../src/providers/productUnderstanding';
import { acquireStepLock, extendProcessingLock } from '../src/lib/stepLock';
import type { WbFilterKeywords, WbCard, WbSearchResult } from '../src/types';

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
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) return { cards, seenUrls };
    const data = await res.json() as any;

    for (const result of data.results ?? []) {
      for (const card of parseCards(result.products ?? [])) {
        if (!seenUrls.has(card.url)) { seenUrls.add(card.url); cards.push(card); }
      }
    }
  } catch (e: any) {
    console.warn('[step3] Batch search failed:', e.message);
    // Fallback: sequential single queries
    for (const query of queries.slice(0, 5)) {
      try {
        const params = new URLSearchParams({ secret: WB_PARSER_SECRET, query, limit: '100' });
        const res = await fetch(`${WB_PARSER_URL}/search-by-text?${params}`, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) continue;
        const data = await res.json() as any;
        for (const card of parseCards(data.products ?? [])) {
          if (!seenUrls.has(card.url)) { seenUrls.add(card.url); cards.push(card); }
        }
      } catch { continue; }
    }
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

    const progress = job.tg_message_id
      ? createStepProgress(bot, job.tg_chat_id, job.tg_message_id, 'market')
      : null;

    // ─── Запросы ─────────────────────────────────────────────────────────
    const pass1Queries = validatedQueries.length >= 3
      ? validatedQueries.slice(0, 8)
      : [seoContent?.titleRu, ...(seoContent?.keywords?.slice(0, 3) ?? [])].filter((q): q is string => !!q && /[а-яё]/i.test(q)).slice(0, 5);

    console.log(`[step3] PASS 1: ${pass1Queries.length} queries`);

    // ─── PASS 1 ──────────────────────────────────────────────────────────
    const { cards: pass1Cards, seenUrls } = await batchSearch(pass1Queries);
    console.log(`[step3] PASS 1 result: ${pass1Cards.length} unique cards`);

    // ─── WB Result Mining ────────────────────────────────────────────────
    const mining = mineResults(pass1Cards);

    // ─── Pre-score to decide on PASS 2 ──────────────────────────────────
    let allCards = [...pass1Cards];
    let preRank = rankCandidates(allCards, structure, lexicon, pass1Queries);

    // ─── PASS 2: Adaptive (only if direct < 10) ─────────────────────────
    if (preRank.buckets.directLocalAnalogs.length < 10 && structure) {
      const adaptiveQueries = await expandQueries(structure, mining.tokens, mining.bigrams).catch(() => [] as string[]);
      if (adaptiveQueries.length > 0) {
        console.log(`[step3] PASS 2: ${adaptiveQueries.length} adaptive queries`);
        const { cards: pass2Cards } = await batchSearch(adaptiveQueries);
        for (const card of pass2Cards) {
          if (!seenUrls.has(card.url)) { seenUrls.add(card.url); allCards.push(card); }
        }
        preRank = rankCandidates(allCards, structure, lexicon, [...pass1Queries, ...adaptiveQueries]);
        console.log(`[step3] After PASS 2: ${allCards.length} cards, direct=${preRank.buckets.directLocalAnalogs.length}`);
      }
    }

    // ─── FALLBACK: coreObject search (only if direct < 3) ───────────────
    if (preRank.buckets.directLocalAnalogs.length < 3 && structure?.coreObject) {
      const fbQueries = [
        structure.coreObject,
        structure.productType !== structure.coreObject ? structure.productType : null,
        ...(queryPlan?.fallbackQueries ?? []),
      ].filter((q): q is string => !!q && q.length > 2).slice(0, 4);

      console.log(`[step3] FALLBACK: ${fbQueries.join(' | ')}`);
      const { cards: fbCards } = await batchSearch(fbQueries);
      for (const card of fbCards) {
        if (!seenUrls.has(card.url)) { seenUrls.add(card.url); allCards.push(card); }
      }
    }

    // ─── Final ranking ───────────────────────────────────────────────────
    const similarity = rankCandidates(allCards, structure, lexicon, pass1Queries);

    // ─── LLM Judge for top-30 (only if structure available) ──────────────
    if (structure && similarity.buckets.directLocalAnalogs.length + similarity.buckets.similarLocalProducts.length > 0) {
      const topCandidates = [
        ...similarity.buckets.directLocalAnalogs.slice(0, 20),
        ...similarity.buckets.similarLocalProducts.slice(0, 10),
      ];

      // Judge only borderline candidates (skip obviously high scores)
      const borderline = topCandidates.filter(c => c.similarity >= 35 && c.similarity <= 70);
      if (borderline.length > 0 && borderline.length <= 15) {
        console.log(`[step3] LLM Judge: ${borderline.length} borderline candidates`);
        for (const card of borderline) {
          const judgment = await judgeCandidate(structure, {
            title: card.title, price: card.price,
            detectedConflicts: [...card.hardConflictsFound, ...card.softConflictsFound],
          }).catch(() => null);
          if (judgment) {
            card.matchLevel = judgment.matchLevel;
            card.matchedTerms = judgment.matchedAttributes;
            card.missingTerms = judgment.missingAttributes;
          }
        }
        // Re-sort local buckets after judge
        const all = [...similarity.buckets.directLocalAnalogs, ...similarity.buckets.similarLocalProducts, ...similarity.buckets.categoryOnly];
        similarity.buckets.directLocalAnalogs = all.filter(c => c.matchLevel === 'direct_analog' && c.marketType !== 'crossborder_market').sort((a, b) => b.similarity - a.similarity);
        similarity.buckets.similarLocalProducts = all.filter(c => c.matchLevel === 'similar' && c.marketType !== 'crossborder_market').sort((a, b) => b.similarity - a.similarity);
        similarity.buckets.categoryOnly = all.filter(c => c.matchLevel === 'category_only');
      }
    }

    console.log(`[step3] Final: directLocal=${similarity.buckets.directLocalAnalogs.length} similarLocal=${similarity.buckets.similarLocalProducts.length} crossBorder=${similarity.buckets.crossBorderAnalogs.length} category=${similarity.buckets.categoryOnly.length} confidence=${similarity.confidence}`);

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
      pass1Queries,
      pass1Cards: pass1Cards.length,
      mining: { tokens: mining.tokens.slice(0, 10), bigrams: mining.bigrams.slice(0, 5) },
      pass2Used: preRank.buckets.directLocalAnalogs.length < 10,
      fallbackUsed: preRank.buckets.directLocalAnalogs.length < 3,
      totalCards: allCards.length,
      finalBuckets: {
        directLocal: similarity.buckets.directLocalAnalogs.length,
        similarLocal: similarity.buckets.similarLocalProducts.length,
        crossBorder: similarity.buckets.crossBorderAnalogs.length,
        category: similarity.buckets.categoryOnly.length,
        wrong: similarity.buckets.wrong.length,
      },
      confidence: similarity.confidence,
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
    await supabase.from('jobs').update({ status: 'failed', error: e.message, finished_at: new Date().toISOString() }).eq('id', jobId);

    // Сообщаем пользователю об ошибке
    try {
      const { data: failedJob } = await supabase.from('jobs').select('tg_chat_id, tg_message_id, user_id').eq('id', jobId).single();
      if (failedJob) {
        if (failedJob.tg_message_id) {
          await bot.telegram.editMessageText(
            failedJob.tg_chat_id, failedJob.tg_message_id, undefined,
            '❌ Не удалось завершить анализ.\n\nПопробуйте ещё раз через минуту.\nКредит не списан.'
          ).catch(() => {});
        }
        // Снимаем processing lock
        const { redis: r } = require('../src/lib/redis');
        if (r) await r.del(`processing:${failedJob.user_id}`).catch(() => {});
      }
    } catch {}

    res.status(200).json({ ok: false });
  }
}

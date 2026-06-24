import type { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { supabase } from '../src/db/supabase';
import { calcEconomics, calcBudgetScenarios, calcMaxPurchasePrice } from '../src/core/economicsCalc';
import { buildConclusion } from '../src/core/verdict';
import { buildRiskFlags } from '../src/core/riskFlags';
import { filterWbData } from '../src/core/wbFilter';
import { createStepProgress } from '../src/core/progress';
import { getUserTariffs } from '../src/db/queries/userSettings';
import { scoreSimilarity } from '../src/core/wbSimilarity';
import { refineQueries } from '../src/providers/productUnderstanding';
import { acquireStepLock } from '../src/lib/stepLock';
import type { WbFilterKeywords, WbCard, WbSearchResult } from '../src/types';

export const config = { maxDuration: 60 };

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

const WB_PARSER_URL = process.env.WB_PARSER_URL || 'http://50fc4ca33bd1.vps.myjino.ru';
const WB_PARSER_SECRET = process.env.WB_PARSER_SECRET || 'cardzip-wb-2024';

// ─── Text Search через VPS (российский IP) ──────────────────────────────────

async function searchWbByText(query: string): Promise<WbCard[] | null> {
  try {
    const params = new URLSearchParams({ secret: WB_PARSER_SECRET, query, limit: '100' });
    const url = `${WB_PARSER_URL}/search-by-text?${params}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const data = await res.json() as any;
    if (!data.success || !data.products?.length) return null;

    return data.products.map((p: any) => ({
      title: p.name || '',
      price: p.price,
      url: `https://www.wildberries.ru/catalog/${p.id}/detail.aspx`,
      rating: p.rating || 0,
      feedbacks: p.feedbacks || 0,
    })).filter((c: WbCard) => c.price > 0);
  } catch (e: any) {
    console.warn(`[wb-text] "${query.slice(0, 30)}" failed:`, e.message);
    return null;
  }
}

const DEFAULT_FILTER_KEYWORDS: WbFilterKeywords = { required: [], optional: [], exclude: [] };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const { jobId } = req.body ?? {};
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  try {
    const { data: job } = await supabase.from('jobs').select('*').eq('id', jobId).single();
    if (!job || job.status !== 'ai_done') return res.status(200).json({ ok: true, skip: true });
    if (!await acquireStepLock('step3', jobId)) return res.status(200).json({ ok: true, skip: true });

    await supabase.from('jobs').update({ status: 'market_processing' }).eq('id', jobId);

    const raw = (job.result_json as any).rawProduct;
    const seoContent = (job.result_json as any).seoContent;

    const progress = job.tg_message_id
      ? createStepProgress(bot, job.tg_chat_id, job.tg_message_id, 'market')
      : null;

    // ─── ПОИСКОВЫЕ ЗАПРОСЫ: LLM Query Plan → fallback на старую логику ──
    const resultJson = job.result_json as any;
    const productStructure = resultJson.productStructure ?? null;
    const queryPlan = resultJson.queryPlan ?? null;
    const validatedQueries: string[] = resultJson.validatedQueries ?? [];

    const isRussian = (s: string) => /[а-яё]/i.test(s);

    let searchQueries: string[];
    if (validatedQueries.length >= 3) {
      // LLM-сгенерированные и провалидированные запросы
      searchQueries = validatedQueries.slice(0, 6);
      console.log(`[step3] Using LLM queries: ${searchQueries.join(' | ')}`);
    } else {
      // Fallback: старая логика
      const candidates = [
        seoContent?.titleRu,
        ...(seoContent?.searchQueries ?? []),
        ...(seoContent?.keywords?.slice(0, 3) ?? []),
      ].filter((q): q is string => !!q && q.length > 2 && isRussian(q));
      searchQueries = candidates.filter((q, i, arr) => arr.indexOf(q) === i).slice(0, 5);
      console.log(`[step3] Fallback queries: ${searchQueries.join(' | ')}`);
    }

    console.log(`[step3] Multi-search: ${searchQueries.length} queries via VPS`);

    const textResults = await Promise.all(
      searchQueries.map(q => searchWbByText(q))
    );

    // Собираем все карточки в единый пул (дедупликация по URL)
    const allCards: WbCard[] = [];
    const seenUrls = new Set<string>();
    for (const cards of textResults) {
      if (!cards) continue;
      for (const card of cards) {
        if (!seenUrls.has(card.url)) { seenUrls.add(card.url); allCards.push(card); }
      }
    }

    console.log(`[step3] Pass 1: ${allCards.length} unique cards from ${textResults.filter(Boolean).length} queries`);

    // ─── ВТОРОЙ ПРОХОД: Query Refiner (только если мало high) ──────────
    // Предварительный скоринг для проверки
    const preScore = scoreSimilarity(allCards, productStructure, queryPlan, searchQueries);
    if (productStructure && preScore.highCards.length < 10 && allCards.length > 0) {
      const topTitles = allCards.slice(0, 20).map(c => c.title);
      const refinedQueries = await refineQueries(productStructure, topTitles).catch(() => [] as string[]);

      if (refinedQueries.length > 0) {
        console.log(`[step3] Pass 2: ${refinedQueries.length} refined queries: ${refinedQueries.join(' | ')}`);
        const refinedResults = await Promise.all(
          refinedQueries.map(q => searchWbByText(q))
        );
        for (const cards of refinedResults) {
          if (!cards) continue;
          for (const card of cards) {
            if (!seenUrls.has(card.url)) { seenUrls.add(card.url); allCards.push(card); }
          }
        }
        console.log(`[step3] After pass 2: ${allCards.length} total unique cards`);
      }
    }

    // Скоринг — первый проход
    let similarity = scoreSimilarity(allCards, productStructure, queryPlan, searchQueries);

    // ─── FALLBACK SEARCH: если мало high-similarity, поиск по coreNoun ──
    if (similarity.highCards.length < 3 && productStructure?.coreNoun) {
      const fallbackQueries = [
        productStructure.coreNoun,
        productStructure.formFactor ? `${productStructure.coreNoun} ${productStructure.formFactor}` : null,
        productStructure.productType !== productStructure.coreNoun ? productStructure.productType : null,
      ].filter((q): q is string => !!q && q.length > 2);

      if (fallbackQueries.length) {
        console.log(`[step3] Fallback search (high=${similarity.highCards.length}): ${fallbackQueries.join(' | ')}`);
        const fallbackResults = await Promise.all(fallbackQueries.map(q => searchWbByText(q)));
        for (const cards of fallbackResults) {
          if (!cards) continue;
          for (const card of cards) {
            if (!seenUrls.has(card.url)) { seenUrls.add(card.url); allCards.push(card); }
          }
        }
        // Пересчитываем скоринг с расширенным пулом
        similarity = scoreSimilarity(allCards, productStructure, queryPlan, [...searchQueries, ...fallbackQueries]);
        console.log(`[step3] After fallback: ${allCards.length} cards, high=${similarity.highCards.length}`);
      }
    }

    // Экономика ТОЛЬКО по high similarity
    const relevantCards = similarity.highCards;

    const wbData: WbSearchResult | null = relevantCards.length > 0 ? {
      avgPrice: Math.round(relevantCards.reduce((s, c) => s + c.price, 0) / relevantCards.length),
      minPrice: Math.min(...relevantCards.map(c => c.price)),
      maxPrice: Math.max(...relevantCards.map(c => c.price)),
      totalCards: allCards.length,
      topExamples: similarity.highCards.slice(0, 3),
      allCards: relevantCards,
      photoSearchConfirmed: false,
    } : null;

    const filterKeywords = seoContent?.filterKeywords ?? DEFAULT_FILTER_KEYWORDS;
    const wbFiltered = filterWbData(wbData, filterKeywords, searchQueries);

    // Сохраняем similarity данные в result_json для вывода
    const similarityData = {
      queries: similarity.queries,
      totalAnalyzed: similarity.totalAnalyzed,
      highCount: similarity.highCards.length,
      mediumCount: similarity.mediumCards.length,
      marketStatus: similarity.marketStatus,
      leaders: similarity.leaders.slice(0, 10).map(c => ({
        title: c.title, price: c.price, url: c.url,
        rating: c.rating, feedbacks: c.feedbacks,
        similarity: c.similarity,
      })),
    };

    // Тарифы
    const userTariffs = await getUserTariffs(job.user_id).catch(() => null);

    // Экономика
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

    console.log(`[step3] WB: ${wbFiltered?.quality ?? 'null'} (${wbFiltered?.relevantCount ?? 0} relevant) | ${conclusion.icon} ${conclusion.headline.slice(0, 40)}`);

    await supabase.from('jobs').update({
      status: 'done',
      result_json: {
        ...(job.result_json as any),
        product: {
          ...raw,
          titleRu: seoContent?.titleRu ?? raw.titleEn ?? raw.titleCn,
          seoContent,
          wbData,
          wbFiltered,
          riskFlags,
          economics,
          budgets,
          maxPurchasePrice,
          conclusion,
          similarityData,
        },
      },
      finished_at: new Date().toISOString(),
    }).eq('id', jobId);

    // Chain → step4-send
    const host = req.headers.host || 'card-zip.vercel.app';
    let sent = false;
    for (let i = 0; i < 2 && !sent; i++) {
      try {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 4000);
        await fetch(`https://${host}/api/step4-send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId }),
          signal: ac.signal,
        });
        sent = true;
      } catch {
        if (i === 0) await new Promise(r => setTimeout(r, 500));
      }
    }

    if (!sent) {
      console.error(`[step3] Failed to trigger step4 for job ${jobId}`);
      if (job.tg_message_id) {
        await bot.telegram.editMessageText(
          job.tg_chat_id, job.tg_message_id, undefined,
          '❌ Не удалось отправить результат. Попробуйте ещё раз.',
          { parse_mode: 'HTML' }
        ).catch(() => {});
      }
    }

    res.status(200).json({ ok: true });
  } catch (e: any) {
    console.error('[step3]', e.message);
    await supabase.from('jobs').update({ status: 'failed', error: e.message, finished_at: new Date().toISOString() }).eq('id', jobId);
    res.status(200).json({ ok: false });
  }
}

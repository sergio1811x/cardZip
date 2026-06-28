import type { WbCard } from '../types';
import type { ProductStructure, ProductLexicon } from '../providers/productUnderstanding';
import { rankCandidates, type ScoredCard, type SimilarityResult } from './wbSimilarity';

export interface WbMarketSnapshot {
  directAnalogsCount: number;
  similarAnalogsCount: number;
  broadCategoryCount: number;
  crossBorderCount: number;
  marketConfirmed: boolean;
  displayedMainPriceRub: number | null;
  displayedMainPriceType: 'median' | 'average' | 'unknown';
  canUseForEconomics: boolean;
  rejectedReason?: string;
  directAnalogs: Array<{
    title: string;
    priceRub: number | null;
    matchLevel: 'direct' | 'similar' | 'category' | 'rejected';
    confidence: number;
    url?: string;
    evidence?: unknown;
  }>;
  diagnostics: {
    confidence: SimilarityResult['confidence'];
    totalAnalyzed: number;
    searchedQueries: string[];
    priceSampleSize: number;
    rejectedTopReasons: Array<{ reason: string; count: number }>;
  };
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function removeOutliers(prices: number[]): number[] {
  if (prices.length < 4) return prices;
  const sorted = [...prices].sort((a, b) => a - b);
  const p25 = percentile(sorted, 25) ?? sorted[0];
  const p75 = percentile(sorted, 75) ?? sorted[sorted.length - 1];
  const iqr = p75 - p25;
  if (iqr <= 0) return sorted;
  const lo = p25 - 1.5 * iqr;
  const hi = p75 + 1.5 * iqr;
  const filtered = sorted.filter((x) => x >= lo && x <= hi);
  return filtered.length ? filtered : sorted;
}

function mapCard(card: ScoredCard, matchLevel: 'direct' | 'similar' | 'category' | 'rejected') {
  return {
    title: card.title,
    priceRub: card.price > 0 ? card.price : null,
    matchLevel,
    confidence: card.similarity,
    url: card.url,
    evidence: card.evidence,
  };
}

function topRejectReasons(cards: ScoredCard[]): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const card of cards) {
    for (const reason of [...(card.hardConflictsFound ?? []), ...(card.softConflictsFound ?? [])]) {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([reason, count]) => ({ reason, count }));
}

export function buildWbMarketSnapshot(input: {
  cards: WbCard[];
  structure: ProductStructure | null;
  lexicon: ProductLexicon | null;
  queries: string[];
  queryTypeMap?: Map<string, string>;
}): WbMarketSnapshot {
  const ranked = rankCandidates(input.cards, input.structure, input.lexicon, input.queries, input.queryTypeMap);
  const direct = ranked.buckets.directLocalAnalogs.filter((card) => card.eligibleForEconomy && card.similarity >= 85 && card.price > 0);
  const prices = removeOutliers(direct.map((card) => card.price).filter((price) => price > 0)).sort((a, b) => a - b);
  const median = prices.length ? Math.round(percentile(prices, 50) ?? prices[0]) : null;

  const marketConfirmed = direct.length >= 3 && median !== null;
  let rejectedReason: string | undefined;
  if (!marketConfirmed) {
    if (direct.length === 0) rejectedReason = 'Не найдено прямых локальных аналогов WB с уверенностью 85%+.';
    else rejectedReason = 'Найдено меньше 3 прямых локальных аналогов WB; рынок недостаточно подтверждён для ROI.';
  }

  return {
    directAnalogsCount: direct.length,
    similarAnalogsCount: ranked.buckets.similarLocalProducts.length,
    broadCategoryCount: ranked.buckets.categoryOnly.length,
    crossBorderCount: ranked.buckets.crossBorderAnalogs.length,
    marketConfirmed,
    displayedMainPriceRub: marketConfirmed ? median : null,
    displayedMainPriceType: marketConfirmed ? 'median' : 'unknown',
    canUseForEconomics: marketConfirmed,
    rejectedReason,
    directAnalogs: [
      ...direct.slice(0, 10).map((card) => mapCard(card, 'direct')),
      ...ranked.buckets.similarLocalProducts.slice(0, 5).map((card) => mapCard(card, 'similar')),
      ...ranked.buckets.categoryOnly.slice(0, 3).map((card) => mapCard(card, 'category')),
    ],
    diagnostics: {
      confidence: ranked.confidence,
      totalAnalyzed: ranked.totalAnalyzed,
      searchedQueries: ranked.queries,
      priceSampleSize: prices.length,
      rejectedTopReasons: topRejectReasons([...ranked.buckets.wrong, ...ranked.buckets.categoryOnly]),
    },
  };
}

export { rankCandidates };

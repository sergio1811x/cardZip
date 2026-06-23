import type {
  WbSearchResult,
  WbFilteredResult,
  WbFilterKeywords,
  WbDataQuality,
  WbCard,
} from '../types';

// ─── IQR outlier filtering ──────────────────────────────────────────────────

function calcPercentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function removeOutliers(prices: number[]): number[] {
  if (prices.length < 4) return prices;
  const sorted = [...prices].sort((a, b) => a - b);
  const p25 = calcPercentile(sorted, 25);
  const p75 = calcPercentile(sorted, 75);
  const iqr = p75 - p25;
  const lower = p25 - 1.5 * iqr;
  const upper = p75 + 1.5 * iqr;
  return sorted.filter((p) => p >= lower && p <= upper);
}

// ─── Keyword filtering ──────────────────────────────────────────────────────

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^а-яёa-z0-9\s]/g, ' ');
}

function phraseMatches(text: string, phrase: string): boolean {
  const words = phrase.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  // Фраза считается совпавшей если хотя бы одно значимое слово (>3 букв) найдено
  const significantWords = words.filter((w) => w.length > 3);
  if (significantWords.length === 0) return words.some((w) => text.includes(w));
  return significantWords.some((w) => text.includes(w));
}

function matchesKeywords(title: string, keywords: WbFilterKeywords): boolean {
  const text = normalizeText(title);

  for (const exc of keywords.exclude) {
    if (phraseMatches(text, exc)) return false;
  }

  const hasRequired = keywords.required.length === 0 ||
    keywords.required.some((kw) => phraseMatches(text, kw));
  if (!hasRequired) return false;

  if (keywords.optional.length === 0) return true;

  const optionalMatches = keywords.optional.filter((kw) =>
    phraseMatches(text, kw)
  ).length;

  return optionalMatches >= 1;
}

export function filterCards(cards: WbCard[], keywords: WbFilterKeywords): WbCard[] {
  return cards.filter((card) => matchesKeywords(card.title, keywords));
}

// ─── Quality assessment ─────────────────────────────────────────────────────

function assessQuality(relevantCount: number, prices: number[]): WbDataQuality {
  if (relevantCount === 0) return 'unavailable';

  const sorted = [...prices].sort((a, b) => a - b);
  const ratio = sorted.length >= 2 ? sorted[sorted.length - 1] / sorted[0] : 1;
  const hasHugeSpread = ratio > 10;

  if (relevantCount >= 20 && !hasHugeSpread) return 'reliable';
  if (relevantCount >= 8) return 'limited';
  return 'unreliable';
}

// ─── Main filter function ───────────────────────────────────────────────────

export function filterWbData(
  raw: WbSearchResult | null,
  keywords: WbFilterKeywords,
  searchQueries: string[]
): WbFilteredResult | null {
  if (!raw || !raw.allCards.length) {
    return {
      quality: 'unavailable',
      medianPrice: 0,
      p25Price: 0,
      p75Price: 0,
      minPrice: 0,
      maxPrice: 0,
      relevantCount: 0,
      totalCount: raw?.totalCards ?? 0,
      totalFeedbacks: 0,
      avgRating: 0,
      topExamples: [],
      searchQueries,
      raw: raw ?? { avgPrice: 0, minPrice: 0, maxPrice: 0, totalCards: 0, topExamples: [], allCards: [], photoSearchConfirmed: false },
    };
  }

  const relevant = filterCards(raw.allCards, keywords);
  const relevantPrices = relevant.map((c) => c.price).filter((p) => p > 0);
  const quality = assessQuality(relevant.length, relevantPrices);

  if (relevantPrices.length === 0) {
    return {
      quality: 'unavailable',
      medianPrice: 0,
      p25Price: 0,
      p75Price: 0,
      minPrice: 0,
      maxPrice: 0,
      relevantCount: 0,
      totalCount: raw.totalCards,
      totalFeedbacks: 0,
      avgRating: 0,
      topExamples: [],
      searchQueries,
      raw,
    };
  }

  const cleaned = removeOutliers(relevantPrices);
  const sorted = [...cleaned].sort((a, b) => a - b);

  const medianPrice = Math.round(calcPercentile(sorted, 50));
  const p25Price = Math.round(calcPercentile(sorted, 25));
  const p75Price = Math.round(calcPercentile(sorted, 75));

  const topExamples = relevant
    .filter((c) => c.price >= p25Price && c.price <= p75Price)
    .slice(0, 3);

  if (topExamples.length < 3) {
    const remaining = relevant
      .filter((c) => !topExamples.includes(c))
      .sort((a, b) => Math.abs(a.price - medianPrice) - Math.abs(b.price - medianPrice));
    for (const card of remaining) {
      if (topExamples.length >= 3) break;
      topExamples.push(card);
    }
  }

  const totalFeedbacks = relevant.reduce((sum, c) => sum + c.feedbacks, 0);
  const ratingsWithValue = relevant.filter((c) => c.rating > 0);
  const avgRating = ratingsWithValue.length
    ? Math.round((ratingsWithValue.reduce((sum, c) => sum + c.rating, 0) / ratingsWithValue.length) * 10) / 10
    : 0;

  return {
    quality,
    medianPrice,
    p25Price,
    p75Price,
    minPrice: sorted[0],
    maxPrice: sorted[sorted.length - 1],
    relevantCount: relevant.length,
    totalCount: raw.totalCards,
    totalFeedbacks,
    avgRating,
    topExamples,
    searchQueries,
    raw,
  };
}

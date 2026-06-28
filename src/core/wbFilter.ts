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
  if (iqr <= 0) return sorted;
  const lower = p25 - 1.5 * iqr;
  const upper = p75 + 1.5 * iqr;
  const filtered = sorted.filter((p) => p >= lower && p <= upper);
  return filtered.length ? filtered : sorted;
}

// ─── Keyword filtering ──────────────────────────────────────────────────────

const STOPWORDS = new Set(['для', 'или', 'под', 'над', 'без', 'при', 'товар', 'набор', 'комплект', 'новый', 'топ', 'подарок']);

function normalizeText(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/[^а-яa-z0-9+\-\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitAlternatives(phrase: string): string[] {
  return normalizeText(phrase)
    .split(/\s*(?:\/|\\|,|;|\|| или | либо | and | or )\s*/i)
    .map((x) => x.trim())
    .filter(Boolean);
}

function significantWords(phrase: string): string[] {
  return normalizeText(phrase)
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

function wordMatches(text: string, word: string): boolean {
  if (word.length <= 3) return new RegExp(`(?:^|\\s)${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`).test(text);
  return text.includes(word);
}

export function phraseMatches(textRaw: string, phraseRaw: string): boolean {
  const text = normalizeText(textRaw);
  const alternatives = splitAlternatives(phraseRaw);
  if (!alternatives.length) return false;

  return alternatives.some((phrase) => {
    const words = significantWords(phrase);
    if (!words.length) return false;
    if (words.length === 1) return wordMatches(text, words[0]);

    const hits = words.filter((w) => wordMatches(text, w)).length;
    // Direct-фильтр должен быть строгим: 2 слова — оба; 3+ — можно потерять одно SEO/морфологическое слово.
    return hits === words.length || (words.length >= 3 && hits >= words.length - 1);
  });
}

function matchesAny(text: string, phrases: string[]): boolean {
  return phrases.some((kw) => phraseMatches(text, kw));
}

function matchesRequiredGroups(text: string, required: string[]): boolean {
  if (!required.length) return true;
  return required.every((group) => phraseMatches(text, group));
}

function matchesKeywords(title: string, keywords: WbFilterKeywords): boolean {
  const text = normalizeText(title);

  if (matchesAny(text, keywords.exclude ?? [])) return false;
  if (!matchesRequiredGroups(text, keywords.required ?? [])) return false;

  const optional = keywords.optional ?? [];
  if (!optional.length) return true;

  const optionalMatches = optional.filter((kw) => phraseMatches(text, kw)).length;
  return optionalMatches >= 1;
}

export function filterCards(cards: WbCard[], keywords: WbFilterKeywords): WbCard[] {
  return cards.filter((card) => matchesKeywords(card.title, keywords));
}

// ─── Quality assessment ─────────────────────────────────────────────────────

function assessQuality(relevantCount: number, prices: number[]): WbDataQuality {
  if (relevantCount === 0 || prices.length === 0) return 'unavailable';

  const sorted = [...prices].sort((a, b) => a - b);
  const ratio = sorted.length >= 2 ? sorted[sorted.length - 1] / sorted[0] : 1;
  const hasHugeSpread = ratio > 6;

  if (relevantCount >= 15 && !hasHugeSpread) return 'reliable';
  if (relevantCount >= 5 && !hasHugeSpread) return 'limited';
  return 'unreliable';
}

// ─── Main filter function ───────────────────────────────────────────────────

export function filterWbData(
  raw: WbSearchResult | null,
  keywords: WbFilterKeywords,
  searchQueries: string[],
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
  const relevantPrices = relevant.map((c) => c.price).filter((p) => Number.isFinite(p) && p > 0);
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
    .sort((a, b) => Math.abs(a.price - medianPrice) - Math.abs(b.price - medianPrice))
    .slice(0, 5);

  if (topExamples.length < 5) {
    const remaining = relevant
      .filter((c) => !topExamples.includes(c))
      .sort((a, b) => Math.abs(a.price - medianPrice) - Math.abs(b.price - medianPrice));
    for (const card of remaining) {
      if (topExamples.length >= 5) break;
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

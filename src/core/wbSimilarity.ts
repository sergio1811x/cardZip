import type { WbCard, MarketType } from '../types';
import type { ProductStructure, ProductLexicon, MatchLevel } from '../providers/productUnderstanding';

export interface ScoredCard extends WbCard {
  price: number;
  rating: number;
  feedbacks: number;
  marketType?: MarketType;
  similarity: number;
  matchLevel: MatchLevel;
  eligibleForEconomy: boolean;
  matchedTerms: string[];
  missingTerms: string[];
  hardConflictsFound: string[];
  softConflictsFound: string[];
  queryHits: Array<{ query: string; queryType: string }>;
}

export interface MatchBuckets {
  directLocalAnalogs: ScoredCard[];
  similarLocalProducts: ScoredCard[];
  crossBorderAnalogs: ScoredCard[];
  categoryOnly: ScoredCard[];
  wrong: ScoredCard[];
}

export interface SimilarityResult {
  queries: string[];
  totalAnalyzed: number;
  buckets: MatchBuckets;
  leaders: ScoredCard[];
  confidence: 'high' | 'medium' | 'low' | 'crossborder_only' | 'category_only' | 'no_market';
}

function norm(text: string): string {
  return text.toLowerCase().replace(/ё/g, 'е').replace(/[^а-яa-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function hasAny(text: string, terms: string[] | undefined): boolean {
  if (!terms?.length) return false;
  return terms.some(t => t.length > 1 && text.includes(t.toLowerCase()));
}

function findMatches(text: string, terms: string[] | undefined): string[] {
  if (!terms?.length) return [];
  return terms.filter(t => t.length > 1 && text.includes(t.toLowerCase()));
}

// ─── Score a single candidate ────────────────────────────────────────────────

function scoreCandidate(
  title: string,
  structure: ProductStructure,
  lexicon: ProductLexicon,
  queryInfo?: { query: string; queryType: string }
): { score: number; matchLevel: MatchLevel; matched: string[]; missing: string[]; hardFound: string[]; softFound: string[] } {
  const text = norm(title);
  const matched: string[] = [];
  const missing: string[] = [];

  // ─── HARD FILTERS ──────────────────────────────────────────────────────
  const hardFound = findMatches(text, [...(structure.hardConflicts ?? []), ...(lexicon.hardNegativeTerms ?? [])]);
  if (hardFound.length > 0) {
    return { score: 0, matchLevel: 'wrong', matched, missing, hardFound, softFound: [] };
  }

  // coreObject или alternateName обязателен
  const coreMatch = text.includes(structure.coreObject.toLowerCase());
  const altMatch = hasAny(text, lexicon.alternateNames);
  const mainMatch = hasAny(text, lexicon.mainTerms);
  if (!coreMatch && !altMatch && !mainMatch) {
    return { score: 0, matchLevel: 'wrong', matched, missing, hardFound: [], softFound: [] };
  }

  // Soft conflicts
  const softFound = findMatches(text, [...(structure.softConflicts ?? []), ...(lexicon.softNegativeTerms ?? [])]);

  // ─── SCORING ───────────────────────────────────────────────────────────
  let score = 0;

  // Object match (+30)
  if (coreMatch) { matched.push(structure.coreObject); score += 30; }
  else if (altMatch) { score += 25; }
  else { score += 20; }

  // ProductType match (+25)
  if (text.includes(structure.productType.toLowerCase())) {
    matched.push(structure.productType);
    score += 25;
  }

  // Required attributes (+15 each)
  for (const attr of (structure.requiredAttributes ?? [])) {
    const terms = attr.split('/').map(t => t.trim().toLowerCase());
    if (terms.some(t => text.includes(t))) {
      matched.push(attr);
      score += 15;
    } else {
      missing.push(attr);
    }
  }

  // Important attributes (+8 each, max 24)
  let impScore = 0;
  for (const attr of (structure.importantAttributes ?? [])) {
    const terms = attr.split('/').map(t => t.trim().toLowerCase());
    if (terms.some(t => text.includes(t))) {
      matched.push(attr);
      impScore += 8;
    }
  }
  score += Math.min(24, impScore);

  // Compatible alternatives bonus (+10)
  if (hasAny(text, structure.compatibleAlternatives)) score += 10;

  // Material match (+5)
  if (hasAny(text, [...(structure.material ?? []), ...(lexicon.materialAliases ?? [])])) score += 5;

  // FormFactor match (+10) or conflict (-15)
  if ((structure.formFactor ?? []).length > 0) {
    if (hasAny(text, structure.formFactor)) {
      score += 10;
    }
  }

  // Audience match (+5) or conflict
  if (structure.audience) {
    const audienceConflict =
      (structure.audience === 'мужской' && /женск/i.test(text)) ||
      (structure.audience === 'женский' && /мужск/i.test(text)) ||
      (structure.audience !== 'детский' && /детск/i.test(text));
    if (audienceConflict) {
      return { score: 0, matchLevel: 'wrong', matched, missing, hardFound: ['audience conflict'], softFound };
    }
    if (text.includes(structure.audience.toLowerCase())) score += 5;
  }

  // Soft conflict penalty
  if (softFound.length > 0) score -= 10;

  // ─── SUBTYPE / FORM CONFLICTS ──────────────────────────────────────────
  // hardFormConflicts → cannot be direct_analog
  const hardFormFound = findMatches(text, structure.hardFormConflicts ?? []);
  if (hardFormFound.length > 0) {
    return { score: 0, matchLevel: 'wrong', matched, missing, hardFound: hardFormFound, softFound };
  }

  // softFormConflicts → max similar, not direct
  const softFormFound = findMatches(text, structure.softFormConflicts ?? []);
  let hasSubTypeConflict = softFormFound.length > 0;

  // lengthClass conflict: short vs long
  if (structure.lengthClass && structure.lengthClass !== 'unknown') {
    const longMarkers = ['длинн', 'long', 'travel', 'для документов', 'органайзер', 'на молнии'];
    const shortMarkers = ['коротк', 'компактн', 'мини', 'small', 'bifold'];
    if (structure.lengthClass === 'short' && hasAny(text, longMarkers)) hasSubTypeConflict = true;
    if (structure.lengthClass === 'long' && hasAny(text, shortMarkers)) hasSubTypeConflict = true;
  }

  // shapeType conflict
  if (structure.shapeType && structure.shapeType !== 'unknown') {
    const clutchMarkers = ['клатч', 'clutch', 'с ремешком', 'на запястье'];
    const docMarkers = ['для документов', 'для паспорта', 'travel', 'органайзер'];
    if (['bifold', 'trifold', 'short'].includes(structure.shapeType)) {
      if (hasAny(text, [...clutchMarkers, ...docMarkers])) hasSubTypeConflict = true;
    }
  }

  // Query type bonus
  if (queryInfo?.queryType === 'exact') score += 5;
  else if (queryInfo?.queryType === 'synonym') score += 3;

  score = Math.max(0, Math.min(100, score));

  // ─── MATCH LEVEL ───────────────────────────────────────────────────────
  const requiredMet = missing.length === 0 || ((structure.requiredAttributes ?? []).length > 0 && missing.length < (structure.requiredAttributes ?? []).length);
  let matchLevel: MatchLevel;

  if (score >= 60 && requiredMet && softFound.length === 0 && !hasSubTypeConflict) {
    matchLevel = 'direct_analog';
  } else if (score >= 40 && (coreMatch || altMatch)) {
    matchLevel = hasSubTypeConflict || softFound.length > 0 ? 'similar' : (requiredMet ? 'direct_analog' : 'similar');
  } else if (score >= 20) {
    matchLevel = 'category_only';
  } else {
    matchLevel = 'wrong';
  }

  // Fallback-only source cannot be direct without required attributes
  if (queryInfo?.queryType === 'fallback' && matchLevel === 'direct_analog' && missing.length > 0) {
    matchLevel = 'similar';
  }

  return { score, matchLevel, matched, missing, hardFound, softFound };
}

// ─── Main scoring function ───────────────────────────────────────────────────

export function rankCandidates(
  cards: WbCard[],
  structure: ProductStructure | null,
  lexicon: ProductLexicon | null,
  queries: string[],
  queryTypeMap?: Map<string, string>
): SimilarityResult {
  // Dedup by URL
  const seen = new Set<string>();
  const unique = cards.filter(c => {
    if (seen.has(c.url)) return false;
    seen.add(c.url);
    return true;
  });

  if (!structure || !lexicon) {
    const scored: ScoredCard[] = unique.map(c => ({
      ...c, price: Number((c as any).price ?? 0) || 0, rating: Number((c as any).rating ?? 0) || 0, feedbacks: Number((c as any).feedbacks ?? 0) || 0, similarity: 20, matchLevel: 'category_only' as MatchLevel, eligibleForEconomy: false,
      matchedTerms: [], missingTerms: [], hardConflictsFound: [], softConflictsFound: [], queryHits: [],
    }));
    return {
      queries, totalAnalyzed: unique.length,
      buckets: { directLocalAnalogs: [], similarLocalProducts: [], crossBorderAnalogs: [], categoryOnly: scored, wrong: [] },
      leaders: scored.sort((a, b) => b.feedbacks - a.feedbacks).slice(0, 10),
      confidence: scored.length >= 20 ? 'category_only' : 'no_market',
    };
  }

  const scored: ScoredCard[] = unique.map(card => {
    const qType = queryTypeMap?.get(card.url);
    const r = scoreCandidate(card.title, structure, lexicon, qType ? { query: '', queryType: qType } : undefined);
    const isLocal = card.marketType === 'local_wb_market';
    const isCrossBorder = card.marketType === 'crossborder_market';
    return {
      ...card,
      price: Number((card as any).price ?? 0) || 0,
      rating: Number((card as any).rating ?? 0) || 0,
      feedbacks: Number((card as any).feedbacks ?? 0) || 0,
      marketType: (card as any).marketType,
      similarity: r.score,
      matchLevel: r.matchLevel,
      eligibleForEconomy: isLocal && (r.matchLevel === 'direct_analog'),
      matchedTerms: r.matched,
      missingTerms: r.missing,
      hardConflictsFound: r.hardFound,
      softConflictsFound: r.softFound,
      queryHits: [],
    };
  });

  // Разделяем на корзины: local vs crossborder
  const directAll = scored.filter(c => c.matchLevel === 'direct_analog').sort((a, b) => b.similarity - a.similarity);
  const similarAll = scored.filter(c => c.matchLevel === 'similar').sort((a, b) => b.similarity - a.similarity);

  const buckets: MatchBuckets = {
    directLocalAnalogs: directAll.filter(c => c.marketType !== 'crossborder_market'),
    similarLocalProducts: similarAll.filter(c => c.marketType !== 'crossborder_market'),
    crossBorderAnalogs: [...directAll, ...similarAll].filter(c => c.marketType === 'crossborder_market'),
    categoryOnly: scored.filter(c => c.matchLevel === 'category_only'),
    wrong: scored.filter(c => c.matchLevel === 'wrong'),
  };

  // Leaders: only local, seller-dedup
  const leaderCandidates = [...buckets.directLocalAnalogs, ...buckets.similarLocalProducts];
  const leaders: ScoredCard[] = [];
  const seenSellers = new Set<number>();
  for (const card of leaderCandidates.sort((a, b) => {
    const sa = a.similarity * 0.6 + Math.log(Math.max(a.feedbacks, 1)) * 10 * 0.25 + a.rating * 20 * 0.15;
    const sb = b.similarity * 0.6 + Math.log(Math.max(b.feedbacks, 1)) * 10 * 0.25 + b.rating * 20 * 0.15;
    return sb - sa;
  })) {
    const key = card.price * 1000 + card.feedbacks;
    if (seenSellers.has(key)) continue;
    seenSellers.add(key);
    leaders.push(card);
    if (leaders.length >= 10) break;
  }

  // Confidence: only by directLocalAnalogs
  const dc = buckets.directLocalAnalogs.length;
  const cb = buckets.crossBorderAnalogs.length;
  const cc = buckets.categoryOnly.length;
  let confidence: SimilarityResult['confidence'];
  if (dc >= 10) confidence = 'high';
  else if (dc >= 3) confidence = 'medium';
  else if (dc >= 1) confidence = 'low';
  else if (cb > 0) confidence = 'crossborder_only' as any;
  else if (cc >= 20) confidence = 'category_only';
  else confidence = 'no_market';

  return { queries, totalAnalyzed: unique.length, buckets, leaders, confidence };
}

// ─── WB Result Mining ────────────────────────────────────────────────────────

export function mineResults(cards: WbCard[]): { tokens: string[]; bigrams: string[]; categories: string[] } {
  const freq = new Map<string, number>();
  const bigramFreq = new Map<string, number>();

  for (const card of cards.slice(0, 100)) {
    const words = norm(card.title).split(/\s+/).filter(w => w.length > 2);
    for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
    for (let i = 0; i < words.length - 1; i++) {
      const bg = `${words[i]} ${words[i + 1]}`;
      bigramFreq.set(bg, (bigramFreq.get(bg) ?? 0) + 1);
    }
  }

  return {
    tokens: [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(e => e[0]),
    bigrams: [...bigramFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(e => e[0]),
    categories: [],
  };
}

// Legacy compat
export { rankCandidates as scoreSimilarity };

import type { WbCard } from '../types';
import type { ProductStructure, ProductLexicon, MatchLevel } from '../providers/productUnderstanding';

export interface MatchEvidence {
  objectScore: number;
  titleScore: number;
  requiredScore: number;
  attributeScore: number;
  visualScore: number;
  queryScore: number;
  commercialScore: number;
  penalties: number;
  matchedGroups: string[];
  missingGroups: string[];
  rejectReasons: string[];
  warnings: string[];
}

export interface ScoredCard extends WbCard {
  similarity: number;
  matchLevel: MatchLevel;
  eligibleForEconomy: boolean;
  matchedTerms: string[];
  missingTerms: string[];
  hardConflictsFound: string[];
  softConflictsFound: string[];
  queryHits: Array<{ query: string; queryType: string }>;
  evidence?: MatchEvidence;
  matchConfidence?: number;
  marketUse?: 'economics' | 'reference_only' | 'blocked';
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

type QueryInfo = { query: string; queryType: string };

type UnknownRecord = Record<string, unknown>;

const DIRECT_THRESHOLD = 85;
const BORDERLINE_THRESHOLD = 70;
const SIMILAR_THRESHOLD = 50;

const GENERIC_STOPWORDS = new Set([
  'для', 'под', 'над', 'без', 'при', 'или', 'это', 'как', 'the', 'and', 'with', 'from', 'набор', 'комплект',
  'товар', 'новый', 'новинка', 'топ', 'лучший', 'подарок', 'универсальный', 'премиум', 'premium', 'sale',
]);

const DEFAULT_HARD_NEGATIVES = [
  'запчасть', 'аксессуар для', 'чехол для', 'насадка', 'держатель для', 'ремкомплект', 'ремонтный комплект',
  'игрушечный', 'сувенир', 'брелок', 'наклейка', 'стикер', 'книга', 'инструкция', 'выкройка', 'обложка',
];

const LOCAL_MARKET_VALUES = new Set(['local_wb_market', 'local_wb', 'wb_local', 'local', 'wildberries']);
const CROSS_BORDER_VALUES = new Set(['crossborder_market', 'crossborder', 'cross_border', 'china', 'global']);

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {};
}

function safeText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function norm(text: unknown): string {
  return safeText(text)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/[^а-яa-z0-9+\-\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function words(text: string): string[] {
  return norm(text).split(/\s+/).filter((w) => w.length > 1 && !GENERIC_STOPWORDS.has(w));
}

function uniq(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const v = raw.trim();
    const key = norm(v);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function splitAlternatives(phrase: unknown): string[] {
  const raw = safeText(phrase);
  if (!raw) return [];
  const parts = raw
    .split(/\s*(?:\/|\\|,|;|\|| или | либо | and | or )\s*/i)
    .map(norm)
    .filter(Boolean);
  return uniq(parts);
}

function normalizeTerms(terms: unknown): string[] {
  if (!Array.isArray(terms)) return [];
  return uniq(terms.flatMap(splitAlternatives));
}

function termMatches(text: string, term: string): boolean {
  const t = norm(term);
  if (!t) return false;
  const tw = words(t);
  if (tw.length === 0) return false;
  if (tw.length === 1) {
    const token = tw[0];
    if (token.length <= 3) return new RegExp(`(?:^|\\s)${escapeRegExp(token)}(?:\\s|$)`).test(text);
    return text.includes(token);
  }
  const significant = tw.filter((w) => w.length > 2);
  if (significant.length <= 1) return significant.every((w) => text.includes(w));
  const hits = significant.filter((w) => text.includes(w)).length;
  return hits === significant.length || (significant.length >= 3 && hits >= significant.length - 1);
}

function groupMatches(text: string, alternatives: string[]): boolean {
  return alternatives.some((term) => termMatches(text, term));
}

function findMatches(text: string, terms: unknown): string[] {
  return normalizeTerms(terms).filter((term) => termMatches(text, term));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function numeric(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(n: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, n));
}

function readCardId(card: WbCard): string {
  const anyCard = card as WbCard & UnknownRecord;
  const id = safeText(anyCard.id ?? anyCard.nmId ?? anyCard.article);
  if (id) return id;
  const url = safeText(card.url);
  return url.match(/catalog\/(\d+)/)?.[1] ?? `${norm(card.title)}|${card.price}`;
}

function isCrossBorder(card: WbCard): boolean {
  const anyCard = card as WbCard & UnknownRecord;
  const raw = norm(anyCard.marketType ?? anyCard.market ?? anyCard.deliveryType ?? anyCard.sourceMarket);
  if (!raw) return false;
  if (CROSS_BORDER_VALUES.has(raw)) return true;
  return /cross\s*border|кросс.?бордер|доставка\s+из\s+китая|china|global/.test(raw);
}

function isLocalMarket(card: WbCard): boolean {
  const anyCard = card as WbCard & UnknownRecord;
  const raw = norm(anyCard.marketType ?? anyCard.market ?? anyCard.deliveryType ?? anyCard.sourceMarket);
  if (!raw) return true;
  if (LOCAL_MARKET_VALUES.has(raw)) return true;
  if (isCrossBorder(card)) return false;
  return true;
}

function getSourceHits(card: WbCard, queryInfo?: QueryInfo): QueryInfo[] {
  const anyCard = card as WbCard & UnknownRecord;
  const hits: QueryInfo[] = [];
  const rawHits = Array.isArray(anyCard.queryHits) ? anyCard.queryHits : Array.isArray(anyCard.sourceHits) ? anyCard.sourceHits : [];
  for (const item of rawHits) {
    const obj = asRecord(item);
    const query = safeText(obj.query);
    const queryType = safeText(obj.queryType ?? obj.source ?? obj.level);
    if (query || queryType) hits.push({ query, queryType });
  }
  if (queryInfo) hits.push(queryInfo);
  return hits;
}

function getQueryType(card: WbCard, queryInfo?: QueryInfo): string {
  const hits = getSourceHits(card, queryInfo);
  const order = ['L1_exact', 'exact', 'image', 'photo', 'L2_commercial', 'synonym', 'market_synonym', 'L3_subtype', 'L4_core', 'seo_keyword', 'repair', 'fallback', 'L5_category', 'category'];
  for (const preferred of order) {
    if (hits.some((h) => norm(h.queryType) === norm(preferred))) return preferred;
  }
  return safeText(queryInfo?.queryType) || '';
}

function inferVisualScore(card: WbCard, queryType: string): number {
  const anyCard = card as WbCard & UnknownRecord;
  const candidates = [
    anyCard.visualSimilarity,
    anyCard.imageSimilarity,
    anyCard.photoSimilarity,
    anyCard.imageScore,
    anyCard.visualScore,
  ];
  for (const value of candidates) {
    const n = numeric(value);
    if (n === null) continue;
    if (n > 0 && n <= 1) return clamp(Math.round(n * 30), 0, 30);
    return clamp(Math.round(n > 30 ? n * 0.3 : n), 0, 30);
  }
  const rank = numeric(anyCard.photoRank ?? anyCard.imageRank ?? anyCard.rank);
  const q = norm(queryType);
  if (/image|photo/.test(q)) {
    if (rank !== null && rank > 0) {
      if (rank <= 3) return 25;
      if (rank <= 10) return 21;
      if (rank <= 30) return 16;
    }
    return 20;
  }
  return 0;
}

function buildRequiredGroups(structure: ProductStructure, lexicon: ProductLexicon): string[][] {
  const groups: string[][] = [];
  const core = uniq([
    ...splitAlternatives((structure as any).coreObject),
    ...normalizeTerms((lexicon as any).mainTerms),
    ...normalizeTerms((lexicon as any).alternateNames),
  ]).filter((t) => words(t).length > 0);
  if (core.length) groups.push(core);

  for (const attr of ((structure as any).requiredAttributes ?? []) as unknown[]) {
    const group = splitAlternatives(attr);
    if (group.length) groups.push(group);
  }

  return groups;
}

function scoreObject(text: string, structure: ProductStructure, lexicon: ProductLexicon, matched: string[]): number {
  const coreObject = norm((structure as any).coreObject);
  const productType = norm((structure as any).productType);
  const alt = normalizeTerms((lexicon as any).alternateNames);
  const main = normalizeTerms((lexicon as any).mainTerms);

  if (coreObject && termMatches(text, coreObject)) {
    matched.push((structure as any).coreObject);
    return 20;
  }
  const altHit = alt.find((t) => termMatches(text, t));
  if (altHit) {
    matched.push(altHit);
    return 18;
  }
  const mainHit = main.find((t) => termMatches(text, t));
  if (mainHit) {
    matched.push(mainHit);
    return 16;
  }
  if (productType && termMatches(text, productType)) {
    matched.push((structure as any).productType);
    return 12;
  }
  return 0;
}

function scoreTitle(text: string, structure: ProductStructure, lexicon: ProductLexicon, matched: string[]): number {
  const candidates = uniq([
    ...splitAlternatives((structure as any).productType),
    ...normalizeTerms((structure as any).compatibleAlternatives),
    ...normalizeTerms((lexicon as any).semanticModifiers),
    ...normalizeTerms((lexicon as any).marketSynonyms),
  ]);
  const hits = candidates.filter((term) => termMatches(text, term));
  matched.push(...hits.slice(0, 6));
  return clamp(hits.length * 4, 0, 15);
}

function scoreRequiredGroups(text: string, groups: string[][], matched: string[], missing: string[]): number {
  if (!groups.length) return 12;
  let met = 0;
  groups.forEach((group, idx) => {
    if (groupMatches(text, group)) {
      met += 1;
      const hit = group.find((term) => termMatches(text, term));
      if (hit) matched.push(hit);
    } else {
      missing.push(group.join('/'));
    }
  });
  return clamp(Math.round((met / groups.length) * 15), 0, 15);
}

function scoreAttributes(text: string, structure: ProductStructure, lexicon: ProductLexicon, matched: string[]): number {
  const important = normalizeTerms((structure as any).importantAttributes);
  const material = uniq([
    ...normalizeTerms((structure as any).material),
    ...normalizeTerms((lexicon as any).materialAliases),
  ]);
  const form = normalizeTerms((structure as any).formFactor);
  const useCases = normalizeTerms((structure as any).useCases);

  let score = 0;
  for (const term of important) {
    if (termMatches(text, term)) { score += 3; matched.push(term); }
  }
  for (const term of material) {
    if (termMatches(text, term)) { score += 4; matched.push(term); break; }
  }
  for (const term of form) {
    if (termMatches(text, term)) { score += 5; matched.push(term); break; }
  }
  for (const term of useCases) {
    if (termMatches(text, term)) { score += 2; matched.push(term); }
  }

  const anyStructure = structure as any;
  const audience = norm(anyStructure.audience);
  if (audience && termMatches(text, audience)) score += 2;

  return clamp(score, 0, 25);
}

function scoreQuerySource(queryType: string): number {
  const q = norm(queryType);
  if (q === 'l1_exact' || q === 'exact') return 10;
  if (q === 'image' || q === 'photo') return 9;
  if (q === 'l2_commercial' || q === 'synonym' || q === 'market_synonym') return 7;
  if (q === 'l3_subtype') return 5;
  if (q === 'l4_core' || q === 'repair') return 3;
  if (q === 'seo_keyword') return 1;
  if (q === 'l5_category' || q === 'category' || q === 'fallback') return -8;
  return 0;
}

function scoreCommercial(card: WbCard): number {
  const rating = numeric((card as any).rating) ?? 0;
  const feedbacks = numeric((card as any).feedbacks) ?? 0;
  let score = 0;
  if (rating >= 4.7 && feedbacks >= 30) score += 3;
  else if (rating >= 4.3 && feedbacks >= 10) score += 2;
  else if (feedbacks > 0) score += 1;
  return score;
}

function detectConflicts(text: string, structure: ProductStructure, lexicon: ProductLexicon): { hard: string[]; soft: string[]; penalties: number } {
  const hard = uniq([
    ...findMatches(text, DEFAULT_HARD_NEGATIVES),
    ...findMatches(text, (structure as any).hardConflicts),
    ...findMatches(text, (structure as any).hardFormConflicts),
    ...findMatches(text, (lexicon as any).hardNegativeTerms),
  ]);
  const soft = uniq([
    ...findMatches(text, (structure as any).softConflicts),
    ...findMatches(text, (structure as any).softFormConflicts),
    ...findMatches(text, (lexicon as any).softNegativeTerms),
  ]);

  const audience = norm((structure as any).audience);
  if (audience === 'мужской' && /женск/.test(text)) hard.push('audience_conflict:female');
  if (audience === 'женский' && /мужск/.test(text)) hard.push('audience_conflict:male');
  if (audience && audience !== 'детский' && /детск|ребен/.test(text)) soft.push('possible_age_group_conflict');

  const lengthClass = safeText((structure as any).lengthClass);
  if (lengthClass && lengthClass !== 'unknown') {
    if (lengthClass === 'short' && /(длинн|для документов|органайзер|travel|на молнии)/.test(text)) soft.push('length_class_conflict');
    if (lengthClass === 'long' && /(коротк|компактн|мини|bifold)/.test(text)) soft.push('length_class_conflict');
  }

  return { hard: uniq(hard), soft: uniq(soft), penalties: hard.length * 100 + soft.length * 10 };
}

function scoreCandidate(
  card: WbCard,
  structure: ProductStructure,
  lexicon: ProductLexicon,
  queryInfo?: QueryInfo,
): { score: number; matchLevel: MatchLevel; matched: string[]; missing: string[]; hardFound: string[]; softFound: string[]; evidence: MatchEvidence } {
  const text = norm(`${card.title} ${(card as any).brand ?? ''} ${(card as any).subjectName ?? ''} ${(card as any).categoryName ?? ''}`);
  const matched: string[] = [];
  const missing: string[] = [];
  const queryType = getQueryType(card, queryInfo);
  const requiredGroups = buildRequiredGroups(structure, lexicon);
  const conflicts = detectConflicts(text, structure, lexicon);
  const warnings: string[] = [];

  const objectScore = scoreObject(text, structure, lexicon, matched);
  const titleScore = scoreTitle(text, structure, lexicon, matched);
  const requiredScore = scoreRequiredGroups(text, requiredGroups, matched, missing);
  const attributeScore = scoreAttributes(text, structure, lexicon, matched);
  const visualScore = inferVisualScore(card, queryType);
  const queryScore = scoreQuerySource(queryType);
  const commercialScore = scoreCommercial(card);

  if (isCrossBorder(card)) conflicts.soft.push('crossborder_not_for_local_economics');
  if (!numeric(card.price) || Number(card.price) <= 0) conflicts.hard.push('invalid_price');
  if (objectScore <= 0) conflicts.hard.push('core_object_not_found');

  const requiredMet = missing.length === 0;
  const weakRequired = requiredGroups.length > 0 && requiredScore < 10;
  const categorySource = /l5_category|category|fallback/.test(norm(queryType));

  let rawScore = objectScore + titleScore + requiredScore + attributeScore + visualScore + queryScore + commercialScore - conflicts.penalties;

  // Если карточка пришла только из широкой категории, запрещаем высокий score без сильного визуального/атрибутного подтверждения.
  if (categorySource && visualScore < 24 && attributeScore < 18) {
    rawScore = Math.min(rawScore, 69);
    warnings.push('category_source_needs_strong_visual_or_attributes');
  }

  // Без полного required-покрытия нельзя получить direct, даже если заголовок похож.
  if (!requiredMet) rawScore = Math.min(rawScore, 84);

  // Без visual или атрибутных доказательств текстовый direct должен быть осторожным.
  if (visualScore === 0 && attributeScore < 12 && titleScore < 12) rawScore = Math.min(rawScore, 79);

  const score = clamp(Math.round(rawScore));
  let matchLevel: MatchLevel;

  if (conflicts.hard.length > 0) {
    matchLevel = 'wrong' as MatchLevel;
  } else if (score >= DIRECT_THRESHOLD && requiredMet && conflicts.soft.filter((x) => x !== 'crossborder_not_for_local_economics').length === 0) {
    matchLevel = 'direct_analog' as MatchLevel;
  } else if (score >= BORDERLINE_THRESHOLD || (score >= 65 && !weakRequired && visualScore >= 20)) {
    matchLevel = 'similar' as MatchLevel;
  } else if (score >= SIMILAR_THRESHOLD || objectScore > 0) {
    matchLevel = 'category_only' as MatchLevel;
  } else {
    matchLevel = 'wrong' as MatchLevel;
  }

  const evidence: MatchEvidence = {
    objectScore,
    titleScore,
    requiredScore,
    attributeScore,
    visualScore,
    queryScore,
    commercialScore,
    penalties: conflicts.penalties,
    matchedGroups: uniq(matched),
    missingGroups: uniq(missing),
    rejectReasons: uniq([...conflicts.hard, ...(!isLocalMarket(card) ? ['not_local_wb_market'] : [])]),
    warnings: uniq([...conflicts.soft, ...warnings]),
  };

  return {
    score,
    matchLevel,
    matched: evidence.matchedGroups,
    missing: evidence.missingGroups,
    hardFound: uniq(conflicts.hard),
    softFound: uniq(conflicts.soft),
    evidence,
  };
}

// ─── Main scoring function ───────────────────────────────────────────────────

export function rankCandidates(
  cards: WbCard[],
  structure: ProductStructure | null,
  lexicon: ProductLexicon | null,
  queries: string[],
  queryTypeMap?: Map<string, string>,
): SimilarityResult {
  const seen = new Set<string>();
  const unique = cards.filter((c) => {
    const key = readCardId(c);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (!structure || !lexicon) {
    const scored: ScoredCard[] = unique.map((c) => ({
      ...c,
      similarity: 20,
      matchConfidence: 20,
      matchLevel: 'category_only' as MatchLevel,
      eligibleForEconomy: false,
      marketUse: 'reference_only',
      matchedTerms: [],
      missingTerms: [],
      hardConflictsFound: [],
      softConflictsFound: [],
      queryHits: [],
      evidence: {
        objectScore: 0, titleScore: 0, requiredScore: 0, attributeScore: 0, visualScore: 0,
        queryScore: 0, commercialScore: 0, penalties: 0,
        matchedGroups: [], missingGroups: ['product_structure_missing'], rejectReasons: [], warnings: ['structure_or_lexicon_missing'],
      },
    }));
    return {
      queries,
      totalAnalyzed: unique.length,
      buckets: { directLocalAnalogs: [], similarLocalProducts: [], crossBorderAnalogs: [], categoryOnly: scored, wrong: [] },
      leaders: scored.sort((a, b) => b.feedbacks - a.feedbacks).slice(0, 10),
      confidence: scored.length >= 20 ? 'category_only' : 'no_market',
    };
  }

  const scored: ScoredCard[] = unique.map((card) => {
    const qType = queryTypeMap?.get(card.url) ?? queryTypeMap?.get(readCardId(card));
    const queryInfo = qType ? { query: '', queryType: qType } : undefined;
    const r = scoreCandidate(card, structure, lexicon, queryInfo);
    const local = isLocalMarket(card);
    const cross = isCrossBorder(card);
    const direct = r.matchLevel === ('direct_analog' as MatchLevel);
    const eligibleForEconomy = local && !cross && direct && r.score >= DIRECT_THRESHOLD && r.hardFound.length === 0;
    const hits = getSourceHits(card, queryInfo);

    return {
      ...card,
      similarity: r.score,
      matchConfidence: r.score,
      matchLevel: r.matchLevel,
      eligibleForEconomy,
      marketUse: eligibleForEconomy ? 'economics' : r.matchLevel === ('wrong' as MatchLevel) ? 'blocked' : 'reference_only',
      matchedTerms: r.matched,
      missingTerms: r.missing,
      hardConflictsFound: r.hardFound,
      softConflictsFound: r.softFound,
      queryHits: hits,
      evidence: r.evidence,
    };
  });

  const directAll = scored.filter((c) => c.matchLevel === ('direct_analog' as MatchLevel)).sort((a, b) => b.similarity - a.similarity);
  const similarAll = scored.filter((c) => c.matchLevel === ('similar' as MatchLevel)).sort((a, b) => b.similarity - a.similarity);

  const buckets: MatchBuckets = {
    directLocalAnalogs: directAll.filter((c) => c.eligibleForEconomy),
    similarLocalProducts: similarAll.filter((c) => !isCrossBorder(c)),
    crossBorderAnalogs: [...directAll, ...similarAll].filter((c) => isCrossBorder(c)),
    categoryOnly: scored.filter((c) => c.matchLevel === ('category_only' as MatchLevel)),
    wrong: scored.filter((c) => c.matchLevel === ('wrong' as MatchLevel)),
  };

  const leaderCandidates = [...buckets.directLocalAnalogs, ...buckets.similarLocalProducts];
  const leaders: ScoredCard[] = [];
  const seenCommercialKeys = new Set<string>();

  for (const card of leaderCandidates.sort((a, b) => {
    const sa = a.similarity * 0.75 + Math.log(Math.max(a.feedbacks, 1)) * 4 + a.rating * 2;
    const sb = b.similarity * 0.75 + Math.log(Math.max(b.feedbacks, 1)) * 4 + b.rating * 2;
    return sb - sa;
  })) {
    const anyCard = card as unknown as WbCard & UnknownRecord;
    const sellerKey = safeText(anyCard.supplierId ?? anyCard.sellerId ?? anyCard.seller ?? anyCard.brand);
    const key = sellerKey || `${norm(card.title).slice(0, 40)}|${card.price}`;
    if (seenCommercialKeys.has(key)) continue;
    seenCommercialKeys.add(key);
    leaders.push(card);
    if (leaders.length >= 10) break;
  }

  const dc = buckets.directLocalAnalogs.length;
  const cb = buckets.crossBorderAnalogs.length;
  const cc = buckets.categoryOnly.length;
  let confidence: SimilarityResult['confidence'];
  if (dc >= 5 && buckets.directLocalAnalogs[0]?.similarity >= 90) confidence = 'high';
  else if (dc >= 3) confidence = 'medium';
  else if (dc >= 1) confidence = 'low';
  else if (cb > 0) confidence = 'crossborder_only';
  else if (cc >= 10) confidence = 'category_only';
  else confidence = 'no_market';

  return { queries, totalAnalyzed: unique.length, buckets, leaders, confidence };
}

// ─── WB Result Mining ────────────────────────────────────────────────────────

export function mineResults(cards: WbCard[]): { tokens: string[]; bigrams: string[]; categories: string[] } {
  const freq = new Map<string, number>();
  const bigramFreq = new Map<string, number>();
  const categories = new Map<string, number>();

  for (const card of cards.slice(0, 150)) {
    const anyCard = card as WbCard & UnknownRecord;
    const ws = words(card.title).filter((w) => w.length > 2 && !/^\d+$/.test(w));
    for (const w of ws) freq.set(w, (freq.get(w) ?? 0) + 1);
    for (let i = 0; i < ws.length - 1; i++) {
      const bg = `${ws[i]} ${ws[i + 1]}`;
      bigramFreq.set(bg, (bigramFreq.get(bg) ?? 0) + 1);
    }
    const cat = safeText(anyCard.subjectName ?? anyCard.categoryName ?? anyCard.kindName);
    if (cat) categories.set(cat, (categories.get(cat) ?? 0) + 1);
  }

  const minCount = cards.length >= 30 ? 3 : 2;
  return {
    tokens: [...freq.entries()].filter(([, c]) => c >= minCount).sort((a, b) => b[1] - a[1]).slice(0, 25).map((e) => e[0]),
    bigrams: [...bigramFreq.entries()].filter(([, c]) => c >= minCount).sort((a, b) => b[1] - a[1]).slice(0, 15).map((e) => e[0]),
    categories: [...categories.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map((e) => e[0]),
  };
}

// Legacy compat
export { rankCandidates as scoreSimilarity };

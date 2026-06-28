import type { WbTrend } from '../providers/wbconTrends';

export interface QueryCandidate {
  query: string;
  source: 'L1_exact' | 'L2_commercial' | 'L3_subtype' | 'L4_core' | 'L5_category' | 'wbcon_trend' | 'market_synonym' | 'seo_keyword' | 'repair';
  score: number;
  trendFrequency?: number;
}

interface ScoringContext {
  coreObject: string;
  productType: string;
  audience: string;
  materials: string[];
  hardConflicts: string[];
  softConflicts: string[];
  mustKeep: string[];
  doNotSearch: string[];
}

const JUNK_PATTERNS = [
  /алиэкспресс/i, /aliexpress/i, /бренд/i,
  /набор\s\d/i, /комплект\s\d/i,
  /\d{5,}/,
];

const STOPWORDS = new Set(['для', 'под', 'или', 'без', 'при', 'товар', 'набор', 'комплект', 'новый', 'топ', 'подарок']);

function normalize(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^а-яa-z0-9+\-\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function words(value: unknown): string[] {
  return normalize(value).split(/\s+/).filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

function uniqKey(query: string): string {
  return words(query).join(' ');
}

function hasAnyWord(query: string, probe: string): boolean {
  const q = normalize(query);
  return words(probe).some((w) => q.includes(w));
}

function addIfUseful(pool: QueryCandidate[], seen: Set<string>, query: string, source: QueryCandidate['source'], baseScore: number, trendFreq?: number) {
  const q = normalize(query);
  if (q.length < 2 || !/[а-яё]/i.test(q)) return;
  if (JUNK_PATTERNS.some((p) => p.test(q))) return;
  const key = uniqKey(q);
  if (!key || seen.has(key)) return;
  seen.add(key);
  pool.push({ query: q, source, score: baseScore, trendFrequency: trendFreq });
}

export function buildCandidatePool(
  queryPlan: any,
  validatedQueries: string[],
  wbTrends: WbTrend[],
  structure: any,
  seoKeywords: string[],
): QueryCandidate[] {
  const pool: QueryCandidate[] = [];
  const seen = new Set<string>();

  const add = (query: string, source: QueryCandidate['source'], baseScore: number, trendFreq?: number) =>
    addIfUseful(pool, seen, query, source, baseScore, trendFreq);

  const ladder = queryPlan ?? {};
  const validated = (validatedQueries ?? []).filter(Boolean);

  if (validated.length >= 3) {
    validated.slice(0, 5).forEach((q) => add(q, 'L1_exact', 88));
  }

  (ladder.L1_exact ?? []).forEach((q: string) => add(q, 'L1_exact', 95));
  (ladder.L2_commercial ?? []).forEach((q: string) => add(q, 'L2_commercial', 86));
  (ladder.L3_subtype ?? []).forEach((q: string) => add(q, 'L3_subtype', 72));
  (ladder.L4_core ?? []).forEach((q: string) => add(q, 'L4_core', 52));
  (ladder.L5_category ?? []).forEach((q: string) => add(q, 'L5_category', 25));

  if (structure) {
    const core = normalize(structure.coreObject);
    const type = normalize(structure.productType);
    const attrs = [
      ...(structure.requiredAttributes ?? []),
      ...(structure.importantAttributes ?? []),
      ...(structure.formFactor ?? []),
    ].map(normalize).filter(Boolean);

    if (core && type && core !== type) add(`${type} ${core}`, 'L1_exact', 94);
    if (core) add(core, 'L4_core', 55);
    if (type) add(type, 'L3_subtype', 65);

    // Комбинации object + один сильный атрибут дают лучшее покрытие прямых аналогов.
    for (const attr of attrs.slice(0, 6)) {
      if (core && !core.includes(attr) && !attr.includes(core)) add(`${core} ${attr}`, 'L2_commercial', 82);
      if (type && !type.includes(attr) && !attr.includes(type)) add(`${type} ${attr}`, 'L3_subtype', 70);
    }

    (structure.marketSynonyms ?? []).forEach((q: string) => add(q, 'market_synonym', 62));
    (structure.compatibleAlternatives ?? []).forEach((q: string) => add(q, 'market_synonym', 56));
  }

  for (const t of (wbTrends ?? []).slice(0, 20)) {
    add(t.search_words, 'wbcon_trend', 68, t.weeks_request_per_day);
  }

  (seoKeywords ?? []).slice(0, 5).forEach((q) => add(q, 'seo_keyword', 38));

  return pool;
}

export function selectTopQueries(
  pool: QueryCandidate[],
  maxQueries: number,
  context: ScoringContext,
): QueryCandidate[] {
  const coreLower = normalize(context.coreObject);
  const typeLower = normalize(context.productType);
  const materialsLower = new Set((context.materials ?? []).map(normalize));
  const conflictsLower = [...(context.hardConflicts ?? []), ...(context.softConflicts ?? [])].map(normalize).filter(Boolean);
  const doNotLower = (context.doNotSearch ?? []).map(normalize).filter(Boolean);
  const mustKeepLower = (context.mustKeep ?? []).map(normalize).filter(Boolean);

  const scored = pool.map((c) => {
    let score = c.score;
    const qLower = normalize(c.query);
    const qWords = words(c.query);

    if (coreLower && hasAnyWord(qLower, coreLower)) score += 14;
    if (typeLower && hasAnyWord(qLower, typeLower)) score += 8;

    const mustKeepHits = mustKeepLower.filter((m) => hasAnyWord(qLower, m)).length;
    if (mustKeepLower.length) {
      score += Math.min(18, mustKeepHits * 6);
      if (c.source === 'L1_exact' && mustKeepHits === 0) score -= 20;
    }

    if (c.trendFrequency && c.trendFrequency > 5000) score += 10;
    else if (c.trendFrequency && c.trendFrequency > 1000) score += 5;

    const count = qWords.length;
    if (count >= 2 && count <= 4) score += 12;
    if (count === 1 && c.source !== 'L4_core') score -= 18;
    if (count > 6) score -= 14;

    if (JUNK_PATTERNS.some((p) => p.test(c.query))) score -= 60;
    if (conflictsLower.some((conf) => conf && qLower.includes(conf))) score -= 40;
    if (doNotLower.some((d) => d && qLower.includes(d))) score -= 60;

    const materialConflicts = ['кожаный', 'кожа', 'замшевый', 'замша', 'деревянный', 'металлический', 'керамический', 'силиконовый', 'пластиковый'];
    for (const mc of materialConflicts) {
      if (qLower.includes(mc) && !materialsLower.has(mc) && !typeLower.includes(mc)) score -= 18;
    }

    // Широкая категория нужна только для recall и repair, а не как основной запрос.
    if (c.source === 'L5_category') score -= 20;
    if (c.source === 'seo_keyword' && !coreLower.split(' ').some((w) => qLower.includes(w))) score -= 18;

    return { ...c, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const selected: QueryCandidate[] = [];
  for (const candidate of scored) {
    if (selected.length >= maxQueries) break;
    if (candidate.score < 25) continue;

    const candidateWords = words(candidate.query);
    const isDuplicate = selected.some((s) => {
      const sWords = words(s.query);
      const overlap = sWords.filter((w) => candidateWords.includes(w)).length;
      const totalWords = Math.max(sWords.length, candidateWords.length, 1);
      return overlap / totalWords > 0.72;
    });

    if (!isDuplicate) selected.push(candidate);
  }

  // Гарантируем один узкий и один core-запрос, чтобы парсер не зависел от LLM-формулировки.
  if (selected.length < maxQueries) {
    const fallback = scored.find((q) => q.source === 'L4_core' && !selected.some((s) => uniqKey(s.query) === uniqKey(q.query)));
    if (fallback && fallback.score >= 20) selected.push(fallback);
  }

  return selected.slice(0, maxQueries);
}

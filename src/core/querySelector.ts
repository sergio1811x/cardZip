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
  /\d{5,}/, // артикулы
];

export function buildCandidatePool(
  queryPlan: any,
  validatedQueries: string[],
  wbTrends: WbTrend[],
  structure: any,
  seoKeywords: string[],
): QueryCandidate[] {
  const pool: QueryCandidate[] = [];
  const seen = new Set<string>();

  const add = (query: string, source: QueryCandidate['source'], baseScore: number, trendFreq?: number) => {
    const q = query.trim().toLowerCase();
    if (q.length < 2 || seen.has(q) || !/[а-яё]/i.test(q)) return;
    seen.add(q);
    pool.push({ query, source, score: baseScore, trendFrequency: trendFreq });
  };

  // LLM queries (highest base score)
  if (validatedQueries.length >= 3) {
    validatedQueries.slice(0, 5).forEach((q) => add(q, 'L1_exact', 80));
  } else {
    const ladder = queryPlan ?? {};
    (ladder.L1_exact ?? []).forEach((q: string) => add(q, 'L1_exact', 90));
    (ladder.L2_commercial ?? []).forEach((q: string) => add(q, 'L2_commercial', 85));
    (ladder.L3_subtype ?? []).forEach((q: string) => add(q, 'L3_subtype', 70));
    (ladder.L4_core ?? []).forEach((q: string) => add(q, 'L4_core', 50));
    (ladder.L5_category ?? []).forEach((q: string) => add(q, 'L5_category', 30));
  }

  // WBCON trends (boost if present)
  for (const t of wbTrends.slice(0, 10)) {
    add(t.search_words, 'wbcon_trend', 75, t.weeks_request_per_day);
  }

  // Market synonyms from structure
  if (structure) {
    (structure.marketSynonyms ?? []).forEach((q: string) => add(q, 'market_synonym', 60));
    (structure.compatibleAlternatives ?? []).forEach((q: string) => add(q, 'market_synonym', 55));
    if (structure.productType) add(structure.productType, 'L1_exact', 85);
    if (structure.coreObject) add(structure.coreObject, 'L4_core', 50);
  }

  // SEO keywords
  seoKeywords.slice(0, 3).forEach((q) => add(q, 'seo_keyword', 40));

  return pool;
}

export function selectTopQueries(
  pool: QueryCandidate[],
  maxQueries: number,
  context: ScoringContext,
): QueryCandidate[] {
  const coreLower = context.coreObject.toLowerCase();
  const typeLower = context.productType.toLowerCase();
  const materialsLower = new Set((context.materials ?? []).map((m) => m.toLowerCase()));
  const conflictsLower = [...(context.hardConflicts ?? []), ...(context.softConflicts ?? [])].map((c) => c.toLowerCase());
  const doNotLower = (context.doNotSearch ?? []).map((d) => d.toLowerCase());

  const scored = pool.map((c) => {
    let score = c.score;
    const qLower = c.query.toLowerCase();

    // Boost: contains core object
    if (qLower.includes(coreLower.split(' ')[0])) score += 10;

    // Boost: WBCON trend with high frequency
    if (c.trendFrequency && c.trendFrequency > 5000) score += 15;
    else if (c.trendFrequency && c.trendFrequency > 1000) score += 8;

    // Boost: moderate length (2-4 words)
    const words = c.query.split(/\s+/).length;
    if (words >= 2 && words <= 4) score += 10;
    if (words === 1) score -= 15; // too broad
    if (words > 5) score -= 10; // too narrow

    // Penalty: junk patterns
    if (JUNK_PATTERNS.some((p) => p.test(c.query))) score -= 50;

    // Penalty: conflicts
    if (conflictsLower.some((conf) => qLower.includes(conf))) score -= 30;

    // Penalty: doNotSearch
    if (doNotLower.some((d) => qLower.includes(d))) score -= 40;

    // Penalty: conflicting materials
    const materialConflicts = ['кожаный', 'кожа', 'замшевый', 'замша', 'деревянный', 'металлический', 'керамический'];
    for (const mc of materialConflicts) {
      if (qLower.includes(mc) && !materialsLower.has(mc) && !typeLower.includes(mc)) {
        score -= 25;
      }
    }

    return { ...c, score };
  });

  // Sort by score descending, deduplicate by semantic overlap
  scored.sort((a, b) => b.score - a.score);

  const selected: QueryCandidate[] = [];
  for (const candidate of scored) {
    if (selected.length >= maxQueries) break;
    if (candidate.score < 20) break;

    // Skip if too similar to already selected
    const isDuplicate = selected.some((s) => {
      const overlap = s.query.toLowerCase().split(/\s+/).filter((w) =>
        candidate.query.toLowerCase().includes(w)
      ).length;
      const totalWords = Math.max(s.query.split(/\s+/).length, candidate.query.split(/\s+/).length);
      return overlap / totalWords > 0.7;
    });

    if (!isDuplicate) selected.push(candidate);
  }

  return selected;
}

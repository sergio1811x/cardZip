export interface WbTrend {
  search_words: string;
  weeks_request_per_day: number;
  month_request_per_day: number;
  rank: number;
  products: number;
  coef: number;
}

export interface WbTrendsResult {
  query: string;
  trends: WbTrend[];
  latencyMs: number;
}

const DEFAULT_WBCON_TRENDS_URL = 'https://wbcon.ru/wp-json/wb-services/v1/extended/get_wb_trends_by_query';

const STOP_WORDS = new Set([
  'для',
  'под',
  'при',
  'без',
  'или',
  'над',
  'как',
  'что',
  'это',
  'все',
  'вся',
  'его',
  'её',
  'the',
  'and',
  'with',
]);

const GENERIC_RISK_TERMS = [
  'медицинск',
  'ортопедическ',
  'лечебн',
  'сертифицирован',
  'профессиональн',
];

const BUNDLE_TERMS = ['набор', 'комплект'];

const MATERIAL_GROUPS: string[][] = [
  ['кожа', 'кожан', 'натуральная кожа', 'экокожа'],
  ['замша', 'замшев'],
  ['текстиль', 'текстильн', 'ткань', 'тканев'],
  ['дерево', 'деревян'],
  ['металл', 'металлическ', 'сталь', 'стальной'],
  ['пластик', 'пластиков'],
  ['силикон', 'силиконов'],
  ['стекло', 'стеклян'],
  ['керамика', 'керамическ'],
];

function getEnv(name: string): string | undefined {
  const env = (globalThis as any)?.process?.env as Record<string, string | undefined> | undefined;
  return env?.[name];
}

function getNumberEnv(name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const value = Number(getEnv(name));
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function getStringEnv(name: string, fallback: string): string {
  const value = getEnv(name);
  return value && value.trim() ? value.trim() : fallback;
}

function createTimeoutSignal(ms: number): AbortSignal {
  const timeoutFactory = (AbortSignal as any).timeout;
  if (typeof timeoutFactory === 'function') {
    return timeoutFactory(ms);
  }

  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeQuery(query: string): string {
  return normalizeText(String(query ?? ''))
    .replace(/\s+/g, ' ')
    .slice(0, 120);
}

function tokenize(value: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];

  for (const token of normalizeText(value).split(/\s+/)) {
    const clean = token.trim();
    if (clean.length < 2) continue;
    if (STOP_WORDS.has(clean)) continue;
    if (seen.has(clean)) continue;
    seen.add(clean);
    tokens.push(clean);
  }

  return tokens;
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value);

  if (typeof value === 'string') {
    const normalized = value
      .replace(/\s+/g, '')
      .replace(',', '.')
      .replace(/[^\d.-]/g, '');

    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }

  return fallback;
}

function normalizeTrend(raw: any): WbTrend | null {
  const searchWords = String(raw?.search_words ?? raw?.query ?? raw?.keyword ?? raw?.name ?? '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!searchWords) return null;

  return {
    search_words: searchWords,
    weeks_request_per_day: toNumber(raw?.weeks_request_per_day ?? raw?.week_request_per_day ?? raw?.week ?? raw?.weekly),
    month_request_per_day: toNumber(raw?.month_request_per_day ?? raw?.month ?? raw?.monthly),
    rank: Math.round(toNumber(raw?.rank)),
    products: Math.round(toNumber(raw?.products ?? raw?.cards ?? raw?.items)),
    coef: toNumber(raw?.coef ?? raw?.coefficient),
  };
}

function extractTrendRows(data: any): any[] {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.trends)) return data.trends;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.result)) return data.result;
  if (Array.isArray(data?.result?.trends)) return data.result.trends;
  if (Array.isArray(data?.result?.data)) return data.result.data;
  return [];
}

function dedupeTrends(trends: WbTrend[]): WbTrend[] {
  const map = new Map<string, WbTrend>();

  for (const trend of trends) {
    const key = normalizeText(trend.search_words);
    const prev = map.get(key);

    if (!prev) {
      map.set(key, trend);
      continue;
    }

    const prevScore = prev.weeks_request_per_day + prev.month_request_per_day + prev.coef;
    const nextScore = trend.weeks_request_per_day + trend.month_request_per_day + trend.coef;

    if (nextScore > prevScore) map.set(key, trend);
  }

  return Array.from(map.values());
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function postTrendsRequest(query: string, attempt: number): Promise<WbTrend[] | null> {
  const url = getStringEnv('WBCON_TRENDS_URL', DEFAULT_WBCON_TRENDS_URL);
  const timeoutMs = getNumberEnv('WBCON_TRENDS_TIMEOUT_MS', 5_000, 1_000, 60_000);
  const limit = getNumberEnv('WBCON_TRENDS_LIMIT', 50, 1, 200);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, offset: 0, limit }),
    signal: createTimeoutSignal(timeoutMs),
  });

  if (!res.ok) {
    console.log(`[wbcon-trends] ${query} → HTTP ${res.status} (attempt ${attempt})`);
    return null;
  }

  const data = await res.json().catch(() => null);
  const rows = extractTrendRows(data);

  return dedupeTrends(rows.map(normalizeTrend).filter((t): t is WbTrend => Boolean(t)));
}

export async function fetchWbTrends(query: string): Promise<WbTrendsResult> {
  const start = Date.now();
  const normalizedQuery = sanitizeQuery(query);

  if (!normalizedQuery) {
    return { query, trends: [], latencyMs: Date.now() - start };
  }

  const retryCount = getNumberEnv('WBCON_TRENDS_RETRIES', 1, 0, 3);
  const retryDelayMs = getNumberEnv('WBCON_TRENDS_RETRY_DELAY_MS', 250, 0, 3_000);

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= retryCount + 1; attempt += 1) {
    try {
      const trends = await postTrendsRequest(normalizedQuery, attempt);

      if (trends) {
        console.log(`[wbcon-trends] ${normalizedQuery} → ${trends.length} trends, ${Date.now() - start}ms`);
        return { query: normalizedQuery, trends, latencyMs: Date.now() - start };
      }

      // postTrendsRequest already logged HTTP status. Retry only if attempts remain.
      if (attempt <= retryCount) await sleep(retryDelayMs * attempt);
    } catch (error: any) {
      lastError = error;

      const message = error?.name === 'AbortError'
        ? 'timeout'
        : error?.message ?? String(error);

      console.log(`[wbcon-trends] ${normalizedQuery} → error: ${message} (attempt ${attempt})`);

      if (attempt <= retryCount) {
        await sleep(retryDelayMs * attempt);
      }
    }
  }

  if (lastError) {
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    console.log(`[wbcon-trends] ${normalizedQuery} → failed: ${message}, ${Date.now() - start}ms`);
  }

  return { query: normalizedQuery, trends: [], latencyMs: Date.now() - start };
}

function includesAny(text: string, terms: string[]): boolean {
  return terms.some((term) => {
    const normalized = normalizeText(term);
    return normalized.length > 0 && text.includes(normalized);
  });
}

function countTokenMatches(text: string, tokens: string[]): number {
  let matches = 0;
  for (const token of tokens) {
    if (text.includes(token)) matches += 1;
  }
  return matches;
}

function getMaterialConflict(text: string, materialTokens: string[], allowedText: string): string | null {
  if (!materialTokens.length) return null;

  for (const group of MATERIAL_GROUPS) {
    const hasGroupTerm = group.some((term) => text.includes(term));
    if (!hasGroupTerm) continue;

    const allowedByMaterial = group.some((term) => materialTokens.some((material) => material.includes(term) || term.includes(material)));
    const allowedByContext = group.some((term) => allowedText.includes(term));

    if (!allowedByMaterial && !allowedByContext) {
      return group[0];
    }
  }

  return null;
}

function isGenericRiskTermAllowed(term: string, allowedText: string): boolean {
  return allowedText.includes(term);
}

function shouldExcludeGeneric(text: string, allowedText: string): boolean {
  for (const term of GENERIC_RISK_TERMS) {
    if (text.includes(term) && !isGenericRiskTermAllowed(term, allowedText)) {
      return true;
    }
  }

  for (const term of BUNDLE_TERMS) {
    if (text.includes(term) && !allowedText.includes(term)) {
      return true;
    }
  }

  return false;
}

function trendRelevanceScore(
  trend: WbTrend,
  text: string,
  primaryTokens: string[],
  typeTokens: string[],
  materialTokens: string[],
): number {
  const primaryMatches = countTokenMatches(text, primaryTokens);
  const typeMatches = countTokenMatches(text, typeTokens);
  const materialMatches = countTokenMatches(text, materialTokens);

  // Relevance first, volume second. coef is useful but can be noisy, so it has limited weight.
  return (
    primaryMatches * 100_000 +
    typeMatches * 20_000 +
    materialMatches * 5_000 +
    trend.weeks_request_per_day * 10 +
    trend.month_request_per_day * 3 +
    trend.coef * 100 -
    Math.max(0, trend.products - 5000) * 0.01
  );
}

export function filterRelevantTrends(
  trends: WbTrend[],
  coreQuery: string,
  productType: string,
  materials: string[],
  negativeMatches?: string[],
  directAnalogBlockers?: string[],
): WbTrend[] {
  if (!Array.isArray(trends) || !trends.length) return [];

  const normalizedCore = normalizeText(coreQuery);
  const normalizedType = normalizeText(productType);
  const materialTokens = materials.flatMap(tokenize);
  const primaryTokens = tokenize(normalizedCore).length
    ? tokenize(normalizedCore).slice(0, 4)
    : tokenize(normalizedType).slice(0, 4);
  const typeTokens = tokenize(normalizedType).slice(0, 5);

  const negativeTokens = (negativeMatches ?? [])
    .map(normalizeText)
    .filter(Boolean);

  const blockerTokens = (directAnalogBlockers ?? [])
    .map(normalizeText)
    .filter(Boolean);

  const allowedText = normalizeText([
    coreQuery,
    productType,
    ...materials,
  ].join(' '));

  const scored: Array<{ trend: WbTrend; score: number }> = [];

  for (const trend of trends) {
    if (!trend?.search_words) continue;

    const text = normalizeText(trend.search_words);
    if (!text) continue;

    const demand = trend.weeks_request_per_day || trend.month_request_per_day;
    if (demand <= 0) continue;

    if (negativeTokens.length && includesAny(text, negativeTokens)) continue;
    if (blockerTokens.length && includesAny(text, blockerTokens)) continue;
    if (shouldExcludeGeneric(text, allowedText)) continue;

    const materialConflict = getMaterialConflict(text, materialTokens, allowedText);
    if (materialConflict) continue;

    if (primaryTokens.length > 0 && countTokenMatches(text, primaryTokens) === 0) {
      continue;
    }

    const score = trendRelevanceScore(trend, text, primaryTokens, typeTokens, materialTokens);
    scored.push({ trend, score });
  }

  const result = scored
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.trend.weeks_request_per_day !== a.trend.weeks_request_per_day) {
        return b.trend.weeks_request_per_day - a.trend.weeks_request_per_day;
      }
      return b.trend.month_request_per_day - a.trend.month_request_per_day;
    })
    .map((item) => item.trend);

  return result.slice(0, 10);
}

import type { MarketProvider, WbSearchResult, WbCard } from '../types';

const WB_PARSER_URL = (process.env.WB_PARSER_URL || 'http://50fc4ca33bd1.vps.myjino.ru').replace(/\/+$/, '');
const WB_PARSER_SECRET = process.env.WB_PARSER_SECRET || 'cardzip-wb-2024';

const WB_PARSER_TIMEOUT_MS = Number(process.env.WB_PARSER_TIMEOUT_MS || 30_000);
const WB_PARSER_LIMIT = Number(process.env.WB_PARSER_LIMIT || 80);
const WB_PARSER_RETRIES = Number(process.env.WB_PARSER_RETRIES || 1);
const WB_TEXT_SEARCH_ENABLED = process.env.WB_TEXT_SEARCH_ENABLED !== '0';

interface ParserProduct {
  id: number;
  nmId?: number;
  name?: string;
  title?: string;
  brand?: string;
  price: number;
  rating?: number;
  feedbacks?: number;
  wh?: number | null;
  time1?: number | null;
  time2?: number | null;
  dist?: number | null;
  kindId?: number | null;
  seller?: string;
  supplierId?: number | null;
  subjectId?: number | null;
  subjectName?: string;
  categoryName?: string;
  imageUrls?: string[];
  pics?: number;
  source?: string;
  query?: string;
  queryType?: string;
  photoRank?: number;
  marketType?: string;
}

interface ParserResponse {
  success: boolean;
  total?: number;
  count?: number;
  products?: ParserProduct[];
  results?: Array<{ query?: string; count?: number; products?: ParserProduct[] }>;
  photoSearchConfirmed?: boolean;
  error?: string;
  message?: string;
}

type QueryCandidateInput = string | { query: string; source?: string; queryType?: string };

function safeText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeLimit(n: number): number {
  if (!Number.isFinite(n)) return 80;
  return Math.max(1, Math.min(100, Math.round(n)));
}

function normalizePriceRub(price: unknown): number | null {
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 5_000_000) return null;
  return Math.round(n);
}

function normalizeRating(rating: unknown): number {
  const n = Number(rating);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(5, Math.round(n * 10) / 10);
}

function normalizeFeedbacks(feedbacks: unknown): number {
  const n = Number(feedbacks);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

function buildWbUrl(id: number): string {
  return `https://www.wildberries.ru/catalog/${id}/detail.aspx`;
}

function normalizeMarketType(value: unknown): string {
  const raw = safeText(value).toLowerCase();
  if (/cross|кросс|china|global|доставка\s+из\s+китая/.test(raw)) return 'crossborder_market';
  return 'local_wb_market';
}

function productToCard(p: ParserProduct, fallbackQuery?: string, fallbackQueryType?: string, index?: number): WbCard | null {
  const id = Number(p.id ?? p.nmId);
  if (!Number.isFinite(id) || id <= 0) return null;

  const title = safeText(p.title ?? p.name);
  if (!title) return null;

  const price = normalizePriceRub(p.price);
  if (!price) return null;

  const source = safeText(p.source || fallbackQueryType || 'text');
  const query = safeText(p.query || fallbackQuery);

  return {
    title,
    price,
    url: buildWbUrl(id),
    rating: normalizeRating(p.rating),
    feedbacks: normalizeFeedbacks(p.feedbacks),
    ...(p.brand ? { brand: safeText(p.brand) } : {}),
    ...(p.supplierId ? { supplierId: p.supplierId } : {}),
    ...(p.seller ? { seller: safeText(p.seller) } : {}),
    ...(p.subjectName ? { subjectName: safeText(p.subjectName) } : {}),
    ...(p.categoryName ? { categoryName: safeText(p.categoryName) } : {}),
    ...(p.kindId ? { kindId: p.kindId } : {}),
    ...(p.wh ? { wh: p.wh } : {}),
    ...(p.dist ? { dist: p.dist } : {}),
    ...(p.imageUrls?.length ? { imageUrls: p.imageUrls } : {}),
    id,
    nmId: id,
    marketType: normalizeMarketType(p.marketType),
    photoRank: typeof index === 'number' ? index + 1 : p.photoRank,
    queryHits: query || source ? [{ query, queryType: source }] : [],
    sourceHits: query || source ? [{ query, source }] : [],
  } as WbCard;
}

function mergeCards(existing: WbCard, incoming: WbCard): WbCard {
  const e: any = existing;
  const i: any = incoming;
  const queryHits = [...(Array.isArray(e.queryHits) ? e.queryHits : []), ...(Array.isArray(i.queryHits) ? i.queryHits : [])];
  const sourceHits = [...(Array.isArray(e.sourceHits) ? e.sourceHits : []), ...(Array.isArray(i.sourceHits) ? i.sourceHits : [])];
  return {
    ...existing,
    ...Object.fromEntries(Object.entries(incoming as any).filter(([, value]) => value !== undefined && value !== null && value !== '')),
    rating: Math.max(existing.rating ?? 0, incoming.rating ?? 0),
    feedbacks: Math.max(existing.feedbacks ?? 0, incoming.feedbacks ?? 0),
    queryHits,
    sourceHits,
  } as WbCard;
}

function cardKey(card: WbCard): string {
  const anyCard: any = card;
  return safeText(anyCard.nmId ?? anyCard.id) || card.url.match(/catalog\/(\d+)\//)?.[1] || `${card.title.toLowerCase()}|${card.price}`;
}

function dedupeCards(cards: WbCard[]): WbCard[] {
  const map = new Map<string, WbCard>();
  for (const card of cards) {
    const key = cardKey(card);
    const prev = map.get(key);
    map.set(key, prev ? mergeCards(prev, card) : card);
  }
  return [...map.values()];
}

function calcAvg(prices: number[]): number {
  if (!prices.length) return 0;
  return Math.round(prices.reduce((sum, p) => sum + p, 0) / prices.length);
}

function buildResultFromCards(cardsInput: WbCard[], total?: number, photoSearchConfirmed?: boolean): WbSearchResult | null {
  const cards = dedupeCards(cardsInput).filter((c) => c.price > 0);
  if (!cards.length) return null;

  const prices = cards.map((c) => c.price).filter((p) => p > 0);
  if (!prices.length) return null;

  const totalCards = Number.isFinite(Number(total)) && Number(total) > 0
    ? Math.max(Math.round(Number(total)), cards.length)
    : cards.length;

  return {
    avgPrice: calcAvg(prices),
    minPrice: Math.round(Math.min(...prices)),
    maxPrice: Math.round(Math.max(...prices)),
    totalCards,
    topExamples: cards.slice(0, 5),
    allCards: cards,
    photoSearchConfirmed: photoSearchConfirmed === true,
  };
}

function buildResult(data: ParserResponse, fallbackQuery?: string, fallbackQueryType?: string): WbSearchResult | null {
  if (!data || data.success !== true) return null;

  const directProducts = Array.isArray(data.products) ? data.products : [];
  const batchProducts = Array.isArray(data.results)
    ? data.results.flatMap((r) => (r.products ?? []).map((p, index) => ({ p, query: r.query, queryType: fallbackQueryType || 'batch', index })))
    : [];

  const cards = [
    ...directProducts.map((p, index) => productToCard(p, fallbackQuery, fallbackQueryType, index)),
    ...batchProducts.map((item) => productToCard(item.p, item.query, item.queryType, item.index)),
  ].filter((x): x is WbCard => Boolean(x));

  const total = data.total ?? data.count ?? cards.length;
  return buildResultFromCards(cards, total, data.photoSearchConfirmed);
}

async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<ParserResponse | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'CardZip-WB-MarketProvider/1.0',
      },
    });

    if (!res.ok) {
      console.warn(`[wb] VPS parser HTTP ${res.status}`);
      return null;
    }

    const data = await res.json() as ParserResponse;
    return data;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[wb] VPS parser fetch failed: ${msg}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function postJsonWithTimeout(url: string, body: unknown, timeoutMs: number): Promise<ParserResponse | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'CardZip-WB-MarketProvider/1.0' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn(`[wb] VPS parser HTTP ${res.status}`);
      return null;
    }
    return await res.json() as ParserResponse;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[wb] VPS parser POST failed: ${msg}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function buildImageSearchUrl(query: string, imageUrl: string): string {
  const params = new URLSearchParams({
    secret: WB_PARSER_SECRET,
    limit: String(normalizeLimit(WB_PARSER_LIMIT)),
    image_url: imageUrl,
  });

  const q = safeText(query);
  if (q) params.set('query', q.slice(0, 160));

  return `${WB_PARSER_URL}/search-by-image?${params.toString()}`;
}

function buildTextSearchUrl(query: string): string {
  const params = new URLSearchParams({
    secret: WB_PARSER_SECRET,
    limit: String(normalizeLimit(WB_PARSER_LIMIT)),
    query: safeText(query).slice(0, 160),
  });
  return `${WB_PARSER_URL}/search-by-text?${params.toString()}`;
}

async function searchByImage(query: string, imageUrl: string): Promise<WbSearchResult | null> {
  const url = buildImageSearchUrl(query, imageUrl);
  const attempts = Math.max(1, WB_PARSER_RETRIES + 1);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const data = await fetchJsonWithTimeout(url, WB_PARSER_TIMEOUT_MS);
    if (!data) {
      if (attempt < attempts) continue;
      return null;
    }
    if (data.success !== true) {
      if (attempt < attempts) continue;
      return null;
    }
    const result = buildResult(data, query, 'image');
    if (result) return result;
  }

  return null;
}

export async function searchWbText(query: string, queryType = 'text'): Promise<WbSearchResult | null> {
  const clean = safeText(query);
  if (!clean || !WB_TEXT_SEARCH_ENABLED) return null;
  const url = buildTextSearchUrl(clean);
  const data = await fetchJsonWithTimeout(url, WB_PARSER_TIMEOUT_MS);
  return buildResult(data ?? { success: false }, clean, queryType);
}

export async function searchWbBatch(queries: QueryCandidateInput[]): Promise<WbSearchResult | null> {
  const normalized = queries.map((q) => typeof q === 'string'
    ? { query: safeText(q), source: 'text' }
    : { query: safeText(q.query), source: safeText(q.source ?? q.queryType ?? 'text') })
    .filter((q) => q.query)
    .slice(0, 15);
  if (!normalized.length || !WB_TEXT_SEARCH_ENABLED) return null;

  const data = await postJsonWithTimeout(`${WB_PARSER_URL}/search-batch`, {
    secret: WB_PARSER_SECRET,
    limit: String(normalizeLimit(WB_PARSER_LIMIT)),
    queries: normalized.map((q) => q.query),
  }, Math.max(WB_PARSER_TIMEOUT_MS, normalized.length * 5_000));

  if (!data || data.success !== true || !Array.isArray(data.results)) return null;

  const cards: WbCard[] = [];
  data.results.forEach((result, resultIndex) => {
    const meta = normalized[resultIndex];
    (result.products ?? []).forEach((p, index) => {
      const card = productToCard(p, result.query ?? meta?.query, meta?.source ?? 'batch', index);
      if (card) cards.push(card);
    });
  });

  return buildResultFromCards(cards, cards.length, false);
}

export async function collectWbCandidates(input: {
  query?: string;
  imageUrl?: string;
  queries?: QueryCandidateInput[];
}): Promise<WbSearchResult | null> {
  const cards: WbCard[] = [];
  let photoConfirmed = false;

  const cleanQuery = safeText(input.query);
  const cleanImage = safeText(input.imageUrl);

  if (cleanImage && isValidHttpUrl(cleanImage)) {
    const imageResult = await searchByImage(cleanQuery, cleanImage);
    if (imageResult?.allCards?.length) {
      cards.push(...imageResult.allCards);
      photoConfirmed = imageResult.photoSearchConfirmed === true || true;
    }
  }

  const queryInputs = input.queries?.length ? input.queries : cleanQuery ? [cleanQuery] : [];
  if (queryInputs.length) {
    const batch = await searchWbBatch(queryInputs);
    if (batch?.allCards?.length) cards.push(...batch.allCards);
  }

  return buildResultFromCards(cards, cards.length, photoConfirmed);
}

async function searchSimilar(query: string, imageUrl?: string): Promise<WbSearchResult | null> {
  const cleanQuery = safeText(query);
  const cleanImageUrl = safeText(imageUrl);

  if (!process.env.WB_PARSER_SECRET) {
    console.warn('[wb] WB_PARSER_SECRET не задан в env, используется fallback secret. Лучше вынести secret в переменные окружения.');
  }

  console.log(`[wb] Поиск кандидатов: image=${cleanImageUrl ? 'yes' : 'no'}, query="${cleanQuery}"`);

  const result = await collectWbCandidates({ query: cleanQuery, imageUrl: cleanImageUrl, queries: cleanQuery ? [cleanQuery] : [] });
  if (!result) return null;

  console.log([
    `[wb] Кандидаты: ${result.allCards?.length ?? 0}`,
    `avg=${result.avgPrice}₽`,
    `min=${result.minPrice}₽`,
    `max=${result.maxPrice}₽`,
    `photo=${result.photoSearchConfirmed}`,
  ].join(', '));

  return result;
}

export const marketProvider: MarketProvider = { searchSimilar };

import type { MarketProvider, WbSearchResult, WbCard } from '../types';

const WB_PARSER_URL = (process.env.WB_PARSER_URL || 'http://50fc4ca33bd1.vps.myjino.ru').replace(/\/+$/, '');
const WB_PARSER_SECRET = process.env.WB_PARSER_SECRET || 'cardzip-wb-2024';

const WB_PARSER_TIMEOUT_MS = Number(process.env.WB_PARSER_TIMEOUT_MS || 30_000);
const WB_PARSER_LIMIT = Number(process.env.WB_PARSER_LIMIT || 50);
const WB_PARSER_RETRIES = Number(process.env.WB_PARSER_RETRIES || 1);

interface ParserProduct {
  id: number;
  name: string;
  brand?: string;
  price: number;
  rating?: number;
  feedbacks?: number;
}

interface ParserResponse {
  success: boolean;
  total?: number;
  count?: number;
  products?: ParserProduct[];
  photoSearchConfirmed?: boolean;
  error?: string;
  message?: string;
}

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
  if (!Number.isFinite(n)) return 50;
  return Math.max(1, Math.min(100, Math.round(n)));
}

function normalizePriceRub(price: unknown): number | null {
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0) return null;

  // Защита от очевидно битых значений.
  // Не режем агрессивно, потому что на WB бывают дорогие товары.
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

function productToCard(p: ParserProduct): WbCard | null {
  const id = Number(p.id);
  if (!Number.isFinite(id) || id <= 0) return null;

  const title = safeText(p.name);
  if (!title) return null;

  const price = normalizePriceRub(p.price);
  if (!price) return null;

  return {
    title,
    price,
    url: buildWbUrl(id),
    rating: normalizeRating(p.rating),
    feedbacks: normalizeFeedbacks(p.feedbacks),
    marketType: 'local_wb_market',
  };
}

function dedupeCards(cards: WbCard[]): WbCard[] {
  const seen = new Set<string>();
  const out: WbCard[] = [];

  for (const card of cards) {
    const nm = card.url.match(/catalog\/(\d+)\//)?.[1];
    const key = nm || `${card.title.toLowerCase()}|${card.price}`;

    if (seen.has(key)) continue;
    seen.add(key);
    out.push(card);
  }

  return out;
}

function calcAvg(prices: number[]): number {
  if (!prices.length) return 0;
  return Math.round(prices.reduce((sum, p) => sum + p, 0) / prices.length);
}

function buildResult(data: ParserResponse): WbSearchResult | null {
  if (!data || data.success !== true) return null;

  const products = Array.isArray(data.products) ? data.products : [];
  if (!products.length) return null;

  const cards = dedupeCards(
      products
          .map(productToCard)
          .filter((x): x is WbCard => Boolean(x)),
  );

  if (!cards.length) return null;

  const prices = cards.map((c) => c.price).filter((p) => p > 0);
  if (!prices.length) return null;

  const totalFromParser = Number(data.total);
  const totalCards = Number.isFinite(totalFromParser) && totalFromParser > 0
      ? Math.max(Math.round(totalFromParser), cards.length)
      : cards.length;

  return {
    avgPrice: calcAvg(prices),
    minPrice: Math.round(Math.min(...prices)),
    maxPrice: Math.round(Math.max(...prices)),
    totalCards,
    topExamples: cards.slice(0, 3),
    allCards: cards,
    photoSearchConfirmed: data.photoSearchConfirmed === true,
  };
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

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      console.warn(`[wb] VPS parser unexpected content-type: ${contentType || 'unknown'}`);
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

function buildImageSearchUrl(query: string, imageUrl: string): string {
  const params = new URLSearchParams({
    secret: WB_PARSER_SECRET,
    limit: String(normalizeLimit(WB_PARSER_LIMIT)),
    image_url: imageUrl,
  });

  // Не ломает старый VPS parser: если он не использует query, просто проигнорирует.
  const q = safeText(query);
  if (q) params.set('query', q.slice(0, 160));

  return `${WB_PARSER_URL}/search-by-image?${params.toString()}`;
}

async function searchByImage(query: string, imageUrl: string): Promise<WbSearchResult | null> {
  const url = buildImageSearchUrl(query, imageUrl);
  const attempts = Math.max(1, WB_PARSER_RETRIES + 1);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const data = await fetchJsonWithTimeout(url, WB_PARSER_TIMEOUT_MS);

    if (!data) {
      if (attempt < attempts) {
        console.warn(`[wb] Retry ${attempt}/${attempts - 1}`);
        continue;
      }
      return null;
    }

    if (data.success !== true) {
      console.warn(`[wb] VPS parser returned success=false: ${data.error || data.message || 'unknown error'}`);
      if (attempt < attempts) continue;
      return null;
    }

    const result = buildResult(data);

    if (!result) {
      console.log('[wb] Нет валидных результатов');
      return null;
    }

    console.log(
        [
          `[wb] Результат: ${result.totalCards} карточек`,
          `avg=${result.avgPrice}₽`,
          `min=${result.minPrice}₽`,
          `max=${result.maxPrice}₽`,
          `photoConfirmed=${result.photoSearchConfirmed}`,
          `cards=${result.allCards?.length ?? 0}`,
        ].join(', '),
    );

    return result;
  }

  return null;
}

async function searchSimilar(query: string, imageUrl?: string): Promise<WbSearchResult | null> {
  const cleanQuery = safeText(query);
  const cleanImageUrl = safeText(imageUrl);

  console.log(`[wb] Поиск: image=${cleanImageUrl ? 'yes' : 'no'}, query="${cleanQuery}"`);

  if (!cleanImageUrl) {
    console.log('[wb] Нет фото — image search невозможен');
    return null;
  }

  if (!isValidHttpUrl(cleanImageUrl)) {
    console.warn(`[wb] Некорректный imageUrl: ${cleanImageUrl.slice(0, 120)}`);
    return null;
  }

  if (!process.env.WB_PARSER_SECRET) {
    console.warn('[wb] WB_PARSER_SECRET не задан в env, используется fallback secret. Лучше вынести secret в переменные окружения.');
  }

  return searchByImage(cleanQuery, cleanImageUrl);
}

export const marketProvider: MarketProvider = { searchSimilar };
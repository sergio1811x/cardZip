import type { MarketProvider, WbSearchResult, WbCard } from '../types';

const WB_PARSER_URL = process.env.WB_PARSER_URL || 'http://50fc4ca33bd1.vps.myjino.ru';
const WB_PARSER_SECRET = process.env.WB_PARSER_SECRET || 'cardzip-wb-2024';

interface ParserProduct {
  id: number;
  name: string;
  brand: string;
  price: number;
  rating: number;
  feedbacks: number;
}

interface ParserResponse {
  success: boolean;
  total: number;
  count: number;
  products: ParserProduct[];
  photoSearchConfirmed?: boolean;
}

function buildResult(data: ParserResponse): WbSearchResult | null {
  if (!data.success || !data.products?.length) return null;

  const prices = data.products.map((p) => p.price).filter((p) => p > 0);
  if (!prices.length) return null;

  const cards: WbCard[] = data.products
    .filter((p) => p.price > 0)
    .map((p) => ({
      title: p.name,
      price: p.price,
      url: `https://www.wildberries.ru/catalog/${p.id}/detail.aspx`,
      rating: p.rating || 0,
      feedbacks: p.feedbacks || 0,
    }));

  return {
    avgPrice: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
    minPrice: Math.round(Math.min(...prices)),
    maxPrice: Math.round(Math.max(...prices)),
    totalCards: data.total,
    topExamples: cards.slice(0, 3),
    allCards: cards,
    photoSearchConfirmed: data.photoSearchConfirmed ?? false,
  };
}

async function searchSimilar(query: string, imageUrl?: string): Promise<WbSearchResult | null> {
  console.log(`[wb] Поиск: image=${imageUrl ? 'yes' : 'no'}, query="${query}"`);

  try {
    const params = new URLSearchParams({ secret: WB_PARSER_SECRET, limit: '50' });
    if (imageUrl) params.set('image_url', imageUrl);
    if (query) params.set('query', query);

    const url = `${WB_PARSER_URL}/search-by-image?${params}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });

    if (!res.ok) {
      console.warn(`[wb] VPS parser HTTP ${res.status}`);
      return null;
    }

    const data = (await res.json()) as ParserResponse;
    const result = buildResult(data);

    if (result) {
      console.log(`[wb] Результат: ${result.totalCards} карточек, avg: ${result.avgPrice}₽, photoConfirmed: ${result.photoSearchConfirmed}`);
    } else {
      console.log('[wb] Нет результатов');
    }

    return result;
  } catch (e) {
    console.warn('[wb] VPS parser failed:', e instanceof Error ? e.message : e);
    return null;
  }
}

export const marketProvider: MarketProvider = { searchSimilar };

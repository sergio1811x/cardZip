import type { MarketProvider, WbSearchResult } from '../types';

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
}

function buildResult(data: ParserResponse): WbSearchResult | null {
  if (!data.success || !data.products?.length) return null;

  const prices = data.products.map((p) => p.price).filter((p) => p > 0);
  if (!prices.length) return null;

  return {
    avgPrice: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
    minPrice: Math.round(Math.min(...prices)),
    maxPrice: Math.round(Math.max(...prices)),
    totalCards: data.total,
    topExamples: data.products
      .filter((p) => p.price > 0)
      .slice(0, 3)
      .map((p) => ({
        title: p.name,
        price: p.price,
        url: `https://www.wildberries.ru/catalog/${p.id}/detail.aspx`,
      })),
  };
}

async function searchSimilar(query: string, imageUrl?: string): Promise<WbSearchResult | null> {
  if (!imageUrl) {
    console.log('[wb] Нет фото для поиска');
    return null;
  }

  console.log(`[wb] Поиск по фото через VPS: ${imageUrl.slice(0, 60)}...`);

  try {
    const url = `${WB_PARSER_URL}/search-by-image?secret=${WB_PARSER_SECRET}&image_url=${encodeURIComponent(imageUrl)}&limit=50`;
    const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });

    if (!res.ok) {
      console.warn(`[wb] VPS parser HTTP ${res.status}`);
      return null;
    }

    const data = (await res.json()) as ParserResponse;
    const result = buildResult(data);

    if (result) {
      console.log(`[wb] Результат: ${result.totalCards} карточек, avg: ${result.avgPrice}₽`);
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

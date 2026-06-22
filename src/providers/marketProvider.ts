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
  fallback?: boolean;
}

function buildResult(data: ParserResponse): WbSearchResult | null {
  if (!data.success || !data.products?.length) return null;

  const prices = data.products.map((p) => p.price).filter((p) => p > 0);
  if (!prices.length) return null;

  const avgPrice = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
  const minPrice = Math.round(Math.min(...prices));
  const maxPrice = Math.round(Math.max(...prices));

  const topExamples = data.products
    .filter((p) => p.price > 0)
    .slice(0, 3)
    .map((p) => ({
      title: p.name,
      price: p.price,
      url: `https://www.wildberries.ru/catalog/${p.id}/detail.aspx`,
    }));

  console.log(`[wb] Результат: ${data.total} карточек, avg: ${avgPrice}₽`);

  return { avgPrice, minPrice, maxPrice, totalCards: data.total, topExamples };
}

async function searchByImage(imageUrl: string): Promise<WbSearchResult | null> {
  console.log(`[wb] Поиск по фото: ${imageUrl.slice(0, 80)}...`);

  try {
    const url = `${WB_PARSER_URL}/search-by-image?secret=${WB_PARSER_SECRET}&image_url=${encodeURIComponent(imageUrl)}&limit=50`;
    const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
    if (!res.ok) return null;

    const data = (await res.json()) as ParserResponse;
    if (data.fallback) return null; // кнопка камеры не найдена
    return buildResult(data);
  } catch (e) {
    console.warn('[wb] Поиск по фото не удался:', e instanceof Error ? e.message : e);
    return null;
  }
}

async function searchByText(query: string): Promise<WbSearchResult | null> {
  const shortQuery = query
    .replace(/['"«»]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 5)
    .join(' ');

  console.log(`[wb] Поиск по тексту: "${shortQuery}"`);

  try {
    const url = `${WB_PARSER_URL}/search?secret=${WB_PARSER_SECRET}&query=${encodeURIComponent(shortQuery)}&limit=50`;
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return null;

    const data = (await res.json()) as ParserResponse;
    return buildResult(data);
  } catch (e) {
    console.warn('[wb] Поиск по тексту не удался:', e instanceof Error ? e.message : e);
    return null;
  }
}

async function searchSimilar(query: string, imageUrl?: string): Promise<WbSearchResult | null> {
  // Приоритет: поиск по фото → fallback на текст
  if (imageUrl) {
    const imgResult = await searchByImage(imageUrl);
    if (imgResult) return imgResult;
    console.log('[wb] Фото-поиск не дал результатов, пробуем текст...');
  }

  return searchByText(query);
}

export const marketProvider: MarketProvider & { searchByImage: typeof searchByImage } = {
  searchSimilar,
  searchByImage,
};

import type { MarketProvider, WbSearchResult } from '../types';

// ─── WB search API response ───────────────────────────────────────────────────

interface WbSearchProduct {
  id: number;
  name: string;
  salePriceU: number; // цена в копейках
  brand?: string;
}

interface WbSearchResponse {
  data?: {
    products?: WbSearchProduct[];
    total?: number;
  };
}

// ─── Implementation ───────────────────────────────────────────────────────────

async function searchSimilar(query: string): Promise<WbSearchResult | null> {
  if (!query.trim()) return null;

  // Берём первые 5 значимых слов для поиска — длинные названия дают 0 результатов
  const shortQuery = query
    .replace(/['"«»]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 5)
    .join(' ');

  console.log(`[wb] Поиск: "${shortQuery}"`);
  const encoded = encodeURIComponent(shortQuery);
  const url = `https://search.wb.ru/exactmatch/ru/common/v9/search?query=${encoded}&resultset=catalog&limit=20&sort=popular&dest=-1257786`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WBCopilot/1.0)',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    console.warn('[wb] search.wb.ru недоступен:', e);
    return null; // graceful degradation
  }

  if (!res.ok) {
    console.warn('[wb] HTTP', res.status);
    return null;
  }

  let data: WbSearchResponse;
  try {
    data = (await res.json()) as WbSearchResponse;
  } catch {
    return null;
  }

  const products = data.data?.products ?? [];
  console.log(`[wb] Найдено: ${products.length} товаров, total: ${data.data?.total ?? '?'}`);
  if (!products.length) return null;

  const prices = products.map((p) => p.salePriceU / 100);
  const avgPrice = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
  const minPrice = Math.round(Math.min(...prices));
  const maxPrice = Math.round(Math.max(...prices));

  const topExamples = products.slice(0, 3).map((p) => ({
    title: p.name,
    price: Math.round(p.salePriceU / 100),
    url: `https://www.wildberries.ru/catalog/${p.id}/detail.aspx`,
  }));

  return {
    avgPrice,
    minPrice,
    maxPrice,
    totalCards: data.data?.total ?? products.length,
    topExamples,
  };
}

export const marketProvider: MarketProvider = { searchSimilar };

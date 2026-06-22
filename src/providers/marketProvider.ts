import type { MarketProvider, WbSearchResult } from '../types';

const WB_PARSER_URL = process.env.WB_PARSER_URL || 'http://50fc4ca33bd1.vps.myjino.ru';
const WB_PARSER_SECRET = process.env.WB_PARSER_SECRET || 'cardzip-wb-2024';

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

// ─── Шаг 1: Определить категорию по фото ─────────────────────────────────────

async function detectCategory(imageBuffer: Buffer): Promise<string | null> {
  try {
    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).slice(2);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      imageBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const res = await fetch('https://category-detection.wildberries.ru/api/triton_predict_sync', {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'User-Agent': MOBILE_UA,
        'Origin': 'https://www.wildberries.ru',
        'Referer': 'https://www.wildberries.ru/',
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.warn(`[wb] Category detection HTTP ${res.status}`);
      return null;
    }

    const data = (await res.json()) as {
      predictions?: Array<{ label?: string; confidence?: number }>;
    };

    const pred = data.predictions?.[0];
    if (pred?.label) {
      console.log(`[wb] Category: "${pred.label}" (${(pred.confidence ?? 0 * 100).toFixed(0)}%)`);
      return pred.label;
    }
    return null;
  } catch (e) {
    console.warn('[wb] Category detection failed:', e instanceof Error ? e.message : e);
    return null;
  }
}

// ─── Шаг 2: Поиск по фото + категории ───────────────────────────────────────

async function searchByPhoto(imageBuffer: Buffer, label: string): Promise<number[]> {
  try {
    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).slice(2);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      imageBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const url = `https://search-by-photo.wb.ru/uploadsearch?label_list=${encodeURIComponent(label)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'User-Agent': MOBILE_UA,
        'Origin': 'https://www.wildberries.ru',
        'Referer': 'https://www.wildberries.ru/',
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.warn(`[wb] Photo search HTTP ${res.status}`);
      return [];
    }

    const data = (await res.json()) as {
      result?: Array<{ im_name: number }>;
    };

    const ids = (data.result ?? []).map((r) => r.im_name).filter(Boolean);
    console.log(`[wb] Photo search: ${ids.length} products found`);
    return ids;
  } catch (e) {
    console.warn('[wb] Photo search failed:', e instanceof Error ? e.message : e);
    return [];
  }
}

// ─── Шаг 3: Получить детали товаров по ID ────────────────────────────────────

interface CardProduct {
  id: number;
  name: string;
  brand: string;
  salePriceU: number;
  reviewRating: number;
  feedbacks: number;
}

async function getProductDetails(ids: number[]): Promise<CardProduct[]> {
  // Берём первые 50 ID
  const batch = ids.slice(0, 50);
  const nmList = batch.join(';');

  try {
    const url = `https://card.wb.ru/cards/v2/detail?appType=1&curr=rub&dest=-1257786&spp=30&nm=${nmList}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': MOBILE_UA },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.warn(`[wb] Card API HTTP ${res.status}`);
      return [];
    }

    const data = (await res.json()) as {
      data?: { products?: CardProduct[] };
    };

    return data.data?.products ?? [];
  } catch (e) {
    console.warn('[wb] Card API failed:', e instanceof Error ? e.message : e);
    return [];
  }
}

// ─── Скачать фото ────────────────────────────────────────────────────────────

async function downloadImage(imageUrl: string): Promise<Buffer | null> {
  try {
    const res = await fetch(imageUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

// ─── Основная функция ────────────────────────────────────────────────────────

function buildResult(products: CardProduct[], totalIds: number): WbSearchResult | null {
  const prices = products
    .map((p) => p.salePriceU ? Math.round(p.salePriceU / 100) : 0)
    .filter((p) => p > 0);

  if (!prices.length) return null;

  const avgPrice = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
  const minPrice = Math.round(Math.min(...prices));
  const maxPrice = Math.round(Math.max(...prices));

  const topExamples = products
    .filter((p) => p.salePriceU > 0)
    .slice(0, 3)
    .map((p) => ({
      title: p.name || p.brand || '',
      price: Math.round(p.salePriceU / 100),
      url: `https://www.wildberries.ru/catalog/${p.id}/detail.aspx`,
    }));

  console.log(`[wb] Результат: ${totalIds} карточек, avg: ${avgPrice}₽`);

  return { avgPrice, minPrice, maxPrice, totalCards: totalIds, topExamples };
}

async function searchSimilar(query: string, imageUrl?: string): Promise<WbSearchResult | null> {
  // Поиск по фото (приоритет)
  if (imageUrl) {
    console.log(`[wb] Поиск по фото: ${imageUrl.slice(0, 60)}...`);

    const imgBuffer = await downloadImage(imageUrl);
    if (imgBuffer) {
      // Шаг 1: категория
      const label = await detectCategory(imgBuffer);
      if (label) {
        // Шаг 2: поиск по фото
        const ids = await searchByPhoto(imgBuffer, label);
        if (ids.length) {
          // Шаг 3: детали товаров
          const products = await getProductDetails(ids);
          if (products.length) {
            return buildResult(products, ids.length);
          }
        }
      }
    }
    console.log('[wb] Фото-поиск не дал результатов');
  }

  // Fallback: текстовый поиск через VPS Playwright
  if (query) {
    const shortQuery = query.replace(/['"«»]/g, '').split(/\s+/).filter((w) => w.length > 2).slice(0, 5).join(' ');
    console.log(`[wb] Fallback текст: "${shortQuery}"`);

    try {
      const url = `${WB_PARSER_URL}/search?secret=${WB_PARSER_SECRET}&query=${encodeURIComponent(shortQuery)}&limit=50`;
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) return null;

      const data = (await res.json()) as { success: boolean; total: number; products: Array<{ id: number; name: string; price: number }> };
      if (!data.success || !data.products?.length) return null;

      const prices = data.products.map((p) => p.price).filter((p) => p > 0);
      if (!prices.length) return null;

      return {
        avgPrice: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
        minPrice: Math.round(Math.min(...prices)),
        maxPrice: Math.round(Math.max(...prices)),
        totalCards: data.total,
        topExamples: data.products.filter((p) => p.price > 0).slice(0, 3).map((p) => ({
          title: p.name, price: p.price, url: `https://www.wildberries.ru/catalog/${p.id}/detail.aspx`,
        })),
      };
    } catch {
      return null;
    }
  }

  return null;
}

export const marketProvider: MarketProvider = { searchSimilar };

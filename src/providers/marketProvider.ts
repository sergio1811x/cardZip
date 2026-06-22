import type { MarketProvider, WbSearchResult } from '../types';

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

const COMMON_HEADERS = {
  'User-Agent': MOBILE_UA,
  'Origin': 'https://www.wildberries.ru',
  'Referer': 'https://www.wildberries.ru/',
  'Accept': '*/*',
  'Accept-Language': 'ru,en;q=0.9,zh;q=0.8',
  'Sec-Ch-Ua-Mobile': '?1',
  'Sec-Ch-Ua-Platform': '"iOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
};

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

// ─── Шаг 1: Определить категорию по фото ─────────────────────────────────────

async function detectCategory(imageBuffer: Buffer): Promise<string | null> {
  try {
    const boundary = '----WebKitFormBoundarybaqpMM8p2H37B2R7';
    const qid = 'qid' + Date.now() + Math.floor(Math.random() * 1e10);

    // WB отправляет фото как бинарные данные в multipart
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      imageBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const res = await fetch('https://category-detection.wildberries.ru/api/triton_predict_sync', {
      method: 'POST',
      headers: {
        ...COMMON_HEADERS,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Query_id': qid,
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
      console.log(`[wb] Category: "${pred.label}" (${((pred.confidence ?? 0) * 100).toFixed(0)}%)`);
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
    const boundary = '----WebKitFormBoundarybaqpMM8p2H37B2R7';

    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      imageBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const url = `https://search-by-photo.wb.ru/uploadsearch?label_list=${encodeURIComponent(label)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...COMMON_HEADERS,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
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

// ─── Шаг 3: Получить детали товаров по ID (через list endpoint) ──────────────

interface WbProduct {
  id: number;
  name: string;
  brand: string;
  salePriceU: number;
  reviewRating: number;
  feedbacks: number;
}

async function getProductDetails(ids: number[]): Promise<WbProduct[]> {
  const batch = ids.slice(0, 50);
  const nmList = batch.join(';');

  try {
    const url = `https://card.wb.ru/cards/v2/list?appType=1&curr=rub&dest=-1257786&spp=30&nm=${nmList}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': MOBILE_UA },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.warn(`[wb] Card list HTTP ${res.status}`);
      return [];
    }

    const data = (await res.json()) as {
      data?: { products?: WbProduct[] };
    };

    const products = data.data?.products ?? [];
    console.log(`[wb] Card list: ${products.length} products with details`);
    return products;
  } catch (e) {
    console.warn('[wb] Card list failed:', e instanceof Error ? e.message : e);
    return [];
  }
}

// ─── Собрать результат ───────────────────────────────────────────────────────

function buildResult(products: WbProduct[], totalIds: number): WbSearchResult | null {
  const prices = products
    .map((p) => p.salePriceU ? Math.round(p.salePriceU / 100) : 0)
    .filter((p) => p > 0);

  if (!prices.length) return null;

  return {
    avgPrice: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
    minPrice: Math.round(Math.min(...prices)),
    maxPrice: Math.round(Math.max(...prices)),
    totalCards: totalIds,
    topExamples: products
      .filter((p) => p.salePriceU > 0)
      .slice(0, 3)
      .map((p) => ({
        title: p.name || p.brand || '',
        price: Math.round(p.salePriceU / 100),
        url: `https://www.wildberries.ru/catalog/${p.id}/detail.aspx`,
      })),
  };
}

// ─── Основная функция: только поиск по фото, без текстового fallback ─────────

async function searchSimilar(query: string, imageUrl?: string): Promise<WbSearchResult | null> {
  if (!imageUrl) {
    console.log('[wb] Нет фото для поиска');
    return null;
  }

  console.log(`[wb] Поиск по фото: ${imageUrl.slice(0, 60)}...`);

  const imgBuffer = await downloadImage(imageUrl);
  if (!imgBuffer) {
    console.warn('[wb] Не удалось скачать фото');
    return null;
  }
  console.log(`[wb] Фото скачано: ${imgBuffer.length} bytes`);

  // Шаг 1: категория
  const label = await detectCategory(imgBuffer);
  if (!label) {
    console.warn('[wb] Категория не определена');
    return null;
  }

  // Шаг 2: поиск по фото
  const ids = await searchByPhoto(imgBuffer, label);
  if (!ids.length) {
    console.warn('[wb] Нет результатов поиска по фото');
    return null;
  }

  // Шаг 3: детали товаров
  const products = await getProductDetails(ids);
  const result = buildResult(products, ids.length);

  if (result) {
    console.log(`[wb] Итого: ${result.totalCards} карточек, avg: ${result.avgPrice}₽`);
  }

  return result;
}

export const marketProvider: MarketProvider = { searchSimilar };

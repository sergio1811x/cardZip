import sharp from 'sharp';
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

interface CategoryResult {
  label: string;
  bbox: [number, number, number, number]; // x1, y1, x2, y2
}

async function detectCategory(imageBuffer: Buffer): Promise<CategoryResult | null> {
  try {
    const boundary = '----WebKitFormBoundarybaqpMM8p2H37B2R7';
    const qid = 'qid' + Date.now() + Math.floor(Math.random() * 1e10);

    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image_file"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
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
      predictions?: Array<{ label?: string; confidence?: number; bbox?: number[] }>;
    };

    const pred = data.predictions?.[0];
    if (pred?.label && pred.bbox?.length === 4) {
      console.log(`[wb] Category: "${pred.label}" (${((pred.confidence ?? 0) * 100).toFixed(0)}%) bbox: [${pred.bbox.map(n => Math.round(n)).join(',')}]`);
      return { label: pred.label, bbox: pred.bbox as [number, number, number, number] };
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
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
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

const WB_PARSER_URL = process.env.WB_PARSER_URL || 'http://50fc4ca33bd1.vps.myjino.ru';
const WB_PARSER_SECRET = process.env.WB_PARSER_SECRET || 'cardzip-wb-2024';

async function getProductDetails(ids: number[]): Promise<WbProduct[]> {
  const batch = ids.slice(0, 100);

  try {
    const url = `${WB_PARSER_URL}/prices?secret=${WB_PARSER_SECRET}&ids=${batch.join(',')}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });

    if (!res.ok) {
      console.warn(`[wb] Prices API HTTP ${res.status}`);
      return [];
    }

    const data = (await res.json()) as {
      success: boolean;
      products: Array<{ id: number; name: string; brand: string; price: number; rating: number; feedbacks: number }>;
    };

    if (!data.success) return [];

    console.log(`[wb] Prices: ${data.products.length} products`);
    return data.products.map((p) => ({
      id: p.id,
      name: p.name,
      brand: p.brand,
      salePriceU: p.price * 100,
      reviewRating: p.rating,
      feedbacks: p.feedbacks,
    }));
  } catch (e) {
    console.warn('[wb] Prices failed:', e instanceof Error ? e.message : e);
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

  // Шаг 1: категория + bbox
  const catResult = await detectCategory(imgBuffer);
  if (!catResult) {
    console.warn('[wb] Категория не определена');
    return null;
  }

  // Шаг 1.5: кроп по bbox (как WB делает в UI "Выберите область с товаром")
  let croppedBuffer = imgBuffer;
  try {
    const [x1, y1, x2, y2] = catResult.bbox;
    const metadata = await sharp(imgBuffer).metadata();
    const imgW = metadata.width ?? 800;
    const imgH = metadata.height ?? 800;

    // bbox в координатах модели (может быть масштабирован), приводим к пикселям
    const left = Math.max(0, Math.round(x1));
    const top = Math.max(0, Math.round(y1));
    const width = Math.min(Math.round(x2 - x1), imgW - left);
    const height = Math.min(Math.round(y2 - y1), imgH - top);

    if (width > 50 && height > 50) {
      croppedBuffer = await sharp(imgBuffer)
        .extract({ left, top, width, height })
        .jpeg({ quality: 85 })
        .toBuffer();
      console.log(`[wb] Cropped: ${imgW}x${imgH} → ${width}x${height} (${croppedBuffer.length} bytes)`);
    }
  } catch (e) {
    console.warn('[wb] Crop failed, using original:', e instanceof Error ? e.message : e);
  }

  // Шаг 2: поиск по кропнутому фото
  const ids = await searchByPhoto(croppedBuffer, catResult.label);
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

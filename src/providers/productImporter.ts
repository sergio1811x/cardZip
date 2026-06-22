import { AppError } from '../lib/errors';
import type { ProductImporter, RawProduct1688 } from '../types';

// ─── URL parser ───────────────────────────────────────────────────────────────

const PATTERNS = [
  /detail\.1688\.com\/offer\/(\d+)\.html/,
  /item\.1688\.com\/.*?(\d{10,})/,
  /1688\.com\/.*?offerId=(\d+)/,
];

function extractProductId(url: string): string | null {
  for (const pattern of PATTERNS) {
    const match = url.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

// ─── TopSAPI response schema (упрощённо) ─────────────────────────────────────

interface TopSApiResponse {
  item?: {
    itemId?: string | number;
    title?: string;
    salePrice?: number | string;
    minOrderQuantity?: number;
    grossWeight?: number;
    mainPic?: string;
    itemImages?: string[];
    sellerInfo?: {
      sellerNick?: string;
      totalScore?: number;
    };
  };
  error?: string;
}

// ─── Implementation ───────────────────────────────────────────────────────────

async function fetchProduct(url: string): Promise<RawProduct1688> {
  const productId = extractProductId(url);
  if (!productId) {
    throw new AppError(
      'INVALID_URL',
      `Не удалось извлечь productId из URL: ${url}`,
      '❌ Не похоже на ссылку с 1688. Пришли ссылку вида https://detail.1688.com/offer/XXXXXXXX.html'
    );
  }

  const apiKey = process.env.TOPSAPI_KEY;
  if (!apiKey) throw new Error('TOPSAPI_KEY не задан');

  const apiUrl = `https://api.topsapi.com/item/detail?api_key=${apiKey}&item_id=${productId}&platform=1688`;

  let res: Response;
  try {
    res = await fetch(apiUrl, { signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new AppError(
      'PROVIDER_DOWN',
      `TopSAPI таймаут: ${String(e)}`,
      '⏱ Сервис 1688 не отвечает. Попробуй через 1–2 минуты.'
    );
  }

  if (!res.ok) {
    throw new AppError(
      'PROVIDER_DOWN',
      `TopSAPI HTTP ${res.status}`,
      `⚠️ Не удалось получить данные товара (HTTP ${res.status}). Попробуй позже.`
    );
  }

  const json = (await res.json()) as TopSApiResponse;

  if (json.error || !json.item) {
    throw new AppError(
      'PROVIDER_DOWN',
      `TopSAPI вернул ошибку: ${json.error ?? 'нет item'}`,
      '⚠️ Товар не найден или ссылка устарела. Проверь URL и попробуй ещё раз.'
    );
  }

  const item = json.item;
  const images: string[] = (item.itemImages ?? (item.mainPic ? [item.mainPic] : [])).slice(0, 15);

  return {
    productId: String(item.itemId ?? productId),
    titleCn: String(item.title ?? ''),
    priceYuan: parseFloat(String(item.salePrice ?? '0')),
    moq: Number(item.minOrderQuantity ?? 1),
    weightKg: Number(item.grossWeight ?? 0),
    images,
    mainImageUrl: item.mainPic ?? images[0] ?? '',
    supplierName: item.sellerInfo?.sellerNick ?? '',
    supplierRating: item.sellerInfo?.totalScore,
  };
}

export const productImporter: ProductImporter = {
  fetchProduct,
  extractProductId,
};

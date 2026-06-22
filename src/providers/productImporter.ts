import { AppError } from '../lib/errors';
import type { ProductImporter, RawProduct1688, ParsedUrl, Platform } from '../types';

// ─── URL patterns ────────────────────────────────────────────────────────────

const URL_PATTERNS: Array<{ platform: Platform; regex: RegExp }> = [
  { platform: '1688', regex: /detail\.1688\.com\/offer\/(\d+)\.html/ },
  { platform: '1688', regex: /item\.1688\.com\/.*?(\d{10,})/ },
  { platform: '1688', regex: /1688\.com\/.*?offerId=(\d+)/ },
  { platform: 'taobao', regex: /item\.taobao\.com\/item\.htm\?.*?id=(\d+)/ },
  { platform: 'taobao', regex: /taobao\.com\/.*?id=(\d+)/ },
  { platform: 'taobao', regex: /m\.intl\.taobao\.com\/detail\/detail\.html\?.*?id=(\d+)/ },
  { platform: 'tmall', regex: /detail\.tmall\.com\/item\.htm\?.*?id=(\d+)/ },
  { platform: 'tmall', regex: /tmall\.com\/.*?id=(\d+)/ },
];

const SHORT_LINK_PATTERNS = [
  /qr\.1688\.com\//,
  /m\.1688\.com\//,
  /s\.click\.1688\.com\//,
];

function isShortLink(url: string): boolean {
  return SHORT_LINK_PATTERNS.some((p) => p.test(url));
}

async function resolveShortLink(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(8_000),
    });

    // Если редирект сработал — используем финальный URL
    if (res.url !== url) return res.url;

    // qr.1688.com отдаёт 200 с URL в теле (deep link формат)
    const body = await res.text();

    // Ищем m.1688.com/offer/XXX.html или detail.1688.com/offer/XXX.html
    const offerMatch = body.match(/(?:m|detail)\.1688\.com\/offer\/(\d+)\.html/);
    if (offerMatch) return `https://detail.1688.com/offer/${offerMatch[1]}.html`;

    // Ищем offerId=XXX
    const offerIdMatch = body.match(/offerId[=%]3D(\d+)/);
    if (offerIdMatch) return `https://detail.1688.com/offer/${offerIdMatch[1]}.html`;

    // Ищем taobao id=XXX
    const taobaoMatch = body.match(/(?:item\.taobao|detail\.tmall)\.com.*?id[=%]3D(\d+)/);
    if (taobaoMatch) return `https://item.taobao.com/item.htm?id=${taobaoMatch[1]}`;

    return url;
  } catch {
    return url;
  }
}

function parseUrl(url: string): ParsedUrl | null {
  for (const { platform, regex } of URL_PATTERNS) {
    const match = url.match(regex);
    if (match?.[1]) return { productId: match[1], platform };
  }
  return null;
}

// ─── Platform mapping: наш формат → Elim API ────────────────────────────────

function toElimPlatform(platform: Platform): 'alibaba' | 'taobao' {
  return platform === '1688' ? 'alibaba' : 'taobao';
}

// ─── Elim API ────────────────────────────────────────────────────────────────

interface ElimResponse {
  success?: boolean;
  id?: string;
  mp_id?: string;
  title?: string;
  titleEn?: string;
  price?: number;
  price_range?: Array<{ min_quantity?: number; max_quantity?: number; price?: number }>;
  promotion_price?: number;
  quantity?: number;
  moq?: number;
  shop_name?: string;
  shop_id?: string;
  img_urls?: string[];
  seller_type?: string;
  level?: number;
  sold?: number;
  attributes?: Array<{ name?: string; value?: string }>;
  shipping_info?: Array<{ weight?: number }>;
  code?: number;
  message?: string;
}

async function fetchProduct(url: string): Promise<RawProduct1688> {
  // Резолвим короткие ссылки из мобильного приложения
  let resolvedUrl = url;
  if (isShortLink(url)) {
    console.log(`[import] Resolving short link: ${url}`);
    resolvedUrl = await resolveShortLink(url);
    console.log(`[import] Resolved to: ${resolvedUrl}`);
  }

  const parsed = parseUrl(resolvedUrl);
  if (!parsed) {
    throw new AppError(
      'INVALID_URL',
      `Не удалось распознать URL: ${resolvedUrl} (original: ${url})`,
      '❌ Не удалось распознать ссылку.\n\nПоддерживаемые форматы:\n• https://detail.1688.com/offer/XXX.html\n• https://item.taobao.com/item.htm?id=XXX\n• Короткие ссылки из приложения 1688'
    );
  }

  const { productId, platform } = parsed;
  const apiKey = process.env.ELIM_API_KEY;
  if (!apiKey) throw new Error('ELIM_API_KEY не задан');

  let res: Response;
  try {
    res = await fetch('https://openapi.elim.asia/v1/products/find', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        id: productId,
        platform: toElimPlatform(platform),
        lang: 'en',
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new AppError(
      'PROVIDER_DOWN',
      `Elim таймаут: ${platform}/${productId}`,
      '⏱ Сервис не отвечает. Попробуй через 1–2 минуты.'
    );
  }

  if (!res.ok) {
    throw new AppError(
      'PROVIDER_DOWN',
      `Elim HTTP ${res.status}`,
      `⚠️ Не удалось получить данные товара (HTTP ${res.status}). Попробуй позже.`
    );
  }

  const json = (await res.json()) as ElimResponse;

  if (!json.success || !json.title) {
    throw new AppError(
      'PROVIDER_DOWN',
      `Elim ошибка: ${json.message ?? JSON.stringify(json).slice(0, 300)}`,
      '⚠️ Товар не найден или ссылка устарела. Проверь URL и попробуй ещё раз.'
    );
  }

  const images = (json.img_urls ?? []).slice(0, 15);

  // Вес: пробуем из shipping_info; если > 10кг при цене < 50¥ — скорее всего вес партии, обнуляем
  let weightKg = json.shipping_info?.[0]?.weight ?? 0;
  const priceRaw = json.promotion_price ?? json.price ?? json.price_range?.[0]?.price ?? 0;
  if (weightKg > 10 && priceRaw < 50) {
    console.warn(`[import] Подозрительный вес ${weightKg}кг при цене ${priceRaw}¥, сбрасываем`);
    weightKg = 0;
  }

  // Цена: promotion_price → price → первый элемент price_range
  const price = json.promotion_price ?? json.price ?? json.price_range?.[0]?.price ?? 0;

  console.log(`[import] Elim success: ${platform}/${productId}`);

  return {
    productId: String(json.id ?? json.mp_id ?? productId),
    platform,
    titleCn: json.title,
    priceYuan: price,
    moq: json.moq ?? 1,
    weightKg,
    images,
    mainImageUrl: images[0] ?? '',
    supplierName: json.shop_name ?? '',
    supplierRating: json.level,
  };
}

export const productImporter: ProductImporter = { fetchProduct, parseUrl };

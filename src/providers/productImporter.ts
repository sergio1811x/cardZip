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
  description?: string;
  price?: number;
  price_range?: Array<{ min_quantity?: number; max_quantity?: number; price?: number }>;
  promotion_price?: number;
  quantity?: number;
  moq?: number;
  shop_name?: string;
  shop_id?: string;
  img_urls?: string[];
  seller_type?: 'factory' | 'merchant' | 'seller';
  level?: number;
  sold?: number;
  category_name?: string;
  attributes?: Array<{ name?: string; value?: string }>;
  skus?: Array<{ name?: string; price?: number; quantity?: number; pic_url?: string }>;
  shipping_info?: Array<{ weight?: number }>;
  extra_info?: Array<Record<string, unknown>>;
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

  const doFetch = () => fetch('https://openapi.elim.asia/v1/products/find', {
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
    signal: AbortSignal.timeout(20_000),
  });

  const MAX_RETRIES = 2;
  let res: Response | undefined;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      res = await doFetch();
      break;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[elim] Попытка ${attempt}/${MAX_RETRIES} не удалась: ${msg}`);
      if (attempt === MAX_RETRIES) {
        throw new AppError(
          'PROVIDER_DOWN',
          `Elim недоступен после ${MAX_RETRIES} попыток: ${platform}/${productId}`,
          '⏱ Сервис не отвечает. Попробуйте через 1–2 минуты.'
        );
      }
    }
  }

  if (!res) {
    throw new AppError('PROVIDER_DOWN', 'Elim: res undefined', '⏱ Сервис не отвечает. Попробуйте позже.');
  }

  if (!res.ok) {
    throw new AppError(
      'PROVIDER_DOWN',
      `Elim HTTP ${res.status}`,
      `⚠️ Не удалось получить данные товара (HTTP ${res.status}). Попробуйте позже.`
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

  // Вес: приоритет — из атрибутов товара (вес штуки), потом shipping_info (часто вес партии)
  const weightAttrs = (json.attributes ?? []).filter((a) =>
    a.name && /重量|净重|毛重|weight|вес/i.test(a.name)
  );
  let weightKg = 0;

  if (weightAttrs.length) {
    // Парсим вес из атрибутов: "0.35kg", "350g", "0.5千克" и т.д.
    const raw = weightAttrs[0].value ?? '';
    const kgMatch = raw.match(/([\d.]+)\s*(kg|千克|公斤)/i);
    const gMatch = raw.match(/([\d.]+)\s*(g|克)/i);
    if (kgMatch) weightKg = parseFloat(kgMatch[1]);
    else if (gMatch) weightKg = parseFloat(gMatch[1]) / 1000;
    console.log(`[import] Вес из атрибутов: "${raw}" → ${weightKg}кг`);
  }

  if (!weightKg) {
    weightKg = json.shipping_info?.[0]?.weight ?? 0;
  }

  // Санитарная проверка
  const priceRaw = json.promotion_price ?? json.price ?? json.price_range?.[0]?.price ?? 0;
  if (weightKg > 50 || (weightKg > 5 && priceRaw < 200)) {
    console.warn(`[import] Подозрительный вес ${weightKg}кг при цене ${priceRaw}¥, сбрасываем`);
    weightKg = 0;
  }

  // Цена: promotion_price → price → первый элемент price_range
  const price = json.promotion_price ?? json.price ?? json.price_range?.[0]?.price ?? 0;

  // Оптовые цены
  const priceRange = (json.price_range ?? [])
    .filter((r) => r.price != null)
    .map((r) => ({
      minQty: r.min_quantity ?? 0,
      maxQty: r.max_quantity ?? 0,
      price: r.price!,
    }));

  // Характеристики
  const attributes = (json.attributes ?? [])
    .filter((a) => a.name && a.value)
    .map((a) => ({ name: a.name!, value: a.value! }));

  // SKU варианты
  const skus = (json.skus ?? [])
    .filter((s) => s.name)
    .map((s) => ({
      name: s.name!,
      price: s.price,
      stock: s.quantity,
      image: s.pic_url,
    }));

  console.log(`[import] Elim success: ${platform}/${productId} | attrs:${attributes.length} skus:${skus.length} sold:${json.sold ?? '?'}`);

  return {
    productId: String(json.id ?? json.mp_id ?? productId),
    platform,
    titleCn: json.title,
    titleEn: json.titleEn,
    description: json.description,
    priceYuan: price,
    priceRange: priceRange.length > 0 ? priceRange : undefined,
    moq: json.moq ?? 1,
    weightKg,
    images,
    mainImageUrl: images[0] ?? '',
    supplierName: json.shop_name ?? '',
    supplierRating: json.level,
    supplierType: json.seller_type,
    sold: json.sold,
    stock: json.quantity,
    categoryName: json.category_name,
    attributes: attributes.length > 0 ? attributes : undefined,
    skus: skus.length > 0 ? skus : undefined,
    supplierExtra: json.extra_info ? {
      dropshipping: (json.extra_info as any[]).some((e: any) => e.isOnePsale),
      mixOrder: (json.extra_info as any[]).some((e: any) => e.isSupportMix),
      freeReturn7d: (json.extra_info as any[]).some((e: any) => e.noReason7DReturn),
      selectedSource: (json.extra_info as any[]).some((e: any) => e['1688_yx']),
    } : undefined,
  };
}

export const productImporter: ProductImporter = { fetchProduct, parseUrl };

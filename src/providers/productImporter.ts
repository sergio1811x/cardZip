import { AppError } from '../lib/errors';
import type {
  Normalized1688Data,
  ParsedUrl,
  Platform,
  PriceRange,
  ProductAttribute,
  ProductImporter,
  ProductSku,
  QuoteType,
  RawProduct1688,
} from '../types';

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
  quote_type?: string;
  repurchase_rate?: string | number;
  code?: number;
  message?: string;
}

function normalizeNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const cleaned = value.replace(',', '.').replace(/[^\d.]+/g, '');
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function mapQuoteType(value: unknown, hasSkus: boolean, hasRanges: boolean): QuoteType {
  if (value === 'direct' || value === 'by_sku' || value === 'by_volume') return value;
  if (hasSkus) return 'by_sku';
  if (hasRanges) return 'by_volume';
  return 'direct';
}

function parseWeightKg(attributes: Array<{ name?: string; value?: string }>, shippingInfo?: Array<{ weight?: number }>): number {
  const weightAttrs = attributes.filter((a) => a.name && /重量|净重|毛重|weight|вес/i.test(a.name));
  let weightKg = 0;

  if (weightAttrs.length) {
    const raw = weightAttrs[0].value ?? '';
    const kgMatch = raw.match(/([\d.]+)\s*(kg|千克|公斤)/i);
    const gMatch = raw.match(/([\d.]+)\s*(g|克)/i);
    const numOnly = raw.match(/^([\d.]+)$/);
    if (kgMatch) weightKg = parseFloat(kgMatch[1]);
    else if (gMatch) weightKg = parseFloat(gMatch[1]) / 1000;
    else if (numOnly) {
      const val = parseFloat(numOnly[1]);
      weightKg = val >= 100 ? val / 1000 : val;
    }
    console.log(`[import] Вес из атрибутов: "${raw}" → ${weightKg}кг`);
  }

  if (!weightKg) weightKg = shippingInfo?.[0]?.weight ?? 0;
  return weightKg;
}

function buildPriceRanges(ranges: ElimResponse['price_range']): PriceRange[] {
  return (ranges ?? [])
    .filter((r) => r.price != null)
    .map((r) => ({
      minQty: r.min_quantity ?? 0,
      maxQty: r.max_quantity ?? 0,
      price: r.price!,
    }));
}

function buildAttributes(attributes: ElimResponse['attributes']): ProductAttribute[] {
  return (attributes ?? [])
    .filter((a) => a.name && a.value)
    .map((a) => ({ name: a.name!, value: a.value! }));
}

function buildSkus(skus: ElimResponse['skus']): ProductSku[] {
  return (skus ?? [])
    .filter((s) => s.name)
    .map((s) => ({
      name: s.name!,
      price: s.price,
      stock: s.quantity,
      image: s.pic_url,
    }));
}

function pickKeyAttributes(categoryName: string | undefined, attributes: ProductAttribute[]): Array<{ label: string; value: string }> {
  const category = (categoryName ?? '').toLowerCase();
  const groups = {
    tech: ['功率', '电压', '分辨率', '亮度', '认证', '证书', '接口', '配置', '套装', '配件', 'power', 'voltage', 'resolution', 'brightness', 'certificate', 'certification', 'package', 'accessories'],
    clothing: ['材质', '面料', '季节', '尺码', '颜色', '版型', '厚薄', '弹力', 'material', 'fabric', 'season', 'size', 'color', 'fit'],
    accessories: ['材质', '尺寸', '颜色', '闭合', '拉链', '隔层', '肩带', 'material', 'size', 'color', 'closure', 'zipper', 'compartment'],
  };

  const type = /服|衣|裤|鞋|dress|shirt|jacket|pants|clothing|apparel/.test(category)
    ? 'clothing'
    : /包|箱|belt|wallet|bag|backpack|accessor/.test(category)
      ? 'accessories'
      : 'tech';

  const keywords = groups[type];
  const selected: Array<{ label: string; value: string }> = [];
  const seen = new Set<string>();

  for (const attr of attributes) {
    const hay = `${attr.name} ${attr.value}`.toLowerCase();
    if (!keywords.some((kw) => hay.includes(kw.toLowerCase()))) continue;
    if (seen.has(attr.name)) continue;
    selected.push({ label: attr.name, value: attr.value });
    seen.add(attr.name);
    if (selected.length >= 5) break;
  }

  if (selected.length < 3) {
    for (const attr of attributes) {
      if (seen.has(attr.name)) continue;
      selected.push({ label: attr.name, value: attr.value });
      seen.add(attr.name);
      if (selected.length >= 5) break;
    }
  }

  return selected;
}

function buildNormalizedProduct(json: ElimResponse, platform: Platform, productId: string): RawProduct1688 {
  const images = (json.img_urls ?? []).slice(0, 15);
  const attributes = buildAttributes(json.attributes);
  const skus = buildSkus(json.skus);
  const priceRange = buildPriceRanges(json.price_range);
  const quoteType = mapQuoteType(json.quote_type, skus.length > 0, priceRange.length > 0);
  const rawPriceFields = [
    json.price != null ? 'price' : null,
    json.promotion_price != null ? 'promotion_price' : null,
    priceRange.length > 0 ? 'price_range' : null,
    skus.some((sku) => typeof sku.price === 'number' && sku.price > 0) ? 'skus.price' : null,
  ].filter((v): v is string => !!v);

  const skuPrices = skus
    .map((s) => s.price)
    .filter((p): p is number => p != null && p > 0)
    .sort((a, b) => a - b);

  const directPrice = normalizeNumber(json.price);
  const promotionPrice = normalizeNumber(json.promotion_price);
  const volumePrices = priceRange.map((r) => r.price).filter((price) => price > 0);
  const rawWeightKg = parseWeightKg(json.attributes ?? [], json.shipping_info);
  const sanityPrice = promotionPrice ?? directPrice ?? skuPrices[0] ?? volumePrices[0] ?? 0;
  let weightKg = rawWeightKg;
  if (weightKg > 50 || (weightKg > 5 && sanityPrice < 200)) {
    console.warn(`[import] Подозрительный вес ${weightKg}кг при цене ${sanityPrice}¥, сбрасываем`);
    weightKg = 0;
  }

  let displayPriceYuan = 0;
  let selectedSkuName: string | undefined;
  let selectedSkuPriceYuan: number | undefined;

  if (quoteType === 'direct') {
    displayPriceYuan = promotionPrice ?? directPrice ?? 0;
  } else if (quoteType === 'by_sku') {
    if (skuPrices.length >= 3) {
      const mid = Math.floor(skuPrices.length / 2);
      displayPriceYuan = skuPrices.length % 2 ? skuPrices[mid] : (skuPrices[mid - 1] + skuPrices[mid]) / 2;
    } else {
      displayPriceYuan = skuPrices[0] ?? promotionPrice ?? directPrice ?? 0;
    }
    const selected = skus.find((sku) => sku.price === displayPriceYuan) ?? skus.find((sku) => sku.price != null);
    selectedSkuName = selected?.name;
    selectedSkuPriceYuan = selected?.price;
  } else {
    displayPriceYuan = volumePrices[0] ?? promotionPrice ?? directPrice ?? 0;
  }

  const extraInfoFlat = Object.assign({}, ...(json.extra_info ?? []));
  const repurchaseRate = json.repurchase_rate != null
    ? String(json.repurchase_rate)
    : typeof extraInfoFlat.repurchaseRate !== 'undefined'
      ? String(extraInfoFlat.repurchaseRate)
      : undefined;

  const normalized1688: Normalized1688Data = {
    pricing: {
      quoteType,
      displayPriceYuan,
      directPriceYuan: directPrice,
      promotionPriceYuan: promotionPrice,
      skuMinPriceYuan: skuPrices[0],
      skuMaxPriceYuan: skuPrices[skuPrices.length - 1],
      volumeMinPriceYuan: volumePrices.length ? Math.min(...volumePrices) : undefined,
      volumeMaxPriceYuan: volumePrices.length ? Math.max(...volumePrices) : undefined,
      selectedSkuName,
      selectedSkuPriceYuan,
      priceRanges: priceRange.length > 0 ? priceRange : undefined,
      rawPriceFields,
    },
    moq: json.moq ?? priceRange.find((r) => r.minQty > 0)?.minQty,
    skuCount: skus.length,
    skuVariants: skus,
    supplierType: json.seller_type,
    salesCount: json.sold,
    repurchaseRate,
    imageCount: images.length,
    images,
    weightKg: weightKg > 0 ? weightKg : undefined,
    attributes,
    keyAttributes: pickKeyAttributes(json.category_name, attributes),
    sellerExtraInfo: Object.keys(extraInfoFlat).length ? extraInfoFlat : undefined,
    soldCountText: json.sold != null ? String(json.sold) : undefined,
    debug: {
      quoteType,
      rawPriceFields,
      skuCount: skus.length,
      attributesCount: attributes.length,
      imageCount: images.length,
      sellerType: json.seller_type,
      extraInfoKeys: Object.keys(extraInfoFlat),
      missingCriticalFields: [
        displayPriceYuan <= 0 ? 'price' : null,
        !(json.moq ?? priceRange.find((r) => r.minQty > 0)?.minQty) ? 'moq' : null,
        images.length === 0 ? 'images' : null,
        attributes.length === 0 ? 'attributes' : null,
      ].filter((v): v is string => !!v),
    },
  };

  console.log(`[import] Elim success: ${platform}/${productId} | quote:${quoteType} attrs:${attributes.length} skus:${skus.length} sold:${json.sold ?? '?'} images:${images.length}`);

  return {
    productId: String(json.id ?? json.mp_id ?? productId),
    platform,
    titleCn: json.title ?? '',
    titleEn: json.titleEn,
    description: json.description,
    priceYuan: normalized1688.pricing.displayPriceYuan,
    priceRange: priceRange.length > 0 ? priceRange : undefined,
    priceIsRange: quoteType !== 'direct' || priceRange.length > 1,
    moq: normalized1688.moq ?? 1,
    weightKg: normalized1688.weightKg ?? 0,
    images,
    mainImageUrl: images[0] ?? skus.find((sku) => sku.image)?.image ?? '',
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
    selectedSkuName,
    normalized1688,
  };
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

  return buildNormalizedProduct(json, platform, productId);
}

export const productImporter: ProductImporter = { fetchProduct, parseUrl };

import { AppError } from '../lib/errors';
import { translateSkuNamesViaLlm } from '../core/cnTranslate';
import { fetchFromRapidApi } from './rapidApiProvider';
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

    if (res.url !== url) return res.url;

    const body = await res.text();

    const offerMatch = body.match(/(?:m|detail)\.1688\.com\/offer\/(\d+)\.html/);
    if (offerMatch) return `https://detail.1688.com/offer/${offerMatch[1]}.html`;

    const offerIdMatch = body.match(/offerId[=%]3D(\d+)/);
    if (offerIdMatch) return `https://detail.1688.com/offer/${offerIdMatch[1]}.html`;

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
  price?: number | string;
  price_range?: Array<{ min_quantity?: number; max_quantity?: number; price?: number | string }>;
  promotion_price?: number | string;
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
  skus?: Array<{ name?: string; price?: number | string; quantity?: number; pic_url?: string }>;
  shipping_info?: Array<{ weight?: number }>;
  extra_info?: Array<Record<string, unknown>>;
  quote_type?: string;
  repurchase_rate?: string | number;
  code?: number;
  message?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function cleanText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function hasChinese(text: string): boolean {
  return /[一-鿿]/.test(text);
}

function normalizeNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  if (typeof value === 'string') {
    const normalized = value.replace(',', '.');
    const match = normalized.match(/\d+(?:\.\d+)?/);
    if (!match) return undefined;

    const parsed = Number(match[0]);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const n = normalizeNumber(value);
  return n != null && n > 0 ? n : undefined;
}

function uniqueNumbers(values: Array<number | undefined>): number[] {
  return Array.from(
      new Set(values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0)),
  ).sort((a, b) => a - b);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const v = cleanText(value);
    if (!v) continue;

    const key = v.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    result.push(v);
  }

  return result;
}

function mapQuoteType(value: unknown, hasSkus: boolean, hasRanges: boolean): QuoteType {
  if (value === 'direct' || value === 'by_sku' || value === 'by_volume') return value;
  if (hasSkus) return 'by_sku';
  if (hasRanges) return 'by_volume';
  return 'direct';
}

function isRawSkuCode(name: string): boolean {
  return /^\d+:\d+(;\d+:\d+)*$/.test(name.trim());
}

function splitAttrValues(value: string): string[] {
  return value
      .split(/[,，、;；/|]+/)
      .map((s) => cleanText(s))
      .filter(Boolean);
}

function extractAttrValues(
    attributes: ElimResponse['attributes'] | undefined,
    nameRegex: RegExp,
): string[] {
  const values: string[] = [];

  for (const a of attributes ?? []) {
    const name = cleanText(a.name);
    const value = cleanText(a.value);

    if (!name || !value) continue;
    if (!nameRegex.test(name)) continue;

    values.push(...splitAttrValues(value));
  }

  return uniqueStrings(values);
}

// ─── Weight / price / attributes / SKU ──────────────────────────────────────

function parseWeightKg(
    attributes: Array<{ name?: string; value?: string }>,
    shippingInfo?: Array<{ weight?: number }>,
): number {
  const weightAttrs = attributes.filter((a) => a.name && /重量|净重|毛重|weight|вес/i.test(a.name));
  let weightKg = 0;

  if (weightAttrs.length) {
    const raw = weightAttrs[0].value ?? '';
    const normalized = raw.replace(',', '.');

    const kgMatch = normalized.match(/([\d.]+)\s*(kg|千克|公斤)/i);
    const gMatch = normalized.match(/([\d.]+)\s*(g|克)/i);
    const numOnly = normalized.match(/^([\d.]+)$/);

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
  const result: PriceRange[] = [];

  for (const r of ranges ?? []) {
    const price = positiveNumber(r.price);
    if (!price) continue;

    result.push({
      minQty: r.min_quantity ?? 0,
      maxQty: r.max_quantity ?? 0,
      price,
    });
  }

  return result;
}

function buildAttributes(attributes: ElimResponse['attributes']): ProductAttribute[] {
  const seen = new Set<string>();
  const result: ProductAttribute[] = [];

  for (const a of attributes ?? []) {
    const name = cleanText(a.name);
    const value = cleanText(a.value);

    if (!name || !value) continue;
    if (value === '/' || value === '-' || value === '无' || value.toLowerCase() === 'null') continue;

    const key = `${name.toLowerCase()}::${value.toLowerCase()}`;
    if (seen.has(key)) continue;

    seen.add(key);
    result.push({ name, value });
  }

  return result;
}

function buildHumanSkuNames(count: number, attributes?: ElimResponse['attributes']): string[] {
  const colors = extractAttrValues(attributes, /颜色|color|цвет/i);
  const sizes = extractAttrValues(attributes, /尺码|size|размер/i);
  const specs = extractAttrValues(attributes, /规格|型号|款式|model|модель|вариант/i);

  const names: string[] = [];

  if (colors.length && sizes.length) {
    for (const color of colors) {
      for (const size of sizes) {
        names.push(`${color} / ${size}`);
        if (names.length >= count) return names;
      }
    }
  }

  if (colors.length >= count) return colors.slice(0, count);
  if (sizes.length >= count) return sizes.slice(0, count);
  if (specs.length >= count) return specs.slice(0, count);

  const mixed = uniqueStrings([...colors, ...sizes, ...specs]);

  if (mixed.length) {
    for (let i = 0; i < count; i++) {
      names.push(mixed[i] ? `Вариант ${i + 1}: ${mixed[i]}` : `Вариант ${i + 1}`);
    }

    return names;
  }

  return Array.from({ length: count }, (_, i) => `Вариант ${i + 1}`);
}

function buildSkus(skus: ElimResponse['skus'], attributes?: ElimResponse['attributes']): ProductSku[] {
  const raw = (skus ?? []).filter((s) => cleanText(s.name));
  if (!raw.length) return [];

  const allRawCodes = raw.every((s) => isRawSkuCode(cleanText(s.name)));
  const humanNames = allRawCodes ? buildHumanSkuNames(raw.length, attributes) : [];

  return raw.map((s, i) => {
    const rawName = cleanText(s.name);

    const name = allRawCodes
        ? humanNames[i] ?? `Вариант ${i + 1}`
        : isRawSkuCode(rawName)
            ? `Вариант ${i + 1}`
            : rawName;

    return {
      name,
      price: positiveNumber(s.price),
      stock: s.quantity,
      image: s.pic_url,
    };
  });
}

// ─── Normalization helpers ──────────────────────────────────────────────────

function pickKeyAttributes(
    categoryName: string | undefined,
    attributes: ProductAttribute[],
): Array<{ label: string; value: string }> {
  const category = (categoryName ?? '').toLowerCase();

  const groups = {
    tech: [
      '功率', '电压', '分辨率', '亮度', '认证', '证书', '接口', '配置', '套装', '配件',
      'power', 'voltage', 'resolution', 'brightness', 'certificate', 'certification', 'package', 'accessories',
    ],
    clothing: [
      '材质', '面料', '季节', '尺码', '颜色', '版型', '厚薄', '弹力',
      'material', 'fabric', 'season', 'size', 'color', 'fit',
    ],
    accessories: [
      '材质', '尺寸', '颜色', '闭合', '拉链', '隔层', '肩带',
      'material', 'size', 'color', 'closure', 'zipper', 'compartment',
    ],
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

    const key = `${attr.name.toLowerCase()}::${attr.value.toLowerCase()}`;
    if (seen.has(key)) continue;

    selected.push({ label: attr.name, value: attr.value });
    seen.add(key);

    if (selected.length >= 6) break;
  }

  if (selected.length < 3) {
    for (const attr of attributes) {
      const key = `${attr.name.toLowerCase()}::${attr.value.toLowerCase()}`;
      if (seen.has(key)) continue;

      selected.push({ label: attr.name, value: attr.value });
      seen.add(key);

      if (selected.length >= 6) break;
    }
  }

  return selected;
}

function flattenExtraInfo(extraInfo: ElimResponse['extra_info']): Record<string, unknown> {
  const extraInfoFlat: Record<string, unknown> = {};

  for (const item of extraInfo ?? []) {
    if (!item || typeof item !== 'object') continue;

    if ('key' in item && 'value' in item) {
      extraInfoFlat[String(item.key)] = item.value;
    } else {
      Object.assign(extraInfoFlat, item);
    }
  }

  return extraInfoFlat;
}

function buildSupplierExtra(extraInfo: ElimResponse['extra_info']) {
  if (!extraInfo) return undefined;

  return {
    dropshipping: (extraInfo as any[]).some((e: any) => e.isOnePsale),
    mixOrder: (extraInfo as any[]).some((e: any) => e.isSupportMix),
    freeReturn7d: (extraInfo as any[]).some((e: any) => e.noReason7DReturn),
    selectedSource: (extraInfo as any[]).some((e: any) => e['1688_yx']),
  };
}

async function safeTranslateSkuNames(product: RawProduct1688): Promise<RawProduct1688> {
  if (!product.skus?.length) return product;

  try {
    const names = product.skus.map((s) => s.name);
    const shouldTranslate = names.some((name) => hasChinese(name));

    if (!shouldTranslate) return product;

    const translated = await translateSkuNamesViaLlm(names, {
      titleCn: product.titleCn,
      titleRu: product.titleEn,
      categoryName: product.categoryName,
      attributes: product.attributes,
    });

    product.skus.forEach((s, i) => {
      if (translated[i]) s.name = translated[i];
    });

    if (product.normalized1688?.skuVariants) {
      product.normalized1688.skuVariants.forEach((s, i) => {
        if (translated[i]) s.name = translated[i];
      });
    }
  } catch (e) {
    console.warn(`[import] SKU translation failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  return product;
}

function sanitizeRawProduct(product: RawProduct1688): RawProduct1688 {
  if (product.skus?.length) {
    product.skus.forEach((sku, i) => {
      if (!sku.name || isRawSkuCode(sku.name)) {
        sku.name = `Вариант ${i + 1}`;
      }
    });
  }

  if (product.normalized1688?.skuVariants?.length) {
    product.normalized1688.skuVariants.forEach((sku, i) => {
      if (!sku.name || isRawSkuCode(sku.name)) {
        sku.name = `Вариант ${i + 1}`;
      }
    });
  }

  if (product.attributes?.length) {
    product.attributes = buildAttributes(product.attributes);
  }

  if (product.normalized1688?.attributes?.length) {
    product.normalized1688.attributes = buildAttributes(product.normalized1688.attributes);
  }

  return product;
}

// ─── Elim normalization ─────────────────────────────────────────────────────

function buildNormalizedProduct(json: ElimResponse, platform: Platform, productId: string): RawProduct1688 {
  const images = (json.img_urls ?? []).filter(Boolean).slice(0, 15);
  const attributes = buildAttributes(json.attributes);
  const skus = buildSkus(json.skus, json.attributes);
  const priceRange = buildPriceRanges(json.price_range);

  const skuPrices = uniqueNumbers(skus.map((s) => s.price));
  const directPrice = positiveNumber(json.price);
  const promotionPrice = positiveNumber(json.promotion_price);
  const volumePrices = uniqueNumbers(priceRange.map((r) => r.price));

  const quoteType = mapQuoteType(json.quote_type, skus.length > 0, priceRange.length > 0);

  const rawPriceFields = [
    directPrice != null ? 'price' : null,
    promotionPrice != null ? 'promotion_price' : null,
    priceRange.length > 0 ? 'price_range' : null,
    skuPrices.length > 0 ? 'skus.price' : null,
  ].filter((v): v is string => !!v);

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

  if (quoteType === 'by_sku' && skuPrices.length > 0) {
    displayPriceYuan = skuPrices[0];

    const selected = skus.find((sku) => sku.price === displayPriceYuan) ?? skus.find((sku) => sku.price != null);
    selectedSkuName = selected?.name;
    selectedSkuPriceYuan = selected?.price;
  } else if (quoteType === 'by_volume' && volumePrices.length > 0) {
    displayPriceYuan = Math.min(...volumePrices);
  } else {
    displayPriceYuan = promotionPrice ?? directPrice ?? 0;
  }

  if (displayPriceYuan <= 0) {
    if (volumePrices.length > 0) {
      displayPriceYuan = Math.min(...volumePrices);
      rawPriceFields.push('estimated:min_tiered');
    } else if (skuPrices.length > 0) {
      displayPriceYuan = skuPrices[0];
      rawPriceFields.push('estimated:min_sku');
    } else if (promotionPrice) {
      displayPriceYuan = promotionPrice;
      rawPriceFields.push('estimated:promo');
    } else if (directPrice) {
      displayPriceYuan = directPrice;
      rawPriceFields.push('estimated:direct');
    }

    if (displayPriceYuan > 0) {
      console.log(`[import] Fallback price: ${displayPriceYuan}¥ from ${rawPriceFields[rawPriceFields.length - 1]}`);
    }
  }

  const extraInfoFlat = flattenExtraInfo(json.extra_info);

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

  console.log(
      `[import] Elim success: ${platform}/${productId} | quote:${quoteType} price:${displayPriceYuan || '?'} attrs:${attributes.length} skus:${skus.length} sold:${json.sold ?? '?'} images:${images.length}`,
  );

  return {
    productId: String(json.id ?? json.mp_id ?? productId),
    platform,
    titleCn: json.title ?? '',
    titleEn: json.titleEn,
    description: json.description,
    priceYuan: normalized1688.pricing.displayPriceYuan,
    priceRange: priceRange.length > 0 ? priceRange : undefined,
    priceIsRange:
        (skuPrices.length > 1 && skuPrices[0] !== skuPrices[skuPrices.length - 1]) ||
        priceRange.length > 1,
    moq: json.moq ?? priceRange.find((r) => r.minQty > 0)?.minQty ?? 1,
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
    supplierExtra: buildSupplierExtra(json.extra_info),
    normalized1688,
  };
}

// ─── Providers ──────────────────────────────────────────────────────────────

async function fetchFromElim(productId: string, platform: Platform): Promise<RawProduct1688> {
  const apiKey = process.env.ELIM_API_KEY;

  if (!apiKey) {
    throw new AppError(
        'PROVIDER_DOWN',
        'ELIM_API_KEY не задан',
        '⏱ Не удалось получить данные товара. Попробуйте через 1–2 минуты.',
    );
  }

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
    signal: AbortSignal.timeout(15_000),
  });

  let elimError: string | null = null;

  try {
    const MAX_RETRIES = 2;
    let res: Response | undefined;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        res = await doFetch();
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[elim] Попытка ${attempt}/${MAX_RETRIES}: ${msg}`);

        if (attempt === MAX_RETRIES) {
          elimError = msg;
        }
      }
    }

    if (res?.ok) {
      const json = (await res.json()) as ElimResponse;

      if (json.success && json.title) {
        const product = buildNormalizedProduct(json, platform, productId);
        return sanitizeRawProduct(await safeTranslateSkuNames(product));
      }

      elimError = `Elim: ${json.message ?? 'no title'}`;
    } else if (res) {
      elimError = `Elim HTTP ${res.status}`;
    }
  } catch (e) {
    elimError = e instanceof Error ? e.message : String(e);
  }

  throw new AppError(
      'PROVIDER_DOWN',
      `Elim недоступен: ${elimError}`,
      '⏱ Не удалось получить данные товара. Попробуйте через 1–2 минуты.',
  );
}

// ─── Main importer ──────────────────────────────────────────────────────────

async function fetchProduct(url: string): Promise<RawProduct1688> {
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
        '❌ Не удалось распознать ссылку.\n\nПоддерживаемые форматы:\n• https://detail.1688.com/offer/XXX.html\n• https://item.taobao.com/item.htm?id=XXX\n• Короткие ссылки из приложения 1688',
    );
  }

  const { productId, platform } = parsed;

  // 1688: RapidAPI основной
  if (platform === '1688') {
    try {
      const rapidResult = await fetchFromRapidApi(productId);

      if (rapidResult) {
        console.log(`[import] RapidAPI success for 1688/${productId}`);
        return sanitizeRawProduct(await safeTranslateSkuNames(rapidResult));
      }

      console.warn(`[import] RapidAPI returned empty result for 1688/${productId}`);
    } catch (e) {
      console.warn(`[import] RapidAPI failed for 1688/${productId}: ${e instanceof Error ? e.message : String(e)}`);
    }

    // 1688 fallback: Elim
    try {
      const elimResult = await fetchFromElim(productId, platform);
      console.log(`[import] Elim fallback success for 1688/${productId}`);
      return elimResult;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);

      throw new AppError(
          'PROVIDER_DOWN',
          `RapidAPI и Elim недоступны для 1688/${productId}: ${msg}`,
          '⏱ Не удалось получить данные товара. Попробуйте через 1–2 минуты.',
      );
    }
  }

  // Taobao / Tmall: Elim основной
  return fetchFromElim(productId, platform);
}

export const productImporter: ProductImporter = { fetchProduct, parseUrl };
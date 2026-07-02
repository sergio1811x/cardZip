import type { CategoryPolicyProfile, ProductFactSheet } from '../types';
import { buildCategoryPolicyProfile } from './categoryPolicyRegistry';
import { buildProductFactSheet } from './factSheet';

export type CardZipCategoryType = 'shoes' | 'clothes' | 'electronics' | 'home' | 'beauty' | 'accessory' | 'kitchen' | 'fishing' | 'tools' | 'other';

export type ProductContextLike = {
  offerId?: string;
  identity?: {
    productType?: string;
    coreObject?: string;
    categoryType?: CardZipCategoryType;
    useCases?: string[];
    notThis?: string[];
    audience?: string;
    season?: string;
    gender?: string;
  };
  titles?: {
    titleCn?: string;
    cleanRu?: string;
    shortRu?: string;
    wbTitleDraft?: string;
  };
  facts?: Record<string, string>;
  sku?: {
    hasMultipleSku?: boolean;
    skuCount?: number;
    knownOptions?: string[];
    needsSelection?: boolean;
  };
  price?: {
    visiblePriceCny?: number | null;
    minPriceCny?: number | null;
    maxPriceCny?: number | null;
    source?: string;
    needsConfirmation?: boolean;
  };
  conflicts?: Array<{
    field: string;
    problem: string;
    severity: 'low' | 'medium' | 'high';
    action?: string;
  }>;
  missingCritical?: string[];
  wbSearch?: Record<string, unknown>;
  seoPolicy?: Record<string, unknown>;
  supplierQuestions?: Record<string, unknown>;
  riskTags?: string[];
  dataQuality?: Record<string, unknown>;
};

export type AnalysisSnapshot = {
  offerId: string;
  sourceUrl: string;
  createdAt: string;
  raw1688: {
    titleCn: string;
    attributesRaw: Record<string, unknown>;
    skus: unknown[];
    photosCount: number;
  };
  productContext: ProductContextLike;
  factSheet?: ProductFactSheet | null;
  categoryPolicy?: CategoryPolicyProfile | null;
  supplier: {
    name?: string;
    type?: string;
    rating?: string;
    orders?: string;
    moq: {
      value: number | null;
      source: 'parsed' | 'unknown' | 'supplier_answer';
      displayLabel: string;
    };
  };
  purchasePrice: {
    valueCny: number | null;
    minCny: number | null;
    maxCny: number | null;
    displayLabel: string;
    source:
      | 'selected_sku_price'
      | 'explicit_sku_price'
      | 'discount_tier_min'
      | 'price_range_min'
      | 'visible_1688_price'
      | 'manual_supplier_answer'
      | 'unknown';
    isSyntheticPrice: boolean;
    needsSkuConfirmation: boolean;
  };
  weight: {
    valueKg: number | null;
    packedWeightKg: number | null;
    source: 'parsed' | 'estimated' | 'supplier_answer' | 'unknown';
    displayLabel: string;
  };
  sku: {
    count: number;
    selectedSkuId: string | null;
    needsSelection: boolean;
    variants: Array<{ id: string; label: string; priceCny?: number | null }>;
  };
  market: {
    directAnalogsCount: number;
    similarAnalogsCount: number;
    broadCategoryCount: number;
    crossBorderCount: number;
    marketConfirmed: boolean;
    displayedMainPriceRub: number | null;
    displayedMainPriceType: 'median' | 'average' | 'unknown';
    canUseForEconomics: boolean;
    rejectedReason?: string;
    directAnalogs: Array<{
      title: string;
      priceRub: number | null;
      matchLevel: 'direct' | 'similar' | 'category' | 'rejected';
      confidence: number;
    }>;
  };
  economics: {
    status: 'confirmed' | 'preliminary' | 'partial' | 'not_calculated';
    purchasePriceCny: number | null;
    costRub: number | null;
    sellPriceRub: number | null;
    marginRub: number | null;
    roiPercent: number | null;
    assumptions: string[];
    missing: string[];
    canShowRoi: boolean;
    canShowMargin: boolean;
    warning?: string;
  };
  missingData: string[];
  conflicts: Array<{
    field: string;
    problem: string;
    severity: 'low' | 'medium' | 'high';
  }>;
  riskFlags: string[];
};

export type BuildAnalysisSnapshotInput = {
  offerId?: string;
  sourceUrl?: string;
  raw1688?: Record<string, unknown>;
  productContext?: ProductContextLike | null;
  supplier?: Record<string, unknown>;
  selectedSkuId?: string | null;
  market?: Partial<AnalysisSnapshot['market']> | Record<string, unknown> | null;
  economics?: Partial<AnalysisSnapshot['economics']> | Record<string, unknown> | null;
  missingData?: string[];
  riskFlags?: string[];
  createdAt?: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function safeString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  return fallback;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const normalized = value.replace(',', '.').replace(/[^\d.-]/g, '');
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function positiveNumber(value: unknown): number | null {
  const n = asNumber(value);
  return n !== null && n > 0 ? Math.round(n * 100) / 100 : null;
}

function normalizeStringArray(value: unknown, limit = 30): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of asArray(value)) {
    const text = safeString(item);
    if (!text || /^(?:undefined|null|nan)$/i.test(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function formatCny(value: number | null): string {
  return value !== null && value > 0 ? `${value.toLocaleString('ru-RU')} ¥` : 'цена уточняется';
}

function formatKg(value: number | null): string {
  return value !== null && value > 0 ? `${value.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} кг` : 'вес уточняется';
}

function normalizeRaw1688(raw: Record<string, unknown>): AnalysisSnapshot['raw1688'] {
  const attrs = asRecord(raw.attributesRaw ?? raw.attributes);
  const attrList = asArray(raw.attributes);
  const attributesRaw = Object.keys(attrs).length
    ? attrs
    : Object.fromEntries(attrList.map((item) => {
      const obj = asRecord(item);
      return [safeString(obj.name), obj.value];
    }).filter(([key]) => Boolean(key)));

  return {
    titleCn: safeString(raw.titleCn ?? raw.title ?? raw.name),
    attributesRaw,
    skus: asArray(raw.skus),
    photosCount: Math.max(0, Math.round(asNumber(raw.photosCount ?? asArray(raw.images).length ?? asArray(raw.photos).length) ?? 0)),
  };
}

function normalizeMoq(supplier: Record<string, unknown>, raw: Record<string, unknown>): AnalysisSnapshot['supplier']['moq'] {
  const value = positiveNumber(supplier.moq ?? raw.moq ?? raw.minOrderQuantity);
  return {
    value,
    source: value !== null ? 'parsed' : 'unknown',
    displayLabel: value !== null ? `${Math.round(value).toLocaleString('ru-RU')} шт.` : 'MOQ уточняется',
  };
}

function resolvePurchasePrice(raw: Record<string, unknown>, context: ProductContextLike, selectedSkuId?: string | null): AnalysisSnapshot['purchasePrice'] {
  const contextPrice = asRecord(context.price);
  const rawSkus = asArray(raw.skus);
  const selectedSku = selectedSkuId
    ? rawSkus.map(asRecord).find((sku) => safeString(sku.id ?? sku.skuId ?? sku.name) === selectedSkuId)
    : null;
  const selectedSkuPrice = selectedSku ? positiveNumber(selectedSku.price ?? selectedSku.priceCny) : null;
  const skuPrices = rawSkus.map((sku) => positiveNumber(asRecord(sku).price ?? asRecord(sku).priceCny)).filter((value): value is number => value !== null);
  const priceRanges = asArray(raw.priceRange ?? raw.priceRanges);
  const tierPrices = priceRanges.map((tier) => positiveNumber(asRecord(tier).price ?? asRecord(tier).priceCny)).filter((value): value is number => value !== null);
  const visible = positiveNumber(raw.price ?? raw.priceYuan ?? contextPrice.visiblePriceCny);
  const minFromContext = positiveNumber(contextPrice.minPriceCny);
  const maxFromContext = positiveNumber(contextPrice.maxPriceCny);

  let valueCny: number | null = null;
  let source: AnalysisSnapshot['purchasePrice']['source'] = 'unknown';

  if (selectedSkuPrice !== null) {
    valueCny = selectedSkuPrice;
    source = 'selected_sku_price';
  } else if (skuPrices.length === 1) {
    valueCny = skuPrices[0];
    source = 'explicit_sku_price';
  } else if (tierPrices.length) {
    valueCny = Math.min(...tierPrices);
    source = 'discount_tier_min';
  } else if (minFromContext !== null) {
    valueCny = minFromContext;
    source = 'price_range_min';
  } else if (visible !== null) {
    valueCny = visible;
    source = 'visible_1688_price';
  }

  const allPrices = [valueCny, visible, minFromContext, maxFromContext, ...skuPrices, ...tierPrices].filter((value): value is number => value !== null);

  return {
    valueCny,
    minCny: allPrices.length ? Math.min(...allPrices) : null,
    maxCny: allPrices.length ? Math.max(...allPrices) : null,
    displayLabel: formatCny(valueCny),
    source,
    isSyntheticPrice: false,
    needsSkuConfirmation: Boolean(context.sku?.needsSelection) || skuPrices.length > 1 || !selectedSkuId,
  };
}

function resolveWeight(raw: Record<string, unknown>): AnalysisSnapshot['weight'] {
  const packed = positiveNumber(raw.packedWeightKg ?? raw.packageWeightKg ?? raw.weightWithPackageKg);
  const value = positiveNumber(raw.weightKg ?? raw.weight);
  const finalWeight = packed ?? value;
  return {
    valueKg: value,
    packedWeightKg: packed,
    source: finalWeight !== null ? 'parsed' : 'unknown',
    displayLabel: formatKg(finalWeight),
  };
}

function normalizeSku(raw: Record<string, unknown>, context: ProductContextLike, selectedSkuId?: string | null): AnalysisSnapshot['sku'] {
  const rawSkus = asArray(raw.skus);
  const variants = rawSkus.map((sku, index) => {
    const obj = asRecord(sku);
    return {
      id: safeString(obj.id ?? obj.skuId ?? obj.name, `sku_${index + 1}`),
      label: safeString(obj.label ?? obj.name ?? obj.title, `SKU ${index + 1}`),
      priceCny: positiveNumber(obj.price ?? obj.priceCny),
    };
  });
  const contextSku = asRecord(context.sku);
  const count = variants.length || Math.max(0, Math.round(asNumber(contextSku.skuCount) ?? 0));

  return {
    count,
    selectedSkuId: selectedSkuId ?? null,
    needsSelection: Boolean(contextSku.needsSelection) || count > 1 && !selectedSkuId,
    variants,
  };
}

function normalizeMarket(input: unknown): AnalysisSnapshot['market'] {
  const market = asRecord(input);
  const directAnalogs = asArray(market.directAnalogs).map((item) => {
    const obj = asRecord(item);
    const matchLevelRaw = safeString(obj.matchLevel, 'direct');
    const matchLevel = ['direct', 'similar', 'category', 'rejected'].includes(matchLevelRaw) ? matchLevelRaw as 'direct' | 'similar' | 'category' | 'rejected' : 'direct';
    return {
      title: safeString(obj.title),
      priceRub: positiveNumber(obj.priceRub ?? obj.price),
      matchLevel,
      confidence: Math.max(0, Math.min(100, asNumber(obj.confidence) ?? 0)),
    };
  }).filter((item) => item.title || item.priceRub !== null);

  const directAnalogsCount = Math.max(0, Math.round(asNumber(market.directAnalogsCount) ?? directAnalogs.filter((item) => item.matchLevel === 'direct').length));
  const similarAnalogsCount = Math.max(0, Math.round(asNumber(market.similarAnalogsCount) ?? asNumber(market.similarCount) ?? 0));
  const broadCategoryCount = Math.max(0, Math.round(asNumber(market.broadCategoryCount) ?? asNumber(market.categoryCount) ?? 0));
  const crossBorderCount = Math.max(0, Math.round(asNumber(market.crossBorderCount) ?? 0));
  const displayedMainPriceRub = directAnalogsCount > 0 ? positiveNumber(market.displayedMainPriceRub ?? market.medianPriceRub ?? market.avgPriceRub) : null;
  const marketConfirmed = directAnalogsCount > 0 && displayedMainPriceRub !== null && Boolean(market.marketConfirmed ?? true);
  const displayedMainPriceTypeRaw = safeString(market.displayedMainPriceType, positiveNumber(market.medianPriceRub) ? 'median' : positiveNumber(market.avgPriceRub) ? 'average' : 'unknown');

  return {
    directAnalogsCount,
    similarAnalogsCount,
    broadCategoryCount,
    crossBorderCount,
    marketConfirmed,
    displayedMainPriceRub: marketConfirmed ? displayedMainPriceRub : null,
    displayedMainPriceType: displayedMainPriceTypeRaw === 'median' || displayedMainPriceTypeRaw === 'average' ? displayedMainPriceTypeRaw : 'unknown',
    canUseForEconomics: marketConfirmed,
    rejectedReason: marketConfirmed ? undefined : safeString(market.rejectedReason, directAnalogsCount <= 0 ? 'Нет внешнего подтверждения цены.' : 'Цена требует ручной проверки.'),
    directAnalogs,
  };
}

function normalizeEconomics(
  input: unknown,
  purchasePrice: AnalysisSnapshot['purchasePrice'],
  weight: AnalysisSnapshot['weight'],
  sku: AnalysisSnapshot['sku'],
  market: AnalysisSnapshot['market'],
): AnalysisSnapshot['economics'] {
  const economics = asRecord(input);
  const missing = normalizeStringArray(economics.missing, 20);
  if (purchasePrice.valueCny === null) missing.push('purchasePriceCny');
  if (weight.packedWeightKg === null && weight.valueKg === null) missing.push('packedWeightKg');
  if (sku.needsSelection) missing.push('selectedSku');
  

  const canShowRoi = Boolean(economics.canShowRoi) && market.marketConfirmed && market.directAnalogsCount > 0 && purchasePrice.valueCny !== null && positiveNumber(economics.sellPriceRub ?? market.displayedMainPriceRub) !== null;
  const canShowMargin = Boolean(economics.canShowMargin) && canShowRoi;

  const statusRaw = safeString(economics.status);
  let status: AnalysisSnapshot['economics']['status'] = 'not_calculated';
  if (statusRaw === 'confirmed' && canShowRoi && !sku.needsSelection && (weight.packedWeightKg !== null || weight.valueKg !== null)) status = 'confirmed';
  else if (purchasePrice.valueCny !== null && market.marketConfirmed) status = 'preliminary';
  else if (purchasePrice.valueCny !== null) status = 'partial';

  return {
    status,
    purchasePriceCny: purchasePrice.valueCny,
    costRub: positiveNumber(economics.costRub),
    sellPriceRub: canShowRoi ? positiveNumber(economics.sellPriceRub ?? market.displayedMainPriceRub) : null,
    marginRub: canShowMargin ? positiveNumber(economics.marginRub) : null,
    roiPercent: canShowRoi ? positiveNumber(economics.roiPercent) : null,
    assumptions: normalizeStringArray(economics.assumptions, 20),
    missing: missing.filter((value, index, arr) => arr.indexOf(value) === index),
    canShowRoi,
    canShowMargin,
    warning: canShowRoi ? safeString(economics.warning) : 'Предварительная себестоимость зависит от веса, упаковки и условий доставки.',
  };
}

function normalizeConflicts(context: ProductContextLike, extra: unknown): AnalysisSnapshot['conflicts'] {
  const items = [...asArray(context.conflicts), ...asArray(extra)];
  return items.map((item) => {
    const obj = asRecord(item);
    const severityRaw = safeString(obj.severity, 'medium');
    const severity: 'low' | 'medium' | 'high' = severityRaw === 'low' || severityRaw === 'medium' || severityRaw === 'high' ? severityRaw : 'medium';
    return {
      field: safeString(obj.field, 'unknown'),
      problem: safeString(obj.problem, 'Неясное противоречие'),
      severity,
    };
  }).filter((item) => item.field && item.problem).slice(0, 30);
}

export function buildAnalysisSnapshot(input: BuildAnalysisSnapshotInput): AnalysisSnapshot {
  const raw = asRecord(input.raw1688);
  const context = input.productContext ?? {};
  const supplierInput = asRecord(input.supplier ?? raw.supplier);
  const raw1688 = normalizeRaw1688(raw);
  const offerId = safeString(input.offerId ?? context.offerId ?? raw.offerId ?? raw.id ?? raw.productId, 'unknown_offer');
  const selectedSkuId = input.selectedSkuId ?? null;
  const moq = normalizeMoq(supplierInput, raw);
  const purchasePrice = resolvePurchasePrice(raw, context, selectedSkuId);
  const weight = resolveWeight(raw);
  const sku = normalizeSku(raw, context, selectedSkuId);
  const market = normalizeMarket(input.market);
  const economics = normalizeEconomics(input.economics, purchasePrice, weight, sku, market);
  const conflicts = normalizeConflicts(context, raw.conflicts);
  const rawProductForFacts = {
    productId: offerId,
    platform: '1688',
    titleCn: raw1688.titleCn,
    titleEn: safeString(raw.titleEn),
    description: safeString(raw.description),
    priceYuan: purchasePrice.valueCny ?? 0,
    moq: asNumber(raw.moq) ?? 0,
    weightKg: weight.valueKg ?? 0,
    images: asArray(raw.images).map((item) => safeString(item)).filter(Boolean),
    supplierName: safeString(supplierInput.name),
    supplierRating: asNumber(supplierInput.rating) ?? undefined,
    supplierType: safeString(supplierInput.type) as 'factory' | 'merchant' | 'seller' | undefined,
    mainImageUrl: safeString(raw.mainImageUrl),
    sold: asNumber(raw.sold) ?? undefined,
    stock: asNumber(raw.stock) ?? undefined,
    categoryName: safeString(asRecord(context.identity).categoryType ?? raw.categoryName),
    attributes: Object.entries(raw1688.attributesRaw).map(([name, value]) => ({ name, value: safeString(value) })).filter((item) => item.name && item.value),
    skus: sku.variants.map((item) => ({ name: item.label, price: item.priceCny ?? undefined })),
    selectedSkuName: sku.variants.find((item) => item.id === sku.selectedSkuId)?.label,
    normalized1688: {
      pricing: {
        quoteType: 'unknown',
        displayPriceYuan: purchasePrice.valueCny ?? 0,
        rawPriceFields: [],
      },
      moq: moq.value ?? undefined,
      skuCount: sku.count,
      skuVariants: sku.variants.map((item) => ({ name: item.label, price: item.priceCny ?? undefined })),
      supplierType: (safeString(supplierInput.type) || undefined) as 'factory' | 'merchant' | 'seller' | undefined,
      imageCount: raw1688.photosCount,
      images: asArray(raw.images).map((item) => safeString(item)).filter(Boolean),
      weightKg: weight.valueKg ?? undefined,
      attributes: Object.entries(raw1688.attributesRaw).map(([name, value]) => ({ name, value: safeString(value) })).filter((item) => item.name && item.value),
      keyAttributes: [],
      debug: {
        quoteType: 'unknown',
        rawPriceFields: [],
        skuCount: sku.count,
        attributesCount: Object.keys(raw1688.attributesRaw).length,
        imageCount: raw1688.photosCount,
        extraInfoKeys: Object.keys(raw),
        missingCriticalFields: [],
      },
    },
  } as import('../types').RawProduct1688;
  const factSheet = buildProductFactSheet(rawProductForFacts);
  const categoryPolicy = buildCategoryPolicyProfile({
    categoryType: safeString(asRecord(context.identity).categoryType ?? raw.categoryName),
    title: raw1688.titleCn,
    attributes: rawProductForFacts.attributes,
  });
  const missingData = [
    ...normalizeStringArray(input.missingData, 50),
    ...normalizeStringArray(context.missingCritical, 30),
    ...economics.missing,
    ...factSheet.missingRequired,
  ].filter((value, index, arr) => arr.indexOf(value) === index);

  return {
    offerId,
    sourceUrl: safeString(input.sourceUrl ?? raw.sourceUrl ?? raw.url),
    createdAt: input.createdAt ?? new Date().toISOString(),
    raw1688,
    productContext: context,
    factSheet,
    categoryPolicy,
    supplier: {
      name: safeString(supplierInput.name),
      type: safeString(supplierInput.type),
      rating: safeString(supplierInput.rating),
      orders: safeString(supplierInput.orders),
      moq,
    },
    purchasePrice,
    weight,
    sku,
    market,
    economics,
    missingData,
    conflicts,
    riskFlags: [
      ...normalizeStringArray(input.riskFlags, 50),
      ...normalizeStringArray(context.riskTags, 30),
    ].filter((value, index, arr) => arr.indexOf(value) === index),
  };
}

export function canShowEconomics(snapshot: AnalysisSnapshot): boolean {
  return snapshot.economics.canShowRoi
    && snapshot.economics.canShowMargin
    && snapshot.market.directAnalogsCount > 0
    && snapshot.market.marketConfirmed
    && snapshot.market.canUseForEconomics
    && snapshot.purchasePrice.valueCny !== null
    && snapshot.economics.sellPriceRub !== null;
}

export function getSafeSnapshotSummary(snapshot: AnalysisSnapshot): {
  status: 'черновик' | 'рабочая гипотеза' | 'надёжный расчёт' | 'отклонить';
  verdict: string;
  mainRisk: string;
  nextStep: string;
  doNotDo: string;
} {
  const title = snapshot.productContext.titles?.shortRu || snapshot.productContext.titles?.cleanRu || snapshot.productContext.identity?.productType || 'товар';
  const missing = snapshot.missingData.length ? snapshot.missingData : snapshot.economics.missing;
  const reliable = canShowEconomics(snapshot) && !snapshot.sku.needsSelection && snapshot.weight.packedWeightKg !== null;
  const status = reliable ? 'надёжный расчёт' : snapshot.purchasePrice.valueCny !== null ? 'рабочая гипотеза' : 'черновик';

  return {
    status,
    verdict: reliable
      ? `${title}: можно продолжать закупочную проверку по пакету.`
      : `${title}: данных недостаточно для решения о закупке партии.`,
    mainRisk: missing.length ? `Не подтверждены: ${missing.slice(0, 5).join(', ')}.` : 'Риск ошибок в SKU, упаковке или характеристиках.',
    nextStep: 'Запросить у поставщика недостающие данные и заказать 1–2 образца после подтверждения SKU.',
    doNotDo: 'Не закупать партию без подтверждённого SKU, веса с упаковкой, комплектации и проверки образца.',
  };
}

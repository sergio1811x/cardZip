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
    const rawLevel = safeString(obj.matchLevel, safeString(obj.level, 'direct'));
    const normalizedRaw = rawLevel === 'direct_analog' ? 'direct' : rawLevel === 'category_only' ? 'category' : rawLevel;
    const matchLevel = ['direct', 'similar', 'category', 'rejected'].includes(normalizedRaw) ? normalizedRaw as 'direct' | 'similar' | 'category' | 'rejected' : 'direct';
    const confidence = Math.max(0, Math.min(100, asNumber(obj.confidence ?? obj.similarity ?? obj.matchConfidence) ?? 0));
    return {
      title: safeString(obj.title ?? obj.name),
      priceRub: positiveNumber(obj.priceRub ?? obj.price),
      matchLevel,
      confidence,
    };
  }).filter((item) => item.title || item.priceRub !== null);

  const strictDirect = directAnalogs.filter((item) => item.matchLevel === 'direct' && item.confidence >= 85 && item.priceRub !== null);
  const directAnalogsCount = Math.max(0, Math.round(asNumber(market.directAnalogsCount) ?? strictDirect.length));
  const similarAnalogsCount = Math.max(0, Math.round(asNumber(market.similarAnalogsCount) ?? asNumber(market.similarCount) ?? directAnalogs.filter((item) => item.matchLevel === 'similar').length));
  const broadCategoryCount = Math.max(0, Math.round(asNumber(market.broadCategoryCount) ?? asNumber(market.categoryCount) ?? directAnalogs.filter((item) => item.matchLevel === 'category').length));
  const crossBorderCount = Math.max(0, Math.round(asNumber(market.crossBorderCount) ?? 0));

  const directPrices = strictDirect.map((item) => item.priceRub).filter((value): value is number => value !== null && value > 0).sort((a, b) => a - b);
  const medianDirectPrice = directPrices.length
    ? directPrices[Math.floor(directPrices.length / 2)]
    : null;
  const candidateMarketPrice = positiveNumber(market.displayedMainPriceRub ?? market.medianPriceRub ?? market.avgPriceRub) ?? medianDirectPrice;

  // 1–2 прямых аналога — это ориентир, но не подтверждённый рынок для ROI.
  const enoughDirectAnalogs = directAnalogsCount >= 3;
  const marketConfirmedInput = Boolean(market.marketConfirmed ?? enoughDirectAnalogs);
  const marketConfirmed = enoughDirectAnalogs && candidateMarketPrice !== null && marketConfirmedInput;
  const displayedMainPriceTypeRaw = safeString(market.displayedMainPriceType, positiveNumber(market.medianPriceRub) || medianDirectPrice ? 'median' : positiveNumber(market.avgPriceRub) ? 'average' : 'unknown');

  let rejectedReason = safeString(market.rejectedReason);
  if (!marketConfirmed) {
    if (directAnalogsCount <= 0) rejectedReason = rejectedReason || 'Нет прямых аналогов с уверенностью 85%+ для подтверждения рыночной цены.';
    else if (directAnalogsCount < 3) rejectedReason = rejectedReason || 'Найдено меньше 3 прямых локальных аналогов. Этого недостаточно для рыночной цены и ROI.';
    else rejectedReason = rejectedReason || 'Рынок не подтверждён: нет валидной цены продажи.';
  }

  return {
    directAnalogsCount,
    similarAnalogsCount,
    broadCategoryCount,
    crossBorderCount,
    marketConfirmed,
    displayedMainPriceRub: marketConfirmed ? candidateMarketPrice : null,
    displayedMainPriceType: displayedMainPriceTypeRaw === 'median' || displayedMainPriceTypeRaw === 'average' ? displayedMainPriceTypeRaw : 'unknown',
    canUseForEconomics: marketConfirmed,
    rejectedReason: marketConfirmed ? undefined : rejectedReason,
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
  if (!market.marketConfirmed || market.directAnalogsCount <= 0) missing.push('confirmedMarketPrice');

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
    warning: canShowRoi ? safeString(economics.warning) : 'Рыночная цена не подтверждена. ROI и маржу считать нельзя.',
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
  const purchasePrice = resolvePurchasePrice(raw, context, selectedSkuId);
  const weight = resolveWeight(raw);
  const sku = normalizeSku(raw, context, selectedSkuId);
  const market = normalizeMarket(input.market);
  const economics = normalizeEconomics(input.economics, purchasePrice, weight, sku, market);
  const conflicts = normalizeConflicts(context, raw.conflicts);
  const missingData = [
    ...normalizeStringArray(input.missingData, 50),
    ...normalizeStringArray(context.missingCritical, 30),
    ...economics.missing,
  ].filter((value, index, arr) => arr.indexOf(value) === index);

  return {
    offerId,
    sourceUrl: safeString(input.sourceUrl ?? raw.sourceUrl ?? raw.url),
    createdAt: input.createdAt ?? new Date().toISOString(),
    raw1688,
    productContext: context,
    supplier: {
      name: safeString(supplierInput.name),
      type: safeString(supplierInput.type),
      rating: safeString(supplierInput.rating),
      orders: safeString(supplierInput.orders),
      moq: normalizeMoq(supplierInput, raw),
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
      ? `${title}: можно продолжать проверку, но без обещания результата продаж.`
      : `${title}: данных недостаточно для решения о закупке партии.`,
    mainRisk: missing.length ? `Не подтверждены: ${missing.slice(0, 5).join(', ')}.` : 'Риск ошибок в SKU, упаковке или рынке.',
    nextStep: 'Запросить у поставщика недостающие данные и вручную проверить прямые аналоги.',
    doNotDo: 'Не считать ROI/маржу и не закупать партию без подтверждённого SKU, веса с упаковкой, цены партии и прямого рынка.',
  };
}

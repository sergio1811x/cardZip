import type { RawProduct1688, WbCard } from '../types';
import { cleanChineseTitle, normalizeSkuText, detectPackCount, extractShoeSize } from './cnNormalize';

export type DecisionConfidence = 'high' | 'medium' | 'low';

export type PriceDecision = {
  displayPriceText: string;
  calculationPriceYuan: number | null;
  minPriceYuan: number | null;
  maxPriceYuan: number | null;
  selectedSkuName?: string;
  selectedSkuPriceYuan?: number;
  priceSource: 'direct' | 'promotion' | 'sku' | 'price_range' | 'fallback_min' | 'missing';
  isEstimated: boolean;
  isSkuDependent: boolean;
  isPackDependent: boolean;
  canCalculateCost: boolean;
  canCalculateRoi: boolean;
  needsSkuConfirmation: boolean;
  reason: string;
};

export type WeightDecision = {
  weightKg: number | null;
  source: 'provider' | 'manual' | 'category_default' | 'missing';
  isEstimated: boolean;
  canUseForCargo: boolean;
  canUseForRoi: boolean;
  reason: string;
};

export type SkuDecision = {
  skuDimensions: string[];
  skuSummary: string;
  skuCount: number;
  shownSkuCount: number;
  skuVariantsNormalized: Array<{ raw: string; label: string; priceYuan: number | null; packCount?: number; size?: string }>;
  isMultiPack: boolean;
  needsSelection: boolean;
  priceText?: string;
};

export type MarketDecision = {
  status: 'confirmed' | 'weak' | 'not_confirmed' | 'rate_limited';
  rawCandidatesCount: number;
  confirmedDirectCount: number;
  similarLocalCount: number;
  crossBorderCount: number;
  categoryOnlyCount: number;
  medianPriceRub: number | null;
  p25PriceRub: number | null;
  p75PriceRub: number | null;
  canShowMedianPrice: boolean;
  canCalculateRoi: boolean;
  confidence: DecisionConfidence;
  reason: string;
};

export type EconomyDecision = {
  status:
    | 'not_calculated_no_price'
    | 'preliminary_no_weight'
    | 'preliminary_sku'
    | 'cost_only_no_market'
    | 'estimated_weight'
    | 'weak_market_data'
    | 'full';
  canShowCost: boolean;
  canShowCargo: boolean;
  canShowMargin: boolean;
  canShowRoi: boolean;
  costRub: number | null;
  costWithoutCargoRub: number | null;
  cargoRub: number | null;
  profitRub: number | null;
  roiPercent: number | null;
  warnings: string[];
  nextAction: string;
};

export type ProductIntelligenceLike = {
  productIdentity?: {
    marketNameRu?: string;
    shortNameRu?: string;
    productKind?: string;
    categoryType?: string;
    subCategoryType?: string;
    categoryPath?: string[];
    coreObject?: string;
    formFactor?: string;
    audience?: string;
    gender?: string;
    season?: string;
    useCases?: string[];
    materials?: string[];
    powerType?: string[];
    visibleFeatures?: string[];
    importantFeatures?: string[];
    notConfirmedFeatures?: string[];
    possibleConfusions?: string[];
  };
  cleanTitles?: {
    titleCnClean?: string;
    titleRuClean?: string;
    titleForReport?: string;
    titleForWb?: string;
  };
  wbSearch?: {
    wbCoreQuery?: string;
    queryCandidates?: string[];
    negativeSearchTerms?: string[];
    tooBroadQueries?: string[];
    tooNarrowQueries?: string[];
  };
  matchingRules?: {
    mustHaveForDirectAnalog?: string[];
    allowedDifferences?: string[];
    directAnalogBlockers?: string[];
    similarOnlyIf?: string[];
    rejectIf?: string[];
  };
  reportRules?: {
    buyerMustCheck?: string[];
    buyerMustNotAsk?: string[];
    seoAllowedClaims?: string[];
    seoForbiddenClaims?: string[];
    importantAttributesToShow?: string[];
    attributesToHide?: string[];
    riskFlags?: string[];
  };
  supplierQuestions?: { ru?: string[]; cn?: string[] };
  dataQuality?: {
    missingCriticalFields?: string[];
    skuRisk?: string;
    priceRisk?: string;
    weightRisk?: string;
    marketRisk?: string;
    visionConfidence?: DecisionConfidence;
    textConfidence?: DecisionConfidence;
    overallConfidence?: DecisionConfidence;
    reason?: string;
  };
};

const YUAN_FALLBACK = 11.8;
const USD_TO_RUB = 95;
const BANK_MARKUP = 0.03;
const DEFAULT_FULFILLMENT_RUB = 80;
const DEFAULT_CARGO_USD_PER_KG = 4;
const DEFAULT_WB_COMMISSION = 0.2;
const DEFAULT_WB_LOGISTICS_RUB = 100;
const DEFAULT_TAX = 0.07;
const DEFAULT_DRR = 0.15;

const CATEGORY_DEFAULT_WEIGHT: Record<string, number> = {
  shoes: 0.8,
  clothes: 0.3,
  electronics: 0.5,
  accessory: 0.2,
  kitchen: 0.45,
  home: 0.4,
  beauty: 0.25,
  fishing: 0.25,
  tools: 0.7,
  other: 0.4,
};

const RU_FORBIDDEN_BY_CATEGORY: Record<string, string[]> = {
  shoes: ['рукав', 'состав ткани', 'плотность ткани', 'усадка', 'мощность', 'напряжение', 'аккумулятор', 'тип вилки'],
  clothes: ['мощность', 'напряжение', 'аккумулятор', 'тип вилки', 'длина стельки'],
  electronics: ['рукав', 'длина стельки', 'размерная сетка', 'состав ткани', 'плотность ткани'],
  passive_insect_trap: ['мощность', 'напряжение', '220v', 'тип вилки', 'аккумулятор', 'зарядка', 'тип лампы', 'электрическая', 'ультразвуковая'],
};

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function asArray<T = any>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(',', '.').replace(/[^\d.-]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function positive(value: unknown): number | null {
  const n = num(value);
  return n !== null && n > 0 ? Math.round(n * 100) / 100 : null;
}

function money(value: number | null | undefined, suffix = '₽'): string {
  if (!value || value <= 0 || !Number.isFinite(value)) return '—';
  return `${Math.round(value).toLocaleString('ru-RU')} ${suffix}`;
}

function cny(value: number | null | undefined): string {
  if (!value || value <= 0 || !Number.isFinite(value)) return 'нужно уточнить';
  return `${String(Math.round(value * 100) / 100).replace('.', ',')} ¥`;
}

function rangeText(min: number | null, max: number | null, suffix = '¥'): string {
  if (!min && !max) return 'нужно уточнить';
  if (min && max && min !== max) return `${cny(min).replace(' ¥', '')}–${cny(max).replace(' ¥', '')} ${suffix}`;
  return `${cny(min ?? max).replace(' ¥', '')} ${suffix}`;
}

function uniq(list: string[], limit = 20): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (!text || /^(?:-|—|undefined|null|nan)$/i.test(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function html(text: unknown): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function plain(text: unknown): string {
  return String(text ?? '')
    .replace(/\b(?:undefined|null|NaN|Infinity|-Infinity)\b/gi, '—')
    .replace(/0(?:[,.]0+)?\s*[¥￥]/gi, 'цена уточняется')
    .replace(/0(?:[,.]0+)?\s*₽/gi, 'цена уточняется')
    .replace(/0(?:[,.]0+)?\s*(?:кг|kg)\b/gi, 'вес уточняется')
    .replace(/\s+/g, ' ')
    .trim();
}

function getIntel(product: any): ProductIntelligenceLike {
  return (product?.intelligence ?? product?.productIntelligence ?? product?.productContext ?? {}) as ProductIntelligenceLike;
}

function getIdentity(product: any): ProductIntelligenceLike['productIdentity'] {
  const intel = getIntel(product);
  return intel.productIdentity ?? (intel as any).identity ?? {};
}

function titleForReport(product: any, intelligence?: ProductIntelligenceLike): string {
  const intel = intelligence ?? getIntel(product);
  const identity = getIdentity(product);
  const titles = intel.cleanTitles ?? (intel as any).titles ?? {};
  return plain(
    titles.titleForReport || titles.titleRuClean || titles.cleanRu || identity?.marketNameRu || identity?.shortNameRu ||
    product?.titleRu || product?.seoContent?.titleRu || product?.titleEn || product?.titleCn || 'Товар 1688'
  );
}

function categoryType(product: any, intelligence?: ProductIntelligenceLike): string {
  const identity = (intelligence ?? getIntel(product)).productIdentity ?? getIdentity(product);
  const raw = String(identity?.subCategoryType || identity?.categoryType || product?.categoryType || product?.categoryName || 'other').toLowerCase();
  if (/пассив|passive|ловушк.*(?:ос|мух|насеком)|insect trap|wasp|fly/.test(raw + ' ' + String(product?.titleRu ?? product?.titleEn ?? product?.titleCn ?? '').toLowerCase())) return 'passive_insect_trap';
  if (/shoe|обув|шл[её]пан|тапк|сланц|кроссов|ботин|鞋/.test(raw)) return 'shoes';
  if (/cloth|одеж|брюк|леггин|футбол|плать|衣|裤/.test(raw)) return 'clothes';
  if (/electron|электро|usb|power|аккумулятор|battery/.test(raw)) return 'electronics';
  return raw || 'other';
}

function productSkus(product: any): any[] {
  const normalized = product?.normalized1688;
  return asArray(normalized?.skuVariants).length ? asArray(normalized?.skuVariants) : asArray(product?.skus ?? product?.skuPrices);
}

export function buildSkuDecision(product: RawProduct1688 | any, intelligence?: ProductIntelligenceLike): SkuDecision {
  const skus = productSkus(product);
  const variants = skus.map((raw: any) => {
    const name = String(raw?.name ?? raw?.label ?? raw?.skuName ?? raw?.title ?? '').trim();
    const normalized = normalizeSkuText(name);
    const priceYuan = positive(raw?.price ?? raw?.priceYuan ?? raw?.priceCny);
    const packCount = detectPackCount(name);
    const size = extractShoeSize(name);
    return { raw: name, label: normalized || name, priceYuan, packCount, size };
  }).filter((v) => v.raw || v.label || v.priceYuan);

  const packCounts = uniq(variants.map((v) => v.packCount ? `${v.packCount}` : '').filter(Boolean));
  const sizes = uniq(variants.map((v) => v.size ?? '').filter(Boolean));
  const prices = variants.map((v) => v.priceYuan).filter((p): p is number => !!p);
  const isMultiPack = packCounts.length > 1 || variants.some((v) => !!v.packCount);
  const cat = categoryType(product, intelligence);
  const dimensions: string[] = [];
  const rawText = variants.map((v) => v.raw).join(' ');
  if (/色|цвет|black|white|red|blue|green|роз|черн|бел|красн|син|зел/i.test(rawText)) dimensions.push('color');
  if (sizes.length || /размер|码|size/i.test(rawText) || cat === 'shoes' || cat === 'clothes') dimensions.push('size');
  if (/型号|model|款|версия|модель/i.test(rawText)) dimensions.push('model');
  if (isMultiPack) dimensions.push('packCount');

  let skuSummary = 'SKU: не указаны';
  if (variants.length) {
    const parts: string[] = [`SKU: ${variants.length} вариантов`];
    if (dimensions.length) parts.push(dimensions.map((d) => ({ color: 'цвета', size: 'размеры', model: 'модели', packCount: 'количество штук' }[d] ?? d)).join(' × '));
    if (sizes.length) {
      const numericSizes = sizes.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
      if (numericSizes.length) parts.push(`размеры ${numericSizes[0]}–${numericSizes[numericSizes.length - 1]}`);
    }
    if (/偏小一码|маломер/i.test(rawText)) parts.push('маломерит на 1 размер');
    if (prices.length) {
      const min = Math.min(...prices);
      const max = Math.max(...prices);
      parts.push(`цена по SKU ${rangeText(min, max)}`);
    }
    if (variants.length > 15) parts.push('показаны первые 15');
    skuSummary = parts.join(' · ');
  }

  return {
    skuDimensions: dimensions,
    skuSummary,
    skuCount: variants.length,
    shownSkuCount: Math.min(variants.length, 15),
    skuVariantsNormalized: variants.slice(0, 15),
    isMultiPack,
    needsSelection: variants.length > 1,
    priceText: prices.length ? `Цена по SKU: ${rangeText(Math.min(...prices), Math.max(...prices))}` : undefined,
  };
}

export function buildPriceDecision(product: RawProduct1688 | any, skuDecision = buildSkuDecision(product)): PriceDecision {
  const normalized = product?.normalized1688;
  const pricing = normalized?.pricing ?? {};
  const selectedSkuName = pricing?.selectedSkuName || product?.selectedSkuName;
  const selectedSkuPrice = positive(pricing?.selectedSkuPriceYuan ?? product?.selectedSkuPriceYuan);
  if (selectedSkuPrice) {
    return {
      displayPriceText: `Цена выбранного SKU: ${cny(selectedSkuPrice)}${selectedSkuName ? ` · ${plain(selectedSkuName)}` : ''}`,
      calculationPriceYuan: selectedSkuPrice,
      minPriceYuan: selectedSkuPrice,
      maxPriceYuan: selectedSkuPrice,
      selectedSkuName,
      selectedSkuPriceYuan: selectedSkuPrice,
      priceSource: 'sku',
      isEstimated: false,
      isSkuDependent: false,
      isPackDependent: skuDecision.isMultiPack,
      canCalculateCost: true,
      canCalculateRoi: true,
      needsSkuConfirmation: false,
      reason: 'Выбран конкретный SKU с положительной ценой.',
    };
  }

  const skuPrices = skuDecision.skuVariantsNormalized.map((v) => v.priceYuan).filter((p): p is number => !!p);
  if (skuPrices.length) {
    const min = Math.min(...skuPrices);
    const max = Math.max(...skuPrices);
    const median = skuPrices.slice().sort((a, b) => a - b)[Math.floor(skuPrices.length / 2)];
    return {
      displayPriceText: `${skuDecision.isMultiPack ? 'Цена зависит от комплектации' : 'Цена по SKU'}: ${rangeText(min, max)}. Для точного расчёта подтвердите выбранный вариант.`,
      calculationPriceYuan: median,
      minPriceYuan: min,
      maxPriceYuan: max,
      priceSource: 'sku',
      isEstimated: min !== max,
      isSkuDependent: skuPrices.length > 1,
      isPackDependent: skuDecision.isMultiPack,
      canCalculateCost: true,
      canCalculateRoi: false,
      needsSkuConfirmation: true,
      reason: 'Есть цены SKU, но пользователь не выбрал конкретный SKU; ROI нельзя считать как точный.',
    };
  }

  const priceRanges = asArray<any>(product?.priceRange ?? pricing?.priceRanges);
  const validRanges = priceRanges
    .map((r) => ({ minQty: positive(r?.minQty ?? r?.min_quantity) ?? 1, maxQty: positive(r?.maxQty ?? r?.max_quantity), price: positive(r?.price ?? r?.priceYuan) }))
    .filter((r) => !!r.price) as Array<{ minQty: number; maxQty: number | null; price: number }>;
  if (validRanges.length) {
    const prices = validRanges.map((r) => r.price);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const uniqueQty = new Set(validRanges.map((r) => r.minQty)).size;
    const source: PriceDecision['priceSource'] = uniqueQty > 1 ? 'price_range' : 'fallback_min';
    const text = uniqueQty > 1
      ? `Оптовые цены: ${validRanges.slice(0, 4).map((r) => `${r.minQty}+ шт — ${cny(r.price)}`).join('; ')}`
      : `Цена по вариантам: ${rangeText(min, max)}. Оптовые пороги не найдены.`;
    return {
      displayPriceText: text,
      calculationPriceYuan: min,
      minPriceYuan: min,
      maxPriceYuan: max,
      priceSource: source,
      isEstimated: true,
      isSkuDependent: min !== max || uniqueQty === 1,
      isPackDependent: skuDecision.isMultiPack,
      canCalculateCost: true,
      canCalculateRoi: false,
      needsSkuConfirmation: true,
      reason: uniqueQty > 1 ? 'Есть priceRange с разными порогами количества.' : 'priceRange похож на цены вариантов, а не на скидки.',
    };
  }

  const promo = positive(pricing?.promotionPriceYuan ?? product?.promotionPrice ?? product?.promotion_price);
  if (promo) {
    return {
      displayPriceText: `Цена: ${cny(promo)}`,
      calculationPriceYuan: promo,
      minPriceYuan: promo,
      maxPriceYuan: promo,
      priceSource: 'promotion',
      isEstimated: false,
      isSkuDependent: false,
      isPackDependent: skuDecision.isMultiPack,
      canCalculateCost: true,
      canCalculateRoi: !skuDecision.needsSelection && !skuDecision.isMultiPack,
      needsSkuConfirmation: skuDecision.needsSelection || skuDecision.isMultiPack,
      reason: 'Использована промо-цена поставщика.',
    };
  }

  const direct = positive(pricing?.directPriceYuan ?? product?.priceYuan ?? product?.price);
  if (direct) {
    return {
      displayPriceText: `Цена: ${cny(direct)}`,
      calculationPriceYuan: direct,
      minPriceYuan: direct,
      maxPriceYuan: direct,
      priceSource: 'direct',
      isEstimated: false,
      isSkuDependent: false,
      isPackDependent: skuDecision.isMultiPack,
      canCalculateCost: true,
      canCalculateRoi: !skuDecision.needsSelection && !skuDecision.isMultiPack,
      needsSkuConfirmation: skuDecision.needsSelection || skuDecision.isMultiPack,
      reason: 'Использована витринная цена поставщика.',
    };
  }

  return {
    displayPriceText: 'Цена: нужно уточнить. Экономика не рассчитывается.',
    calculationPriceYuan: null,
    minPriceYuan: null,
    maxPriceYuan: null,
    priceSource: 'missing',
    isEstimated: false,
    isSkuDependent: skuDecision.needsSelection,
    isPackDependent: skuDecision.isMultiPack,
    canCalculateCost: false,
    canCalculateRoi: false,
    needsSkuConfirmation: skuDecision.needsSelection,
    reason: 'Нет положительной цены в direct/promotion/SKU/priceRange.',
  };
}

export function buildWeightDecision(product: RawProduct1688 | any, intelligence?: ProductIntelligenceLike, skuDecision = buildSkuDecision(product, intelligence)): WeightDecision {
  const manual = positive(product?.manualWeightKg ?? product?.supplierAnswer?.weightKg ?? product?.confirmedWeightKg);
  if (manual) return { weightKg: manual, source: 'manual', isEstimated: false, canUseForCargo: true, canUseForRoi: true, reason: 'Вес введён/подтверждён вручную.' };
  const provider = positive(product?.normalized1688?.weightKg ?? product?.weightKg ?? product?.shipping_info?.weight);
  if (provider) return { weightKg: provider, source: 'provider', isEstimated: false, canUseForCargo: true, canUseForRoi: true, reason: 'Вес получен от поставщика/провайдера.' };

  const cat = categoryType(product, intelligence);
  if (skuDecision.isMultiPack) {
    return { weightKg: null, source: 'missing', isEstimated: false, canUseForCargo: false, canUseForRoi: false, reason: 'Вес не указан; у товара разные комплектации, средний вес категории не применён.' };
  }

  const fallback = CATEGORY_DEFAULT_WEIGHT[cat] ?? CATEGORY_DEFAULT_WEIGHT.other;
  return { weightKg: fallback, source: 'category_default', isEstimated: true, canUseForCargo: false, canUseForRoi: false, reason: 'Вес не указан; категорийный вес можно показывать только как ориентир, не для ROI.' };
}

function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const val = sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base];
  return Math.round(val);
}

function normalizeWbCard(card: any): WbCard | null {
  if (!card || typeof card !== 'object') return null;
  const title = plain(card.title ?? card.name ?? card.productName ?? '');
  if (!title) return null;
  const salePriceU = positive(card.salePriceU);
  const price = positive(card.price ?? card.priceRub ?? card.salePriceRub) ?? (salePriceU ? Math.round(salePriceU / 100) : null);
  return {
    ...(card as WbCard),
    title,
    price: price ?? (card as any).price ?? (card as any).priceRub,
    url: String(card.url ?? ((card.nmId || card.id) ? `https://www.wildberries.ru/catalog/${card.nmId ?? card.id}/detail.aspx` : '')),
  } as WbCard;
}

function normalizeCards(product: any): WbCard[] {
  const snapshot = product?.marketSnapshot ?? product?.market ?? {};
  const sources = [
    product?.wbData?.allCards,
    product?.wbData?.topExamples,
    product?.wbFiltered?.allCards,
    snapshot?.directAnalogs,
    snapshot?.similarAnalogs,
    snapshot?.categoryOnly,
    snapshot?.categoryAnalogs,
    snapshot?.crossBorderAnalogs,
    product?.directAnalogs,
    product?.similarAnalogs,
  ];
  const out: WbCard[] = [];
  for (const src of sources) {
    for (const rawCard of asArray<WbCard>(src)) {
      const card = normalizeWbCard(rawCard);
      if (card) out.push(card);
    }
  }
  const seen = new Set<string>();
  return out.filter((c) => {
    const key = c.url || `${c.title.toLowerCase()}_${positive((c as any).price ?? (c as any).priceRub) ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildMarketDecision(product: any): MarketDecision {
  if (product?.wb429) {
    return { status: 'rate_limited', rawCandidatesCount: 0, confirmedDirectCount: 0, similarLocalCount: 0, crossBorderCount: 0, categoryOnlyCount: 0, medianPriceRub: null, p25PriceRub: null, p75PriceRub: null, canShowMedianPrice: false, canCalculateRoi: false, confidence: 'low', reason: 'WB ограничил поиск; рынок не подтверждён.' };
  }

  const explicit = product?.marketDecision;
  if (explicit && typeof explicit === 'object') {
    const confirmedDirectCount = Math.max(0, Number(explicit.confirmedDirectCount ?? explicit.directAnalogsCount ?? 0) || 0);
    const medianPriceRub = positive(explicit.medianPriceRub ?? explicit.displayedMainPriceRub);
    const canCalculateRoi = Boolean(explicit.canCalculateRoi) && confirmedDirectCount >= 5 && !!medianPriceRub;
    return {
      status: canCalculateRoi ? 'confirmed' : confirmedDirectCount > 0 ? 'weak' : (explicit.status === 'rate_limited' ? 'rate_limited' : 'not_confirmed'),
      rawCandidatesCount: Math.max(0, Number(explicit.rawCandidatesCount ?? explicit.totalCandidates ?? 0) || 0),
      confirmedDirectCount,
      similarLocalCount: Math.max(0, Number(explicit.similarLocalCount ?? explicit.similarAnalogsCount ?? 0) || 0),
      crossBorderCount: Math.max(0, Number(explicit.crossBorderCount ?? 0) || 0),
      categoryOnlyCount: Math.max(0, Number(explicit.categoryOnlyCount ?? explicit.broadCategoryCount ?? 0) || 0),
      medianPriceRub: canCalculateRoi ? medianPriceRub : null,
      p25PriceRub: canCalculateRoi ? positive(explicit.p25PriceRub) : null,
      p75PriceRub: canCalculateRoi ? positive(explicit.p75PriceRub) : null,
      canShowMedianPrice: canCalculateRoi,
      canCalculateRoi,
      confidence: canCalculateRoi ? (confirmedDirectCount >= 8 ? 'high' : 'medium') : 'low',
      reason: plain(explicit.reason) || (canCalculateRoi ? `Найдено ${confirmedDirectCount} прямых локальных аналогов 85%+.` : confirmedDirectCount > 0 ? `Есть ${confirmedDirectCount} прямых аналогов, но для ROI нужно минимум 5.` : 'Прямые локальные аналоги WB не подтверждены.'),
    };
  }

  const cards = normalizeCards(product);
  const direct = cards.filter((c: any) => {
    const conf = positive(c.matchConfidence ?? c.confidence ?? c.similarity) ?? 0;
    const level = String(c.matchLevel ?? c.matchType ?? '').toLowerCase();
    const local = !/cross/.test(String(c.marketType ?? '').toLowerCase());
    return local && conf >= 85 && /direct|analog|прям/.test(level || 'direct');
  });
  const similar = cards.filter((c: any) => {
    const conf = positive(c.matchConfidence ?? c.confidence ?? c.similarity) ?? 0;
    const level = String(c.matchLevel ?? c.matchType ?? '').toLowerCase();
    return !/cross/.test(String(c.marketType ?? '').toLowerCase()) && !direct.includes(c) && (conf >= 65 || /similar|похож/.test(level));
  });
  const cross = cards.filter((c: any) => /cross/.test(String(c.marketType ?? '').toLowerCase()));
  const categoryOnly = cards.filter((c: any) => /category|broad|катег/.test(String(c.matchLevel ?? c.matchType ?? '').toLowerCase()));
  const prices = direct.map((c: any) => positive(c.price ?? c.priceRub)).filter((p): p is number => !!p).sort((a, b) => a - b);
  const median = quantile(prices, 0.5);
  const p25 = quantile(prices, 0.25);
  const p75 = quantile(prices, 0.75);
  const confirmedCount = direct.length;
  if (confirmedCount >= 5 && median) {
    return { status: 'confirmed', rawCandidatesCount: cards.length, confirmedDirectCount: confirmedCount, similarLocalCount: similar.length, crossBorderCount: cross.length, categoryOnlyCount: categoryOnly.length, medianPriceRub: median, p25PriceRub: p25, p75PriceRub: p75, canShowMedianPrice: true, canCalculateRoi: true, confidence: confirmedCount >= 8 ? 'high' : 'medium', reason: `Найдено ${confirmedCount} прямых локальных аналогов 85%+.` };
  }
  if (confirmedCount > 0) {
    return { status: 'weak', rawCandidatesCount: cards.length, confirmedDirectCount: confirmedCount, similarLocalCount: similar.length, crossBorderCount: cross.length, categoryOnlyCount: categoryOnly.length, medianPriceRub: median, p25PriceRub: p25, p75PriceRub: p75, canShowMedianPrice: false, canCalculateRoi: false, confidence: 'low', reason: `Есть ${confirmedCount} прямых аналогов, но для ROI нужно минимум 5.` };
  }
  return { status: 'not_confirmed', rawCandidatesCount: cards.length, confirmedDirectCount: 0, similarLocalCount: similar.length, crossBorderCount: cross.length, categoryOnlyCount: categoryOnly.length, medianPriceRub: null, p25PriceRub: null, p75PriceRub: null, canShowMedianPrice: false, canCalculateRoi: false, confidence: 'low', reason: 'Прямые локальные аналоги WB не подтверждены.' };
}

export function buildEconomyDecision(
  priceDecision: PriceDecision,
  weightDecision: WeightDecision,
  marketDecision: MarketDecision,
  opts: { yuanToRub?: number; cargoPerKgUsd?: number; fulfillmentRub?: number; wbCommission?: number; tax?: number; drr?: number } = {},
): EconomyDecision {
  const warnings: string[] = [];
  if (!priceDecision.canCalculateCost || !priceDecision.calculationPriceYuan) {
    return { status: 'not_calculated_no_price', canShowCost: false, canShowCargo: false, canShowMargin: false, canShowRoi: false, costRub: null, costWithoutCargoRub: null, cargoRub: null, profitRub: null, roiPercent: null, warnings: ['Экономика не рассчитана — нет цены.'], nextAction: 'Уточнить цену выбранного SKU у поставщика.' };
  }

  const yuanToRub = opts.yuanToRub && opts.yuanToRub > 0 ? opts.yuanToRub : YUAN_FALLBACK;
  const purchaseRub = Math.round(priceDecision.calculationPriceYuan * yuanToRub);
  const bankRub = Math.round(purchaseRub * BANK_MARKUP);
  const fulfillmentRub = opts.fulfillmentRub ?? DEFAULT_FULFILLMENT_RUB;
  const costWithoutCargoRub = purchaseRub + bankRub + fulfillmentRub;

  if (!weightDecision.canUseForCargo) {
    const reason = weightDecision.source === 'category_default' ? 'Вес только ориентировочный по категории.' : 'Вес с упаковкой не указан.';
    warnings.push(reason);
    if (priceDecision.isPackDependent) warnings.push('Карго не рассчитано: вес зависит от выбранной комплектации.');
    return { status: 'preliminary_no_weight', canShowCost: true, canShowCargo: false, canShowMargin: false, canShowRoi: false, costRub: costWithoutCargoRub, costWithoutCargoRub, cargoRub: null, profitRub: null, roiPercent: null, warnings, nextAction: 'Нажмите «💬 Поставщику», уточните вес с упаковкой и внесите ответ — пересчитаю экономику.' };
  }

  const cargoRub = Math.round((weightDecision.weightKg ?? 0) * (opts.cargoPerKgUsd ?? DEFAULT_CARGO_USD_PER_KG) * USD_TO_RUB);
  const costRub = costWithoutCargoRub + cargoRub;

  if (weightDecision.source === 'category_default') warnings.push('Вес по категории — ориентир, не использовать для закупочного решения.');
  if (!priceDecision.canCalculateRoi) {
    warnings.push(priceDecision.needsSkuConfirmation ? 'Цена зависит от выбранного SKU/комплектации — ROI не считаю без подтверждения варианта.' : 'Цена предварительная — ROI не считаю.');
    return { status: 'preliminary_sku', canShowCost: true, canShowCargo: true, canShowMargin: false, canShowRoi: false, costRub, costWithoutCargoRub, cargoRub, profitRub: null, roiPercent: null, warnings, nextAction: 'Выберите SKU/комплектацию и подтвердите цену у поставщика, затем пересчитайте экономику.' };
  }
  if (marketDecision.status === 'not_confirmed' || !marketDecision.medianPriceRub) {
    warnings.push('Себестоимость можно оценить, ROI не считаю — нет подтверждённой цены рынка WB.');
    return { status: 'cost_only_no_market', canShowCost: true, canShowCargo: true, canShowMargin: false, canShowRoi: false, costRub, costWithoutCargoRub, cargoRub, profitRub: null, roiPercent: null, warnings, nextAction: 'Проверить WB-рынок вручную или повторить поиск позже. ROI пока не считать.' };
  }
  if (!marketDecision.canCalculateRoi) {
    warnings.push('Выборка WB ограничена — использовать как ориентир, не для закупочного решения.');
    return { status: 'weak_market_data', canShowCost: true, canShowCargo: true, canShowMargin: false, canShowRoi: false, costRub, costWithoutCargoRub, cargoRub, profitRub: null, roiPercent: null, warnings, nextAction: 'Нужно минимум 5 прямых локальных аналогов WB с уверенностью 85%+.' };
  }
  if (!weightDecision.canUseForRoi) {
    warnings.push('Вес не подтверждён для ROI.');
    return { status: 'estimated_weight', canShowCost: true, canShowCargo: true, canShowMargin: false, canShowRoi: false, costRub, costWithoutCargoRub, cargoRub, profitRub: null, roiPercent: null, warnings, nextAction: 'Уточнить фактический вес выбранного SKU.' };
  }

  const sell = marketDecision.medianPriceRub;
  const commission = Math.round(sell * (opts.wbCommission ?? DEFAULT_WB_COMMISSION));
  const tax = Math.round(sell * (opts.tax ?? DEFAULT_TAX));
  const drr = Math.round(sell * (opts.drr ?? DEFAULT_DRR));
  const profitRub = sell - costRub - commission - DEFAULT_WB_LOGISTICS_RUB - tax - drr;
  const roiPercent = costRub > 0 ? Math.round((profitRub / costRub) * 100) : null;
  return { status: 'full', canShowCost: true, canShowCargo: true, canShowMargin: true, canShowRoi: true, costRub, costWithoutCargoRub, cargoRub, profitRub, roiPercent, warnings, nextAction: profitRub > 0 ? 'Можно рассматривать образец после проверки SKU и поставщика.' : 'Не закупать партию: экономика убыточная или слабая.' };
}

export function buildStatusLine(price: PriceDecision, weight: WeightDecision, market: MarketDecision, economy: EconomyDecision): string {
  if (!price.canCalculateCost) return '🟡 Нужны данные';
  if (!price.canCalculateRoi) return '🟡 Нужны данные';
  if (!weight.canUseForRoi) return '🟡 Нужны данные';
  if (!market.canCalculateRoi) return '🟡 Рынок не подтверждён';
  if (economy.canShowRoi && (economy.profitRub ?? 0) < 0) return '🔴 Убыточно';
  if (economy.canShowRoi && (economy.profitRub ?? 0) > 0) return '🟢 Можно тестировать';
  return '🟡 Нужны данные';
}

export function buildDecisionContext(product: any) {
  const intelligence = getIntel(product);
  const sku = buildSkuDecision(product, intelligence);
  const price = buildPriceDecision(product, sku);
  const weight = buildWeightDecision(product, intelligence, sku);
  const market = buildMarketDecision(product);
  const economy = buildEconomyDecision(price, weight, market, { yuanToRub: product?.economics?.yuanToRub });
  const status = buildStatusLine(price, weight, market, economy);
  return { intelligence, sku, price, weight, market, economy, status, title: titleForReport(product, intelligence), categoryType: categoryType(product, intelligence) };
}

export function buildMainReport(product: any, statusInfo?: { creditsRemaining?: number }, wbCategory?: any): string {
  const x = buildDecisionContext(product);
  const source = String(product?.platform ?? '1688').toUpperCase();
  const supplierType = plain(product?.supplierType || product?.normalized1688?.supplierType || 'не указан');
  const imageCount = asArray(product?.images ?? product?.imageUrls).length;
  const moq = positive(product?.normalized1688?.moq ?? product?.moq);
  const sold = positive(product?.normalized1688?.salesCount ?? product?.sold);
  const weightText = x.weight.source === 'missing'
    ? 'вес не указан'
    : x.weight.source === 'category_default'
      ? `ориентир ${x.weight.weightKg} кг по категории, не для ROI`
      : `${x.weight.weightKg} кг`;

  const marketSummary = x.market.status === 'confirmed'
    ? `Прямые локальные аналоги: ${x.market.confirmedDirectCount}. Медиана: ${money(x.market.medianPriceRub)} по прямым аналогам.`
    : x.market.status === 'weak'
      ? `Прямые локальные аналоги: ${x.market.confirmedDirectCount}. Всего похожих карточек: ${x.market.rawCandidatesCount}. Выборка ограничена — использовать как ориентир, не для закупочного решения.`
      : x.market.status === 'rate_limited'
        ? 'WB ограничил поиск. Рыночную цену и ROI не считаю.'
        : `Прямые аналоги на WB не подтверждены. Рыночную цену и ROI не считаю. Всего похожих карточек: ${x.market.rawCandidatesCount}.`;

  const trends = asArray<any>(product?.wbTrends).slice(0, 5);
  const trendLines = trends.length
    ? trends.map((t) => `• ${html(t.search_words ?? t.query ?? t)}${positive(t.weeks_request_per_day) ? ` — ~${Math.round(t.weeks_request_per_day).toLocaleString('ru-RU')}/день` : ''}`)
    : uniq([...(x.intelligence.wbSearch?.queryCandidates ?? []), x.intelligence.wbSearch?.wbCoreQuery ?? '', product?.seoContent?.keywords?.[0] ?? ''].filter(Boolean) as string[], 5).map((q) => `• ${html(q)}`);

  let economySummary = '';
  if (x.economy.status === 'not_calculated_no_price') economySummary = 'Экономика не рассчитана — нет цены выбранного SKU.';
  else if (x.economy.status === 'preliminary_no_weight') economySummary = `Предварительно без карго:\n• Себестоимость без карго: ${money(x.economy.costWithoutCargoRub)}\n• Карго не рассчитано: ${html(x.weight.reason)}\n• ROI не считаю.`;
  else if (x.economy.status === 'cost_only_no_market' || x.economy.status === 'weak_market_data') economySummary = `• Себестоимость: ${money(x.economy.costRub)}\n• Карго: ${x.economy.cargoRub ? money(x.economy.cargoRub) : 'не рассчитано'}\n• ROI не считаю — WB-рынок не подтверждён.`;
  else economySummary = `• Себестоимость: ${money(x.economy.costRub)}\n• Цена рынка WB: ${money(x.market.medianPriceRub)}\n• Прибыль: ${money(x.economy.profitRub)}\n• ROI: ${x.economy.roiPercent}%`;

  const questions = buildSupplierQuestions(product, x).ru.slice(0, 7);
  const actions = x.economy.canShowRoi
    ? ['Нажмите «📎 Файлы» — скачайте ТЗ байеру и SEO-черновик.', 'Закажите образец, если поставщик подтвердит SKU/упаковку.']
    : ['Нажмите «💬 Поставщику» и отправьте вопросы.', 'После ответа нажмите «📥 Внести ответ» — пересчитаю экономику.'];

  const lines = [
    `📦 <b>${html(x.title)}</b>`,
    '',
    `Источник: ${html(source)}`,
    `Поставщик: ${html(supplierType)}`,
    '',
    '📌 <b>Данные 1688</b>',
    `• Цена: ${html(x.price.displayPriceText)}`,
    `• MOQ: ${moq ? `${Math.round(moq).toLocaleString('ru-RU')} шт.` : 'уточняется'}`,
    `• SKU: ${html(x.sku.skuSummary)}`,
    `• Фото: ${imageCount || '—'} шт`,
    `• Вес: ${html(weightText)}`,
    `• Продано/заказов: ${sold ? Math.round(sold).toLocaleString('ru-RU') : '—'}`,
    '',
    `<b>${html(x.status)}</b>`,
    '',
    '🔎 <b>Рынок WB</b>',
    html(marketSummary),
    '',
    '🔑 <b>Рыночные запросы WB</b>',
    ...(trendLines.length ? trendLines : ['• запросы не найдены']),
    'Это поисковые запросы по близкой нише, не прямые аналоги товара.',
    '',
    '💰 <b>Экономика</b>',
    html(economySummary).replace(/\n/g, '\n'),
    ...(x.economy.warnings.length ? ['', ...x.economy.warnings.map((w) => `⚠️ ${html(w)}`)] : []),
    '',
    '📌 <b>Что уточнить у поставщика</b>',
    ...questions.map((q) => `• ${html(q)}`),
    '',
    '🎯 <b>Вердикт</b>',
    html(x.economy.canShowRoi && (x.economy.profitRub ?? 0) > 0
      ? 'Можно рассматривать образец. Партию закупать только после подтверждения SKU, упаковки и финальной цены.'
      : 'Закупать рано. Сначала подтвердите недостающие данные и прямой рынок WB.'),
    '',
    'Что сделать:',
    ...actions.map((a, i) => `${i + 1}. ${html(a)}`),
  ];
  if (typeof statusInfo?.creditsRemaining === 'number') lines.push('', `📦 Осталось: ${statusInfo.creditsRemaining} анализов`);
  if (wbCategory?.name) lines.push('', `WB категория: ${html(wbCategory.name)}`);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

export function build1688Detail(product: any): string {
  const x = buildDecisionContext(product);
  const cn = cleanChineseTitle(product?.titleCn ?? product?.normalized1688?.titleCn ?? '');
  const imageCount = asArray(product?.images ?? product?.imageUrls).length;
  const attrs = asArray<any>(product?.normalized1688?.attributes ?? product?.attributes)
    .map((a) => ({ name: plain(a?.name), value: plain(a?.value) }))
    .filter((a) => a.name && a.value && !/[一-鿿]/.test(a.name + a.value))
    .slice(0, 12);
  const lines = [
    '📦 Данные товара с 1688', '',
    'Название CN:', cn || '—', '',
    'Название RU:', x.title, '',
    'Цена:', x.price.displayPriceText, '',
    'SKU:', x.sku.skuSummary,
    ...x.sku.skuVariantsNormalized.slice(0, 10).map((v) => `• ${v.label}${v.priceYuan ? ` — ${cny(v.priceYuan)}` : ''}`),
    '', 'Поставщик:',
    `• название: ${plain(product?.supplierName) || 'не указано'}`,
    `• тип: ${plain(product?.supplierType) || 'не указан'}`,
    `• рейтинг: ${plain(product?.supplierRating) || '—'}`,
    `• заказов: ${plain(product?.sold) || '—'}`,
    `• MOQ: ${positive(product?.moq) ? `${positive(product?.moq)} шт.` : 'уточняется'}`,
    '', 'Ключевые характеристики:',
    ...(attrs.length ? attrs.map((a) => `• ${a.name}: ${a.value}`) : ['• требуется уточнить у поставщика']),
    '', 'Логистика:',
    `• вес: ${x.weight.source === 'missing' ? 'не указан' : `${x.weight.weightKg} кг${x.weight.isEstimated ? ' ориентир' : ''}`}`,
    `• фото: ${imageCount || '—'}`,
    `• остаток: ${plain(product?.stock) || '—'}`,
  ];
  return lines.join('\n');
}

export function buildSeoDraft(product: any): string {
  const x = buildDecisionContext(product);
  const content = product?.seoContent ?? {};
  const title = plain(content.titleRu || x.intelligence.cleanTitles?.titleForWb || x.title);
  const desc = plain(content.description) || `${x.title}. Перед публикацией уточните характеристики выбранного SKU, упаковку и ограничения для карточки WB.`;
  const bullets = uniq(asArray<string>(content.bullets), 5);
  while (bullets.length < 5) bullets.push(['Подтвердите характеристики выбранного SKU', 'Уточните комплектацию и упаковку', 'Проверьте вес с упаковкой', 'Запросите реальные фото', 'Проверьте требования WB'][bullets.length]);
  const chars = asRecord(content.characteristics);
  const forbidden = new Set([...(x.intelligence.reportRules?.seoForbiddenClaims ?? []), ...(RU_FORBIDDEN_BY_CATEGORY[x.categoryType] ?? [])].map((s) => s.toLowerCase()));
  const charEntries = Object.entries(chars)
    .map(([k, v]) => [plain(k), plain(v)] as [string, string])
    .filter(([k, v]) => k && v && ![...forbidden].some((f) => (k + ' ' + v).toLowerCase().includes(f)))
    .slice(0, 14);
  if (!charEntries.some(([k]) => /тип/i.test(k))) charEntries.unshift(['Тип', x.title]);

  const queries = uniq([...(x.intelligence.wbSearch?.queryCandidates ?? []), x.intelligence.wbSearch?.wbCoreQuery ?? '', ...(content.keywords ?? [])].filter(Boolean) as string[], 8);
  const clarify = uniq([...(x.intelligence.dataQuality?.missingCriticalFields ?? []), ...(x.economy.warnings ?? []), ...(x.price.needsSkuConfirmation ? ['выбранный SKU и его цена'] : [])], 8);
  const forbiddenLines = uniq([...(x.intelligence.reportRules?.seoForbiddenClaims ?? []), ...(RU_FORBIDDEN_BY_CATEGORY[x.categoryType] ?? [])], 12);
  return [
    '# CardZip — Черновик WB-карточки', '',
    '## Название для WB', title, '',
    '## Описание', desc, '',
    '## Буллеты для инфографики', ...bullets.map((b, i) => `${i + 1}. ${b}`), '',
    '## Характеристики WB', '| Параметр | Значение | Статус |', '|---|---|---|',
    ...charEntries.map(([k, v]) => `| ${k} | ${v} | требуется проверка |`), '',
    '## Ключевые слова', uniq(asArray<string>(content.keywords), 12).join(', ') || queries.join(', '), '',
    '## Рекомендуемые поисковые запросы WB', ...(queries.length ? queries.map((q) => `- ${q}`) : ['- требуется подобрать после проверки товара']), '',
    '## Требует уточнения перед публикацией', ...(clarify.length ? clarify.map((q) => `- ${q}`) : ['- выбранный SKU, упаковка и вес']), '',
    '## Нельзя писать в карточке', ...(forbiddenLines.length ? forbiddenLines.map((q) => `- ${q}`) : ['- неподтверждённые claims: безопасный, премиальный, сертифицированный, IP67/IP68']), '',
  ].join('\n');
}

export function buildBuyerBrief(product: any, sourceUrl = ''): string {
  const x = buildDecisionContext(product);
  const checks = uniq(x.intelligence.reportRules?.buyerMustCheck ?? buildSupplierQuestions(product, x).ru, 12);
  const mustNot = new Set([...(x.intelligence.reportRules?.buyerMustNotAsk ?? []), ...(RU_FORBIDDEN_BY_CATEGORY[x.categoryType] ?? [])].map((s) => s.toLowerCase()));
  const filteredChecks = checks.filter((c) => ![...mustNot].some((f) => c.toLowerCase().includes(f)));
  return [
    '# ТЗ для байера / карго', '',
    '## Ссылка', sourceUrl || '—', '',
    '## Товар',
    `Название RU: ${x.title}`,
    `Название CN clean: ${cleanChineseTitle(product?.titleCn ?? '') || '—'}`,
    `Источник: ${String(product?.platform ?? '1688').toUpperCase()}`, '',
    '## Что закупаем',
    `Цена: ${x.price.displayPriceText}`,
    `SKU: ${x.sku.skuSummary}`,
    'Цвет: уточнить выбранный SKU',
    'Размер: уточнить выбранный SKU',
    `Комплектация: ${x.sku.isMultiPack ? 'зависит от SKU' : 'уточнить'}`,
    `MOQ: ${positive(product?.moq) ? `${positive(product?.moq)} шт.` : 'уточнить'}`, '',
    '## Поставщик',
    `Название: ${plain(product?.supplierName) || 'не указано'}`,
    `Тип: ${plain(product?.supplierType) || 'не указан'}`,
    `Рейтинг: ${plain(product?.supplierRating) || '—'}`,
    `Заказы: ${plain(product?.sold) || '—'}`, '',
    '## Что подтвердить у поставщика',
    ...filteredChecks.map((c) => `- ${c}`), '',
    '## Что проверить на образце',
    '- фактическое соответствие выбранному SKU',
    '- реальные размеры/комплектацию',
    '- качество материала и упаковки',
    '- отсутствие дефектов и запаха, если применимо', '',
    '## Логистика',
    `Вес: ${x.weight.source === 'missing' ? 'нужен вес с упаковкой выбранного SKU' : `${x.weight.weightKg} кг${x.weight.isEstimated ? ' ориентир' : ''}`}`,
    'Габариты: уточнить',
    'Упаковка: уточнить', '',
    '## Бюджет',
    `Образец: ${x.price.calculationPriceYuan ? cny(x.price.calculationPriceYuan) : 'не рассчитано'}`,
    '20 шт: после подтверждения цены/веса',
    '50 шт: после подтверждения цены/веса', '',
    '## Что не включено в расчёт',
    '- финальная стоимость карго без веса/габаритов',
    '- возвраты, реклама и хранение WB',
    '- сертификация/маркировка, если потребуется', '',
    '## Вывод',
    x.economy.canShowRoi ? 'Можно обсуждать образец после подтверждения SKU и упаковки.' : 'Закупать партию рано: сначала закрыть недостающие данные.',
  ].join('\n');
}

export function buildSupplierQuestions(product: any, x = buildDecisionContext(product)): { ru: string[]; cn: string[] } {
  const baseRu: string[] = [];
  const baseCn: string[] = [];
  if (x.price.calculationPriceYuan) {
    baseRu.push(`Подтвердите цену выбранного SKU: ${cny(x.price.calculationPriceYuan)}.`);
    baseCn.push(`请确认所选SKU的价格是否为${cny(x.price.calculationPriceYuan).replace(' ¥', '元')}？`);
  } else {
    baseRu.push('Укажите цену выбранного цвета/размера/комплектации.');
    baseCn.push('请告诉我所选颜色/尺码/套装的价格。');
  }
  if (!x.weight.canUseForRoi) {
    baseRu.push('Укажите вес с упаковкой именно для выбранного SKU.');
    baseCn.push('请提供所选SKU含包装的重量。');
  }
  if (x.sku.needsSelection) {
    baseRu.push('Подтвердите точную комплектацию выбранного SKU.');
    baseCn.push('请确认所选SKU的准确套装内容。');
  }
  const ru = uniq([...baseRu, ...(x.intelligence.supplierQuestions?.ru ?? []), ...(x.intelligence.reportRules?.buyerMustCheck ?? [])], 10);
  const cn = uniq([...baseCn, ...(x.intelligence.supplierQuestions?.cn ?? [])], 10);
  const forbidden = new Set([...(x.intelligence.reportRules?.buyerMustNotAsk ?? []), ...(RU_FORBIDDEN_BY_CATEGORY[x.categoryType] ?? [])].map((s) => s.toLowerCase()));
  return {
    ru: ru.filter((q) => ![...forbidden].some((f) => q.toLowerCase().includes(f))),
    cn,
  };
}

export function buildSafeSummary(product: any, reason?: string): string {
  const x = buildDecisionContext(product);
  return [
    '⚠️ <b>Анализ требует уточнения</b>', '',
    `Товар: ${html(x.title)}`,
    `Статус: ${html(x.status)}`, '',
    `Главный риск: ${html(reason || x.economy.warnings[0] || x.market.reason || 'данные недостаточно подтверждены')}`,
    `Следующий шаг: ${html(x.economy.nextAction)}`, '',
    'Не делать: не считать ROI/маржу и не закупать партию, пока не подтверждены SKU, вес с упаковкой, цена партии и прямой рынок WB.',
    '', 'Кредит не списан.',
  ].join('\n');
}

export function validateGeneratedText(input: { productIntelligence?: ProductIntelligenceLike; generatedText: string; reportType: 'main' | 'detail1688' | 'seo' | 'buyerBrief' | 'supplierQuestions'; categoryType?: string; marketDecision?: MarketDecision; weightDecision?: WeightDecision }): { ok: boolean; errors: string[]; fixedText: string } {
  const errors: string[] = [];
  let fixed = String(input.generatedText ?? '');
  fixed = fixed.replace(/\b(?:undefined|null|NaN|Infinity|-Infinity)\b/gi, '—')
    .replace(/0(?:[,.]0+)?\s*[¥￥]/gi, 'цена уточняется')
    .replace(/0(?:[,.]0+)?\s*₽/gi, 'цена уточняется')
    .replace(/0(?:[,.]0+)?\s*(?:кг|kg)\b/gi, 'вес уточняется');
  if (/\b(?:undefined|null|NaN|Infinity|-Infinity)\b/i.test(input.generatedText)) errors.push('technical garbage');
  if (/0(?:[,.]0+)?\s*[¥￥₽]/i.test(input.generatedText)) errors.push('zero price');
  if (/0(?:[,.]0+)?\s*(?:кг|kg)\b/i.test(input.generatedText)) errors.push('zero weight');
  const forbidden = uniq([...(input.productIntelligence?.reportRules?.buyerMustNotAsk ?? []), ...(input.productIntelligence?.reportRules?.seoForbiddenClaims ?? []), ...(RU_FORBIDDEN_BY_CATEGORY[input.categoryType ?? ''] ?? [])], 50);
  for (const f of forbidden) {
    if (!f) continue;
    const re = new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
    if (re.test(fixed)) {
      errors.push(`forbidden: ${f}`);
      fixed = fixed.replace(re, '');
    }
  }
  if (input.reportType !== 'detail1688' && /[一-鿿]/.test(fixed)) {
    errors.push('raw chinese');
    fixed = fixed.split('\n').filter((l) => !/[一-鿿]/.test(l)).join('\n');
  }
  if (input.marketDecision && !input.marketDecision.canCalculateRoi && /\bROI\b[^\n\d]*\d|марж[ауы]\D*\d|прибыл[ьи]\D*\d/i.test(fixed)) {
    errors.push('roi without confirmed market');
    fixed = fixed.split('\n').filter((l) => !/\bROI\b[^\n\d]*\d|марж[ауы]\D*\d|прибыл[ьи]\D*\d/i.test(l)).join('\n');
  }
  fixed = fixed.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return { ok: errors.length === 0, errors, fixedText: fixed };
}

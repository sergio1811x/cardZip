import type { RawProduct1688 } from '../types';
import { cleanChineseTitle, normalizeSkuText, normalizeMixedProductText, detectPackCount, extractShoeSize, extractLetterSize, extractSkuComponents } from './cnNormalize';

export type DecisionConfidence = 'high' | 'medium' | 'low';

export type PriceDecision = {
  displayPriceText: string;
  calculationPriceYuan: number | null;
  minPriceYuan: number | null;
  maxPriceYuan: number | null;
  selectedSkuName?: string;
  selectedSkuPriceYuan?: number;
  priceSource: 'direct' | 'promotion' | 'selected_sku' | 'sku_range' | 'price_range' | 'fallback_min' | 'missing' | 'sku';
  isEstimated: boolean;
  isSkuDependent: boolean;
  isPackDependent: boolean;
  canCalculateCost: boolean;
  canCalculateRoi: false;
  needsSkuConfirmation: boolean;
  reason: string;
};

export type WeightDecision = {
  weightKg: number | null;
  displayText: string;
  source: 'provider' | 'manual' | 'category_default' | 'missing';
  isEstimated: boolean;
  canUseForCargo: boolean;
  canUseForRoi: false;
  reason: string;
};

export type SkuDecision = {
  skuDimensions: string[];
  skuSummary: string;
  skuCount: number;
  shownSkuCount: number;
  skuVariantsNormalized: Array<{ raw: string; label: string; priceYuan: number | null; packCount?: number; size?: string; color?: string; components?: string[] }>;
  colorOptions?: string[];
  sizeOptions?: string[];
  componentOptions?: string[];
  isMultiPack: boolean;
  needsSelection: boolean;
  priceText?: string;
  recommendedSampleSku?: string;
  skuRisks: string[];
};

export type ReadinessDecision = {
  score: number;
  status: 'ready_for_sample' | 'needs_supplier_confirmation' | 'needs_market_check' | 'high_risk' | 'not_ready';
  label: '🟢 Можно заказывать образец' | '🟡 Нужны данные' | '🟡 Нужно проверить рынок' | '🔴 Высокий риск' | '🔴 Не готово к закупке';
  positiveSignals: string[];
  blockers: string[];
  risks: string[];
  missingData: string[];
  nextActions: string[];
  canRecommendSample: boolean;
  canRecommendBatch: false;
  reason: string;
};

export type MarketDecision = {
  status: 'manual_only' | 'not_required' | 'confirmed' | 'weak' | 'not_confirmed' | 'rate_limited';
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

export type CostDecision = {
  status: 'not_calculated_no_price' | 'cost_without_cargo' | 'cost_with_manual_weight' | 'scenario_by_manual_sale_price';
  canShowPurchaseRub: boolean;
  canShowCostWithoutCargo: boolean;
  canShowCargo: boolean;
  canShowRoi: boolean;
  purchaseRub: number | null;
  costWithoutCargoRub: number | null;
  cargoRub: number | null;
  totalCostRub: number | null;
  manualSalePriceRub?: number | null;
  scenarioProfitRub?: number | null;
  scenarioRoiPercent?: number | null;
  breakEvenPriceRub?: number | null;
  warnings: string[];
  nextAction: string;
};

export type EconomyDecision = {
  status: 'not_calculated_no_price' | 'cost_without_cargo' | 'cost_with_manual_weight' | 'scenario_by_manual_sale_price' | 'preliminary_no_weight' | 'preliminary_sku' | 'cost_only_no_market' | 'estimated_weight' | 'weak_market_data' | 'full';
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
    marketNameRu?: string; shortNameRu?: string; productKind?: string; categoryType?: string; subCategoryType?: string; categoryPath?: string[]; coreObject?: string; formFactor?: string; audience?: string; gender?: string; season?: string; useCases?: string[]; materials?: any[]; material?: any[]; powerType?: string[]; visibleFeatures?: string[]; importantFeatures?: any[]; notConfirmedFeatures?: string[]; possibleConfusions?: string[]; notThis?: string[];
  };
  cleanTitles?: { titleCnClean?: string; titleRuClean?: string; titleForReport?: string; titleForWb?: string };
  wbSearch?: { wbCoreQuery?: string; queryCandidates?: string[]; negativeSearchTerms?: string[]; tooBroadQueries?: string[]; tooNarrowQueries?: string[] };
  matchingRules?: { mustHaveForDirectAnalog?: string[]; allowedDifferences?: string[]; directAnalogBlockers?: string[]; similarOnlyIf?: string[]; rejectIf?: string[] };
  claimsPolicy?: { allowedClaims?: string[]; claimedButNeedProof?: string[]; forbiddenAsFact?: string[]; safeRewrites?: Array<{ original: string; safe: string }> };
  reportRules?: { buyerMustCheck?: string[]; buyerMustNotAsk?: string[]; cargoMustCheck?: string[]; seoAllowedClaims?: string[]; seoForbiddenClaims?: string[]; importantAttributesToShow?: string[]; attributesToHide?: string[]; sampleCheckList?: string[]; photoBriefItems?: string[]; infographicIdeas?: string[]; riskFlags?: string[] };
  supplierQuestions?: { ru?: string[]; cn?: string[] };
  dataQuality?: { missingCriticalFields?: string[]; skuRisk?: string; priceRisk?: string; weightRisk?: string; claimsRisk?: string; supplierRisk?: string; marketRisk?: string; visionConfidence?: DecisionConfidence; textConfidence?: DecisionConfidence; overallConfidence?: DecisionConfidence | string; reason?: string };
};

const YUAN_FALLBACK = 11.8;
const BANK_MARKUP = 0.03;
const DEFAULT_FULFILLMENT_RUB = 80;
const DEFAULT_CARGO_RUB_PER_KG = 400;
const DEFAULT_MARKETPLACE_COST_RATE = 0.28; // commission + acquiring + tax + logistics baseline for manual scenario

const CATEGORY_DEFAULT_WEIGHT: Record<string, number> = { shoes: 0.8, clothing: 0.3, clothes: 0.3, electronics: 0.5, accessory: 0.2, kitchen: 0.45, home: 0.4, beauty: 0.25, fishing: 0.25, tools: 0.7, other: 0.4 };

const CATEGORY_BUYER_CHECKS: Record<string, string[]> = {
  shoes: ['размерная сетка', 'длина стельки по каждому размеру', 'материал верха', 'материал подошвы', 'вес пары с упаковкой', 'размеры индивидуальной коробки', 'запах материала после распаковки', 'реальные фото пары, подошвы, стельки и упаковки', 'MOQ по цветам и размерам', 'образец'],
  clothing: ['состав ткани', 'плотность/сезонность материала', 'размерная сетка', 'замеры изделия', 'усадка после стирки', 'цветопередача', 'реальные фото, бирки и упаковка'],
  clothes: ['состав ткани', 'плотность/сезонность материала', 'размерная сетка', 'замеры изделия', 'усадка после стирки', 'цветопередача', 'реальные фото, бирки и упаковка'],
  electronics: ['точная модель/SKU', 'тип питания/разъём', 'комплектация', 'мощность/напряжение, если товар электрический', 'батарея, если есть', 'инструкция и сертификаты', 'вес с упаковкой'],
  beauty: ['состав', 'срок годности', 'документы/декларации', 'маркировка', 'упаковка', 'запах и консистенция образца'],
  kids: ['сертификаты', 'возрастная маркировка', 'мелкие детали', 'безопасность материалов документально', 'упаковка и инструкция'],
  passive_insect_trap: ['точная комплектация выбранного SKU', 'материал корпуса', 'размер одной ловушки', 'вес упаковки выбранной комплектации', 'есть ли приманка в комплекте', 'способ крепления/подвешивания', 'реальные фото товара и упаковки'],
  other: ['точная комплектация выбранного SKU', 'материал', 'размеры', 'вес с упаковкой', 'реальные фото товара и упаковки', 'MOQ и срок отгрузки'],
};

const CATEGORY_MUST_NOT_ASK: Record<string, string[]> = {
  shoes: ['рукав', 'мощность', 'напряжение', 'аккумулятор', 'тип вилки', 'усадка после стирки'],
  clothing: ['мощность', 'напряжение', 'аккумулятор', 'тип вилки', 'длина стельки'],
  clothes: ['мощность', 'напряжение', 'аккумулятор', 'тип вилки', 'длина стельки'],
  electronics: ['рукав', 'длина стельки', 'размерная сетка одежды', 'состав ткани'],
  passive_insect_trap: ['мощность', 'напряжение', '220V', 'тип вилки', 'аккумулятор', 'зарядка', 'тип лампы', 'электрическая лампа', 'ультразвуковая'],
};

function asArray<T = any>(v: unknown): T[] { return Array.isArray(v) ? v as T[] : []; }
function asRecord(v: unknown): Record<string, any> { return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {}; }
function num(value: unknown): number | null { if (typeof value === 'number' && Number.isFinite(value)) return value; if (typeof value === 'string') { const n = Number(value.replace(',', '.').replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : null; } return null; }
function positive(value: unknown): number | null { const n = num(value); return n !== null && n > 0 ? Math.round(n * 100) / 100 : null; }
function cny(value: number | null | undefined): string { if (!value || !Number.isFinite(value) || value <= 0) return 'нужно уточнить'; return `${String(Math.round(value * 100) / 100).replace('.', ',')} ¥`; }
function money(value: number | null | undefined): string { if (!value || !Number.isFinite(value) || value <= 0) return '—'; return `${Math.round(value).toLocaleString('ru-RU')} ₽`; }
function rangeText(min: number | null, max: number | null): string { if (!min && !max) return 'нужно уточнить'; if (min && max && min !== max) return `${cny(min).replace(' ¥', '')}–${cny(max).replace(' ¥', '')} ¥`; return cny(min ?? max); }
function html(value: unknown): string { return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function clean(value: unknown): string { return String(value ?? '').replace(/\b(?:undefined|null|NaN|Infinity|-Infinity)\b/gi, '—').replace(/0(?:[,.]0+)?\s*[¥￥₽]/gi, 'цена уточняется').replace(/0(?:[,.]0+)?\s*(?:кг|kg)\b/gi, 'вес уточняется').replace(/\s+/g, ' ').trim(); }
function normalizeFact(value: unknown): string { return clean(normalizeMixedProductText(value)); }
function uniq(list: string[], limit = 20): string[] { const seen = new Set<string>(); const out: string[] = []; for (const raw of list) { const text = clean(raw); if (!text || /^[-—]$/.test(text)) continue; const key = text.toLowerCase(); if (seen.has(key)) continue; seen.add(key); out.push(text); if (out.length >= limit) break; } return out; }
function stripNumber(v: unknown): string { return normalizeFact(v).replace(/^\s*(?:\d+[.)]|[-•])\s*/g, '').trim(); }

function displaySkuSummary(summary: string): string { return clean(summary).replace(/^SKU:\s*/i, ''); }
function displayPriceSummary(text: string): string { return clean(text).replace(/^Цена выбранного SKU:\s*/i, 'выбранный SKU: ').replace(/^Цена по SKU:\s*/i, 'по SKU: ').replace(/^Цена:\s*/i, ''); }

function pluralRu(n: number, one: string, few: string, many: string): string {
  const v = Math.abs(n) % 100;
  const v1 = v % 10;
  if (v > 10 && v < 20) return many;
  if (v1 > 1 && v1 < 5) return few;
  if (v1 === 1) return one;
  return many;
}



function cautiousClaim(value: unknown): string {
  const t = normalizeFact(value);
  const lower = t.toLowerCase();
  const parts: string[] = [];
  if (/антибактер|抗菌/.test(lower)) parts.push('заявленное антибактериальное свойство — подтвердить документами/испытаниями');
  if (/противоскольз|防滑/.test(lower)) parts.push('заявленное противоскользящее свойство — проверить на образце');
  if (/防臭|не вызывает запах|защит[а-яё]* от запах|不臭脚/.test(lower)) parts.push('заявленная защита от запаха — проверить на образце');
  if (/водонепрониц|влагозащит|防水/.test(lower)) parts.push('заявленная влагозащита — подтвердить у поставщика');
  if (/лечебн|ортопед|гипоаллерген/.test(lower)) parts.push('регулируемое спецсвойство — только при документах');
  if (parts.length) return uniq(parts, 4).join('; ');
  return t;
}

function getIntel(product: any): ProductIntelligenceLike {
  return asRecord(product?.intelligence ?? product?.productIntelligence ?? product?.productContext?.productIntelligence) as ProductIntelligenceLike;
}
function getIdentity(product: any, intel = getIntel(product)) { return asRecord(intel.productIdentity ?? product?.productContext?.identity); }
function categoryType(product: any, intel = getIntel(product)): string {
  const raw = String(getIdentity(product, intel).categoryType ?? product?.categoryType ?? product?.productContext?.identity?.categoryType ?? '').toLowerCase();
  if (raw === 'clothes') return 'clothing';
  if (raw) return raw;
  const text = `${product?.titleCn ?? ''} ${product?.titleRu ?? ''} ${product?.categoryName ?? ''}`.toLowerCase();
  if (/鞋|сабо|сандал|тапоч|шл[её]пан|обув/.test(text)) return 'shoes';
  if (/плать|брюк|леггинс|футбол|одежд|衣|裤/.test(text)) return 'clothing';
  if (/usb|аккумулятор|электр|电/.test(text)) return 'electronics';
  if (/космет|cream|маска|beauty/.test(text)) return 'beauty';
  if (/детск|孩子|儿童/.test(text)) return 'kids';
  return 'other';
}
function titleForReport(product: any, intel = getIntel(product)): string {
  return clean(intel.cleanTitles?.titleForReport || intel.productIdentity?.shortNameRu || intel.productIdentity?.marketNameRu || product?.titleRu || product?.seoContent?.titleRu || product?.titleEn || normalizeMixedProductText(product?.titleCn) || 'Товар 1688');
}
function imagesCount(product: any): number { for (const src of [product?.images, product?.imageUrls, product?.normalized1688?.images]) { const a = asArray(src); if (a.length) return a.length; } return positive(product?.normalized1688?.imageCount ?? product?.photosCount) ?? (product?.mainImageUrl ? 1 : 0); }

function collectSku(product: any): any[] { return asArray(product?.skus).length ? asArray(product.skus) : asArray(product?.normalized1688?.skuVariants); }
function skuPrice(s: any): number | null { return positive(s?.priceYuan ?? s?.price ?? s?.discountPrice ?? s?.salePrice); }

function valueFromLabel(label: string, prefix: string): string | undefined {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = label.match(new RegExp(`${escaped}:\\s*([^;]+)`, 'i'));
  return m?.[1]?.trim();
}

function describeSkuDimensions(dims: string[]): string {
  return dims.map(d => ({ color: 'цвет', size: 'размер', model: 'модель', packCount: 'количество штук', details: 'комплектация' } as Record<string, string>)[d] ?? d).join(' × ');
}

export function buildSkuDecision(product: RawProduct1688 | any, intelligence?: ProductIntelligenceLike): SkuDecision {
  const variantsRaw = collectSku(product);
  const variants = variantsRaw.map((s, i) => {
    const raw = String(s?.name ?? s?.label ?? s?.skuName ?? s?.propertiesName ?? `SKU ${i + 1}`);
    const label = normalizeSkuText(raw) || normalizeFact(raw) || `SKU ${i + 1}`;
    const color = valueFromLabel(label, 'Цвет');
    const size = extractShoeSize(raw) || extractLetterSize(raw) || valueFromLabel(label, 'Размер');
    const components = uniq([...(extractSkuComponents(raw) ?? []), ...(valueFromLabel(label, 'Комплектация/детали')?.split(',').map(v => v.trim()) ?? [])], 8);
    return { raw, label, priceYuan: skuPrice(s), packCount: detectPackCount(raw), size, color, components };
  }).filter(v => v.raw || v.label);

  const prices = variants.map(v => v.priceYuan).filter((p): p is number => !!p);
  const rawText = variants.map(v => `${v.raw} ${v.label}`).join(' ');
  const colorOptions = uniq(variants.map(v => v.color || '').filter(Boolean), 20);
  const sizeOptions = uniq(variants.map(v => v.size || '').filter(Boolean), 30);
  const componentOptions = uniq(variants.flatMap(v => v.components ?? []), 20);

  const dims: string[] = [];
  if (colorOptions.length || /цвет|color|白|黑|红|蓝|绿|黄|粉|хаки|бел|черн|чёрн|розов/i.test(rawText)) dims.push('color');
  if (sizeOptions.length || /размер|size|尺码|码|\b(?:XS|S|M|L|XL|XXL|XXXL|2XL|3XL)\b|\b3[5-9]\b|\b4[0-9]\b/i.test(rawText) || categoryType(product, intelligence) === 'shoes') dims.push('size');
  if (/модель|version|款|型号|经典|普通|基础|高版本/i.test(rawText)) dims.push('model');
  const isMultiPack = variants.some(v => !!v.packCount);
  if (isMultiPack) dims.push('packCount');
  if (componentOptions.length) dims.push('details');
  const uniqueDims = uniq(dims, 6);

  const numericSizes = sizeOptions.map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
  const letterSizes = sizeOptions.filter(s => !/^\d+$/.test(s));
  const parts = variants.length ? [`SKU: ${variants.length} ${pluralRu(variants.length, 'вариант', 'варианта', 'вариантов')}`] : ['SKU: не указаны'];
  if (uniqueDims.length) parts.push(describeSkuDimensions(uniqueDims));
  if (colorOptions.length) parts.push(`цвета: ${colorOptions.slice(0, 6).join(', ')}${colorOptions.length > 6 ? '…' : ''}`);
  if (numericSizes.length) parts.push(`размеры ${numericSizes[0]}–${numericSizes[numericSizes.length - 1]}`);
  else if (letterSizes.length) parts.push(`размеры ${letterSizes.slice(0, 8).join(', ')}`);
  if (componentOptions.length) parts.push(`детали: ${componentOptions.slice(0, 4).join(', ')}`);
  if (/маломер|偏小一码/.test(rawText)) parts.push('маломерит на 1 размер');
  if (prices.length) parts.push(`цена по SKU ${rangeText(Math.min(...prices), Math.max(...prices))}`);
  if (variants.length > 15) parts.push('показаны первые 15');

  const safeVariants = variants.slice(0, 15);
  const rec = safeVariants.find(v => /бел|черн|чёрн|хаки|40|39|38|\bM\b|\bL\b/.test(v.label))?.label ?? safeVariants[0]?.label;
  const skuRisks = uniq([
    ...(variants.length > 1 ? ['нужно выбрать конкретный SKU перед расчётом'] : []),
    ...(isMultiPack ? ['цена и вес зависят от комплектации'] : []),
    ...(uniqueDims.includes('details') ? ['проверить комплектацию/детали выбранного SKU'] : []),
    ...(/маломер|偏小一码/.test(rawText) ? ['поставщик указывает риск маломерности'] : []),
  ], 8);
  return {
    skuDimensions: uniqueDims,
    skuSummary: parts.join(' · '),
    skuCount: variants.length,
    shownSkuCount: safeVariants.length,
    skuVariantsNormalized: safeVariants,
    colorOptions,
    sizeOptions,
    componentOptions,
    isMultiPack,
    needsSelection: variants.length > 1,
    priceText: prices.length ? `Цена по SKU: ${rangeText(Math.min(...prices), Math.max(...prices))}` : undefined,
    recommendedSampleSku: rec,
    skuRisks,
  };
}

export function buildPriceDecision(product: RawProduct1688 | any, sku = buildSkuDecision(product)): PriceDecision {
  const pricing = asRecord(product?.normalized1688?.pricing);
  const selectedSkuName = pricing.selectedSkuName || product?.selectedSkuName;
  const selectedSkuPrice = positive(pricing.selectedSkuPriceYuan ?? product?.selectedSkuPriceYuan);
  if (selectedSkuPrice) return { displayPriceText: `Цена выбранного SKU: ${cny(selectedSkuPrice)}${selectedSkuName ? ` · ${normalizeSkuText(selectedSkuName) || normalizeFact(selectedSkuName)}` : ''}`, calculationPriceYuan: selectedSkuPrice, minPriceYuan: selectedSkuPrice, maxPriceYuan: selectedSkuPrice, selectedSkuName, selectedSkuPriceYuan: selectedSkuPrice, priceSource: 'selected_sku', isEstimated: false, isSkuDependent: false, isPackDependent: sku.isMultiPack, canCalculateCost: true, canCalculateRoi: false, needsSkuConfirmation: false, reason: 'Выбран конкретный SKU с положительной ценой.' };
  const skuPrices = sku.skuVariantsNormalized.map(v => v.priceYuan).filter((p): p is number => !!p);
  if (skuPrices.length) { const sorted = skuPrices.slice().sort((a,b)=>a-b); const min = sorted[0]; const max = sorted[sorted.length - 1]; const calc = sorted[Math.floor(sorted.length / 2)]; return { displayPriceText: `${sku.isMultiPack ? 'Цена зависит от комплектации' : 'Цена по SKU'}: ${rangeText(min, max)}. Для точного расчёта выберите цвет/размер/модель.`, calculationPriceYuan: calc, minPriceYuan: min, maxPriceYuan: max, priceSource: 'sku_range', isEstimated: min !== max, isSkuDependent: true, isPackDependent: sku.isMultiPack, canCalculateCost: true, canCalculateRoi: false, needsSkuConfirmation: true, reason: 'Цена взята из диапазона SKU; для точного расчёта нужен выбранный SKU.' }; }
  const ranges = asArray<any>(product?.priceRange ?? pricing.priceRanges).map(r => ({ minQty: positive(r?.minQty ?? r?.min_quantity) ?? 1, maxQty: positive(r?.maxQty ?? r?.max_quantity), price: positive(r?.price ?? r?.priceYuan) })).filter(r => !!r.price) as Array<{ minQty: number; maxQty: number | null; price: number }>;
  if (ranges.length) { const prices = ranges.map(r => r.price); const min = Math.min(...prices); const max = Math.max(...prices); const uniqueQty = new Set(ranges.map(r => r.minQty)).size; const details = ranges.slice(0,4).map(r => `${r.minQty}+ шт — ${cny(r.price)}`).join('; '); return { displayPriceText: uniqueQty > 1 ? `Оптовые цены: ${rangeText(min,max)}; ${details}` : `Цена по вариантам: ${rangeText(min,max)}. Оптовые пороги не найдены.`, calculationPriceYuan: min, minPriceYuan: min, maxPriceYuan: max, priceSource: uniqueQty > 1 ? 'price_range' : 'fallback_min', isEstimated: true, isSkuDependent: uniqueQty === 1 || min !== max, isPackDependent: sku.isMultiPack, canCalculateCost: true, canCalculateRoi: false, needsSkuConfirmation: true, reason: uniqueQty > 1 ? 'Есть priceRange с порогами количества.' : 'priceRange похож на цены вариантов, а не на скидки.' }; }
  const promo = positive(pricing.promotionPriceYuan ?? product?.promotionPrice ?? product?.promotion_price); if (promo) return { displayPriceText: `Цена: ${cny(promo)}`, calculationPriceYuan: promo, minPriceYuan: promo, maxPriceYuan: promo, priceSource: 'promotion', isEstimated: false, isSkuDependent: sku.needsSelection, isPackDependent: sku.isMultiPack, canCalculateCost: true, canCalculateRoi: false, needsSkuConfirmation: sku.needsSelection || sku.isMultiPack, reason: 'Использована промо-цена поставщика.' };
  const direct = positive(pricing.directPriceYuan ?? product?.priceYuan ?? product?.price); if (direct) return { displayPriceText: `Цена: ${cny(direct)}`, calculationPriceYuan: direct, minPriceYuan: direct, maxPriceYuan: direct, priceSource: 'direct', isEstimated: false, isSkuDependent: sku.needsSelection, isPackDependent: sku.isMultiPack, canCalculateCost: true, canCalculateRoi: false, needsSkuConfirmation: sku.needsSelection || sku.isMultiPack, reason: 'Использована витринная цена поставщика.' };
  return { displayPriceText: '—', calculationPriceYuan: null, minPriceYuan: null, maxPriceYuan: null, priceSource: 'missing', isEstimated: false, isSkuDependent: sku.needsSelection, isPackDependent: sku.isMultiPack, canCalculateCost: false, canCalculateRoi: false, needsSkuConfirmation: sku.needsSelection, reason: 'Нет положительной цены в direct/promotion/SKU/priceRange.' };
}

export function buildWeightDecision(product: RawProduct1688 | any, intelligence?: ProductIntelligenceLike, sku = buildSkuDecision(product, intelligence)): WeightDecision {
  const manual = positive(product?.manualWeightKg ?? product?.supplierAnswer?.weightKg ?? product?.confirmedWeightKg);
  if (manual) return { weightKg: manual, displayText: `Вес: ${manual} кг, введён вручную`, source: 'manual', isEstimated: false, canUseForCargo: true, canUseForRoi: false, reason: 'Вес введён/подтверждён вручную.' };
  const provider = positive(product?.normalized1688?.weightKg ?? product?.weightKg ?? product?.shipping_info?.weight);
  if (provider) return { weightKg: provider, displayText: `Вес: ${provider} кг`, source: 'provider', isEstimated: false, canUseForCargo: true, canUseForRoi: false, reason: 'Вес получен от поставщика/провайдера.' };
  if (sku.isMultiPack) return { weightKg: null, displayText: 'Вес: нужно уточнить для выбранной комплектации', source: 'missing', isEstimated: false, canUseForCargo: false, canUseForRoi: false, reason: 'Вес не указан; у товара разные комплектации, средний вес категории не применён.' };
  const fallback = CATEGORY_DEFAULT_WEIGHT[categoryType(product, intelligence)] ?? CATEGORY_DEFAULT_WEIGHT.other;
  return { weightKg: fallback, displayText: `Вес: ориентир ${fallback} кг по категории, не для ROI`, source: 'category_default', isEstimated: true, canUseForCargo: false, canUseForRoi: false, reason: 'Вес не указан; категорийный вес можно показывать только как ориентир.' };
}

export function buildMarketDecision(_product: any): MarketDecision { return { status: 'not_required', rawCandidatesCount: 0, confirmedDirectCount: 0, similarLocalCount: 0, crossBorderCount: 0, categoryOnlyCount: 0, medianPriceRub: null, p25PriceRub: null, p75PriceRub: null, canShowMedianPrice: false, canCalculateRoi: false, confidence: 'low', reason: 'Автоматический WB/Ozon-поиск не входит в обязательный MVP. Рынок проверяется вручную или через будущий модуль конкурентов.' }; }

export function buildCostDecision(input: { priceDecision: PriceDecision; weightDecision: WeightDecision; yuanRate?: number; manualSalePriceRub?: number | null }): CostDecision {
  const { priceDecision: price, weightDecision: weight } = input;
  const yuanRate = input.yuanRate && input.yuanRate > 0 ? input.yuanRate : YUAN_FALLBACK;
  if (!price.canCalculateCost || !price.calculationPriceYuan) return { status: 'not_calculated_no_price', canShowPurchaseRub: false, canShowCostWithoutCargo: false, canShowCargo: false, canShowRoi: false, purchaseRub: null, costWithoutCargoRub: null, cargoRub: null, totalCostRub: null, manualSalePriceRub: input.manualSalePriceRub ?? null, scenarioProfitRub: null, scenarioRoiPercent: null, breakEvenPriceRub: null, warnings: ['Себестоимость не рассчитана — нет цены товара.'], nextAction: 'Уточнить цену выбранного SKU у поставщика.' };
  const purchaseRub = Math.round(price.calculationPriceYuan * yuanRate);
  const bankRub = Math.round(purchaseRub * BANK_MARKUP);
  const costWithoutCargoRub = purchaseRub + bankRub + DEFAULT_FULFILLMENT_RUB;
  const cargoRub = weight.canUseForCargo && weight.weightKg ? Math.round(weight.weightKg * DEFAULT_CARGO_RUB_PER_KG) : null;
  const totalCostRub = cargoRub ? costWithoutCargoRub + cargoRub : null;
  const sale = positive(input.manualSalePriceRub);
  const warnings = uniq([...(price.needsSkuConfirmation ? ['цена зависит от выбранного SKU/комплектации'] : []), ...(!weight.canUseForCargo ? ['карго не рассчитано — нужен вес с упаковкой'] : []), ...(weight.isEstimated ? ['вес только ориентировочный по категории'] : [])], 10);
  if (sale && totalCostRub) { const marketplace = Math.round(sale * DEFAULT_MARKETPLACE_COST_RATE); const profit = sale - totalCostRub - marketplace; const roi = totalCostRub > 0 ? Math.round((profit / totalCostRub) * 100) : null; return { status: 'scenario_by_manual_sale_price', canShowPurchaseRub: true, canShowCostWithoutCargo: true, canShowCargo: true, canShowRoi: true, purchaseRub, costWithoutCargoRub, cargoRub, totalCostRub, manualSalePriceRub: sale, scenarioProfitRub: profit, scenarioRoiPercent: roi, breakEvenPriceRub: Math.round((totalCostRub + marketplace) / Math.max(0.01, 1 - DEFAULT_MARKETPLACE_COST_RATE)), warnings: [...warnings, 'ROI сценарный: рассчитан по цене, введённой пользователем, а не по автоматическому рынку.'], nextAction: 'Проверить цену продажи вручную и подтвердить вес/упаковку перед закупкой.' }; }
  return { status: cargoRub ? 'cost_with_manual_weight' : 'cost_without_cargo', canShowPurchaseRub: true, canShowCostWithoutCargo: true, canShowCargo: !!cargoRub, canShowRoi: false, purchaseRub, costWithoutCargoRub, cargoRub, totalCostRub, manualSalePriceRub: sale ?? null, scenarioProfitRub: null, scenarioRoiPercent: null, breakEvenPriceRub: null, warnings, nextAction: weight.canUseForCargo ? 'Введите предполагаемую цену продажи или добавьте конкурентов вручную.' : 'Уточните вес с упаковкой, затем пересчитаю себестоимость.' };
}

export function buildEconomyDecision(priceDecision: PriceDecision, weightDecision: WeightDecision, _marketDecision?: MarketDecision, opts: { yuanToRub?: number; manualSalePriceRub?: number | null } = {}): EconomyDecision {
  const cost = buildCostDecision({ priceDecision, weightDecision, yuanRate: opts.yuanToRub, manualSalePriceRub: opts.manualSalePriceRub });
  return { status: cost.status, canShowCost: cost.canShowCostWithoutCargo, canShowCargo: cost.canShowCargo, canShowMargin: cost.canShowRoi, canShowRoi: cost.canShowRoi, costRub: cost.totalCostRub ?? cost.costWithoutCargoRub, costWithoutCargoRub: cost.costWithoutCargoRub, cargoRub: cost.cargoRub, profitRub: cost.scenarioProfitRub ?? null, roiPercent: cost.scenarioRoiPercent ?? null, warnings: cost.warnings, nextAction: cost.nextAction };
}

function looksLikeFeature(value: string): boolean {
  return /заявлен|противоскольз|антибактер|влагозащит|защит[а-яё ]*от запах|молни|шнурок|манжет|комплектац|размер|подошв|материал|PVC|ПВХ/i.test(value);
}
function looksLikeColor(value: string): boolean {
  return /^(?:хаки|зел[её]ный|ч[её]рный|черный|белый|молочно-белый|розовый|красный|ж[её]лтый|синий|серый|оранжевый|фиолетовый)(?:[,/ ]|$)/i.test(value.trim());
}
function normalizeAttributePair(nameRaw: unknown, valueRaw: unknown): { name: string; value: string; status: string } | null {
  let name = normalizeFact(nameRaw);
  let value = cautiousClaim(valueRaw);
  if (!name || !value || /^(id|url|debug|raw)$/i.test(name)) return null;
  const nameLower = name.toLowerCase();
  if (/^(?:цвет|颜色|colour|color)$/i.test(nameLower) && !looksLikeColor(value)) {
    if (looksLikeFeature(value)) name = 'Особенность';
    else return null;
  }
  if (/^(?:производитель|место производства|провинция|страна производства)$/i.test(nameLower) && /китай|провинц/i.test(value)) {
    return null;
  }
  if (/бренд/i.test(nameLower) && value.length <= 2) return null;
  const status = /заявлен|подтверд|проверить|уточнить|документ|испытан/i.test(value) ? 'нужно подтвердить' : 'из карточки 1688';
  return { name, value, status };
}

function collectRawAttributes(product: any, limit = 24): Array<{ name: string; value: string; status: string }> {
  const attrs = asArray<any>(product?.normalized1688?.attributes ?? product?.attributes ?? product?.raw1688?.attributesRaw);
  const out: Array<{ name: string; value: string; status: string }> = [];
  for (const a of attrs) {
    const normalized = normalizeAttributePair(a?.name ?? a?.key ?? a?.attrName, a?.value ?? a?.val ?? a?.attrValue);
    if (!normalized) continue;
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}
function collectIntelFacts(product: any, intel = getIntel(product), limit = 20): Array<{ name: string; value: string; status: string }> {
  const id = getIdentity(product, intel); const facts = asRecord((intel as any).facts ?? product?.productContext?.facts);
  const pairs: Array<[string, unknown]> = [['Тип', id.productKind || id.coreObject || titleForReport(product, intel)], ['Форм-фактор', id.formFactor], ['Аудитория', id.audience], ['Пол', id.gender], ['Сезон', id.season], ['Материалы', asArray(id.materials ?? id.material).map((m:any)=> typeof m === 'string' ? m : m?.value).join(', ')], ['Сценарии использования', asArray(id.useCases).join(', ')], ['Видимые особенности', asArray(id.visibleFeatures).join(', ')], ['Важные особенности', asArray(id.importantFeatures).map((v:any)=> typeof v === 'string' ? v : v?.value).join(', ')], ...Object.entries(facts)];
  const out: Array<{ name: string; value: string; status: string }> = [];
  for (const [n, v] of pairs) {
    const normalized = normalizeAttributePair(n, v);
    if (!normalized) continue;
    // Do not expose internal source labels like Product Intelligence to user files.
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}
function mergeFacts(...groups: Array<Array<{ name: string; value: string; status?: string }>>): Array<{ name: string; value: string; status: string }> { const seen = new Set<string>(); const out: Array<{ name: string; value: string; status: string }> = []; for (const g of groups) for (const f of g) { const normalized = normalizeAttributePair(f.name, f.value); if (!normalized) continue; const key = `${normalized.name.toLowerCase()}:${normalized.value.toLowerCase()}`; if (seen.has(key)) continue; seen.add(key); out.push({ ...normalized, status: f.status && !/Product Intelligence|AI-черновик/i.test(f.status) ? f.status : normalized.status }); } return out; }

export function buildReadinessDecision(input: { product: any; intelligence: ProductIntelligenceLike; priceDecision: PriceDecision; weightDecision: WeightDecision; skuDecision?: SkuDecision }): ReadinessDecision {
  const { product, intelligence, priceDecision: price, weightDecision: weight } = input; const sku = input.skuDecision ?? buildSkuDecision(product, intelligence); const facts = mergeFacts(collectIntelFacts(product, intelligence, 8), collectRawAttributes(product, 8));
  let score = 20; const positiveSignals: string[] = []; const blockers: string[] = []; const risks: string[] = []; const missingData: string[] = [];
  if (price.canCalculateCost) { score += 15; positiveSignals.push('цена товара распознана'); } else { score -= 20; blockers.push('нет цены товара'); missingData.push('цена выбранного SKU'); }
  if (positive(product?.moq ?? product?.normalized1688?.moq)) { score += 10; positiveSignals.push('MOQ понятен'); } else { missingData.push('MOQ'); }
  if (sku.skuCount > 0) { score += 15; positiveSignals.push('SKU разобраны'); } else if (sku.needsSelection) { score -= 20; blockers.push('SKU не разобраны'); }
  if (product?.supplierName || product?.supplierType) { score += 10; positiveSignals.push('есть данные поставщика'); } else risks.push('поставщик не описан');
  if (positive(product?.sold ?? product?.normalized1688?.salesCount)) { score += 10; positiveSignals.push('есть продажи/заказы на 1688'); }
  if (imagesCount(product) > 0) { score += 10; positiveSignals.push('есть фото товара'); } else missingData.push('фото товара');
  if (facts.length >= 3) { score += 10; positiveSignals.push('есть характеристики/особенности товара'); } else risks.push('мало характеристик в карточке');
  if (weight.canUseForCargo) { score += 10; positiveSignals.push('есть вес для расчёта карго'); } else { score -= 15; missingData.push('вес с упаковкой'); risks.push('карго нельзя рассчитать точно без веса'); }
  const claimRisk = uniq([...(intelligence.claimsPolicy?.claimedButNeedProof ?? []), ...(intelligence.reportRules?.seoForbiddenClaims ?? []), ...facts.filter(f => /заявлен|документ|испытан|сертифик|спецсвойств/i.test(f.value)).map(f => `${f.name}: ${f.value}`)], 8);
  if (claimRisk.length) { score -= 15; risks.push('есть свойства, которые нужно подтвердить документами/образцом'); } else score += 10;
  if (sku.isMultiPack && !weight.canUseForCargo) { score -= 10; blockers.push('у multi-pack товара нужен вес выбранной комплектации'); }
  score = Math.max(0, Math.min(100, score));
  let status: ReadinessDecision['status'] = 'needs_supplier_confirmation'; let label: ReadinessDecision['label'] = '🟡 Нужны данные';
  if (!price.canCalculateCost) { status = 'not_ready'; label = '🔴 Не готово к закупке'; }
  else if (score >= 75 && weight.canUseForCargo && !claimRisk.length) { status = 'ready_for_sample'; label = '🟢 Можно заказывать образец'; }
  else if (score < 45 || blockers.length >= 2) { status = 'high_risk'; label = '🔴 Высокий риск'; }
  else if (!weight.canUseForCargo || price.needsSkuConfirmation) { status = 'needs_supplier_confirmation'; label = '🟡 Нужны данные'; }
  else { status = 'needs_market_check'; label = '🟡 Нужно проверить рынок'; }
  const nextActions = uniq([...(missingData.length ? ['отправить вопросы поставщику и закрыть недостающие данные'] : []), ...(weight.canUseForCargo ? ['ввести предполагаемую цену продажи для сценария'] : ['уточнить вес с упаковкой']), 'подготовить SEO/ТЗ байеру и проверить рынок вручную', ...(score >= 55 ? ['рассмотреть заказ 1 образца после подтверждения SKU'] : [])], 5);
  return { score, status, label, positiveSignals: uniq(positiveSignals, 8), blockers: uniq(blockers, 8), risks: uniq(risks, 10), missingData: uniq([...missingData, ...(intelligence.dataQuality?.missingCriticalFields ?? [])], 12), nextActions, canRecommendSample: score >= 55 && price.canCalculateCost, canRecommendBatch: false, reason: `${label}. Готовность ${score}/100: ${nextActions[0] ?? 'нужно уточнить данные'}.` };
}

export function buildDecisionContext(product: any) { const intelligence = getIntel(product); const sku = buildSkuDecision(product, intelligence); const price = buildPriceDecision(product, sku); const weight = buildWeightDecision(product, intelligence, sku); const market = buildMarketDecision(product); const economy = buildEconomyDecision(price, weight, market, { yuanToRub: product?.economics?.yuanToRub, manualSalePriceRub: product?.manualSalePriceRub ?? product?.manualSalePrice ?? product?.scenarioSalePriceRub }); const cost = buildCostDecision({ priceDecision: price, weightDecision: weight, yuanRate: product?.economics?.yuanToRub, manualSalePriceRub: product?.manualSalePriceRub ?? product?.manualSalePrice ?? product?.scenarioSalePriceRub }); const readiness = buildReadinessDecision({ product, intelligence, priceDecision: price, weightDecision: weight, skuDecision: sku }); return { intelligence, sku, price, weight, market, economy, cost, readiness, status: readiness.label, title: titleForReport(product, intelligence), categoryType: categoryType(product, intelligence) }; }

export function buildStatusLine(price: PriceDecision, weight: WeightDecision, _market: MarketDecision, economy: EconomyDecision): string { const readinessLike = (!price.canCalculateCost) ? '🔴 Не готово к закупке' : (!weight.canUseForCargo || price.needsSkuConfirmation) ? '🟡 Нужны данные' : economy.canShowRoi ? '🟡 Сценарий по вашей цене' : '🟡 Нужно проверить рынок'; return readinessLike; }

function topQuestions(product: any, x = buildDecisionContext(product), n = 7): string[] { return buildSupplierQuestions(product, x).ru.slice(0, n); }

export function buildMainReport(product: any, statusInfo?: { creditsRemaining?: number }, _wbCategory?: any): string {
  const x = buildDecisionContext(product);
  const source = String(product?.platform ?? '1688').toUpperCase();
  const supplierType = normalizeFact(product?.supplierType || product?.normalized1688?.supplierType || 'продавец') || 'продавец';
  const supplierRating = normalizeFact(product?.supplierRating ?? product?.normalized1688?.supplierRating);
  const sold = positive(product?.normalized1688?.salesCount ?? product?.sold);
  const moq = positive(product?.normalized1688?.moq ?? product?.moq);
  const materials = materialsLine(x, product);
  const useCases = useCasesLine(x);
  const colorLine = x.sku.colorOptions?.length ? `• Цвета: ${x.sku.colorOptions.slice(0, 8).join(', ')}` : null;
  const sizeLine = x.sku.sizeOptions?.length ? `• Размеры: ${x.sku.sizeOptions.slice(0, 10).join(', ')}` : null;
  const understood = uniq([
    ...x.readiness.positiveSignals,
    ...(x.sku.skuCount ? [`SKU разобраны: ${displaySkuSummary(x.sku.skuSummary)}`] : []),
    ...(useCases ? [`назначение: ${useCases}`] : []),
  ], 5);
  const risks = uniq([
    ...x.readiness.blockers,
    ...x.readiness.risks,
    ...(!x.weight.canUseForCargo ? ['нет веса с упаковкой'] : []),
    'рынок WB/Ozon нужно проверить отдельно',
  ], 5);
  const costLines = buildCostSummaryLines(x);
  const questions = topQuestions(product, x, 7);
  const readinessText = procurementStatusText(x);
  const verdict = x.readiness.canRecommendSample
    ? 'Партию закупать рано. Можно запросить данные у поставщика и готовить 1–2 образца.'
    : 'Закупать партию рано. Сначала закрыть недостающие данные поставщика.';
  const lines = [
    `📦 <b>${html(x.title)}</b>`,
    '',
    `Источник: ${html(source)}`,
    `Поставщик: ${html([supplierType, supplierRating ? `рейтинг ${supplierRating}` : '', sold ? `заказов ${Math.round(sold).toLocaleString('ru-RU')}` : ''].filter(Boolean).join(' · '))}`,
    '',
    '📌 <b>Кратко по товару</b>',
    `• Цена: ${html(displayPriceSummary(x.price.displayPriceText))}`,
    `• MOQ: ${moq ? `${Math.round(moq).toLocaleString('ru-RU')} шт.` : 'уточнить'}`,
    `• SKU: ${html(displaySkuSummary(x.sku.skuSummary))}`,
    ...(colorLine ? [html(colorLine)] : []),
    ...(sizeLine ? [html(sizeLine)] : []),
    `• Фото: ${imagesCount(product) || '—'} шт`,
    `• Вес: ${html(x.weight.displayText.replace(/^Вес:\s*/i, ''))}`,
    `• Материал: ${html(materials)}`,
    `• Назначение: ${html(useCases || 'уточнить по карточке и образцу')}`,
    '',
    `<b>${html(readinessText)}</b>`,
    '',
    '✅ <b>Уже понятно</b>',
    ...(understood.length ? understood.slice(0, 5).map(s => `• ${html(s)}`) : ['• карточка получена, данные можно уточнять у поставщика']),
    '',
    '⚠️ <b>Мешает закупке</b>',
    ...(risks.length ? risks.slice(0, 5).map(s => `• ${html(s)}`) : ['• перед партией нужна ручная проверка рынка и образца']),
    '',
    '💸 <b>Себестоимость</b>',
    ...costLines.map(html),
    '',
    '📌 <b>Что уточнить у поставщика</b>',
    ...questions.map(q => `• ${html(q.replace(/^\d+[.)]\s*/, ''))}`),
    '',
    '📄 <b>Готовые материалы</b>',
    '• вопросы поставщику RU/CN',
    '• ТЗ байеру',
    '• ТЗ карго',
    '• риск-чеклист',
    '• рекомендация по образцу',
    '• SEO-черновик',
    '• ТЗ для инфографики',
    '',
    '🎯 <b>Вердикт</b>',
    html(verdict),
    '',
    'Что сделать:',
    'Нажмите «🚀 Дальнейший план» — покажу, что делать по шагам.',
    '',
    `📦 Осталось: ${typeof statusInfo?.creditsRemaining === 'number' ? Math.max(0, statusInfo.creditsRemaining) : 0} анализов`,
  ];
  return lines.join('\n');
}

function procurementStatusText(x: ReturnType<typeof buildDecisionContext>): string {
  const score = x.readiness.score;
  if (score >= 85 && x.weight.canUseForCargo && !x.price.needsSkuConfirmation) return `🟢 Готовность к закупке: ${score}/100 · можно готовить тестовую партию после проверки образца`;
  if (score >= 70) return `🟡 Готовность к закупке: ${score}/100 · можно готовить образец, партию закупать рано`;
  if (score >= 40) return `🟡 Готовность к закупке: ${score}/100 · нужны данные поставщика`;
  return `🔴 Готовность к закупке: ${score}/100 · данных мало`;
}

function materialsLine(x: ReturnType<typeof buildDecisionContext>, product: any): string {
  const id = x.intelligence.productIdentity ?? {};
  const fromIntel = asArray<any>(id.materials ?? id.material)
    .map((m) => typeof m === 'string' ? m : m?.value)
    .map(normalizeFact)
    .filter(Boolean);
  const fromAttrs = collectRawAttributes(product, 12)
    .filter(f => /материал|材质|材料|пвх|pvc|eva|силикон|пластик|металл|ткан/i.test(`${f.name} ${f.value}`))
    .map(f => f.value);
  const values = uniq([...fromIntel, ...fromAttrs], 4);
  return values.length ? `${values.join(', ')} — подтвердить у поставщика` : 'уточнить у поставщика';
}

function useCasesLine(x: ReturnType<typeof buildDecisionContext>): string {
  const uses = asArray<string>(x.intelligence.productIdentity?.useCases).map(normalizeFact).filter(Boolean);
  if (uses.length) return uses.slice(0, 4).join(', ');
  const kind = String(x.intelligence.productIdentity?.productKind ?? x.title ?? '').toLowerCase();
  if (/бахил|чехл.*обув|shoe cover/.test(kind)) return 'защита обуви от дождя, грязи и брызг';
  if (/сабо|обув|сандал|тапоч|кроссов/.test(kind)) return 'повседневная носка, работа, прогулки';
  return '';
}

function buildCostSummaryLines(x: ReturnType<typeof buildDecisionContext>): string[] {
  if (!x.price.canCalculateCost || !x.price.calculationPriceYuan) return ['Себестоимость не рассчитана — нет цены товара.'];
  const lines: string[] = [];
  lines.push(`• Закупка: ${cny(x.price.calculationPriceYuan)}${x.cost.purchaseRub ? ` ≈ ${money(x.cost.purchaseRub)}` : ''}`);
  if (x.cost.costWithoutCargoRub) lines.push(`• Себестоимость без карго: ${money(x.cost.costWithoutCargoRub)}`);
  if (x.cost.cargoRub) lines.push(`• Карго: ${money(x.cost.cargoRub)}`);
  else lines.push('• Карго не рассчитано — нужен вес с упаковкой.');
  if (x.cost.totalCostRub) lines.push(`• Полная себестоимость: ${money(x.cost.totalCostRub)}`);
  if (x.cost.canShowRoi) lines.push(`• Сценарный ROI: ${x.cost.scenarioRoiPercent}% по вашей цене продажи.`);
  else lines.push('• ROI не считаю — рынок и продажная цена не заданы.');
  return lines;
}

function isSleepMask(product: any, x?: ReturnType<typeof buildDecisionContext>): boolean {
  const t = `${x?.title ?? ''} ${product?.titleRu ?? ''} ${product?.titleCn ?? ''} ${product?.categoryName ?? ''}`.toLowerCase();
  return /маск[аи]\s+для\s+сна|sleep\s*mask|眼罩|睡眠眼罩|遮光眼罩/.test(t);
}

export function build1688Detail(product: any): string {
  const x = buildDecisionContext(product);
  const facts = mergeFacts(collectRawAttributes(product, 24), collectIntelFacts(product, x.intelligence, 10)).slice(0, 20);
  const skuExamples = x.sku.skuVariantsNormalized.slice(0, 15).map(v => `• ${v.label}${v.priceYuan ? ` — ${cny(v.priceYuan)}` : ''}`);
  return [
    '📦 <b>Данные товара с 1688</b>',
    '',
    '<b>Название CN:</b>',
    html(cleanChineseTitle(product?.titleCn ?? product?.normalized1688?.titleCn ?? '') || '—'),
    '',
    '<b>Название RU:</b>',
    html(x.title),
    '',
    '<b>Цена:</b>',
    html(x.price.displayPriceText),
    '',
    '<b>SKU:</b>',
    html(x.sku.skuSummary),
    ...(skuExamples.length ? skuExamples.map(html) : ['• SKU не указаны']),
    '',
    '<b>Поставщик:</b>',
    `• название: ${html(product?.supplierName || 'не указано')}`,
    `• тип: ${html(product?.supplierType || 'не указан')}`,
    `• рейтинг: ${html(product?.supplierRating || '—')}`,
    `• заказов: ${html(product?.sold || '—')}`,
    `• MOQ: ${positive(product?.moq ?? product?.normalized1688?.moq) ? `${positive(product?.moq ?? product?.normalized1688?.moq)} шт.` : 'уточнить'}`,
    '',
    '<b>Ключевые характеристики:</b>',
    ...(facts.length ? facts.map(f => `• ${html(f.name)}: ${html(f.value)} — ${html(f.status)}`) : ['• требуется уточнить у поставщика']),
    '',
    '<b>Логистика:</b>',
    `• вес: ${html(x.weight.displayText.replace(/^Вес:\s*/i, ''))}`,
    `• фото: ${imagesCount(product) || '—'}`,
    `• остаток: ${html(product?.stock ?? product?.normalized1688?.stock ?? '—')}`,
  ].join('\n');
}

function seoFriendlyTitle(product: any, x: ReturnType<typeof buildDecisionContext>, content: any): string {
  const rawTitle = normalizeFact(content.title || content.wbTitle || x.intelligence.cleanTitles?.titleForWb || x.title);
  const text = `${rawTitle} ${product?.titleCn ?? ''}`.toLowerCase();
  if (/бахил|чехл.*обув|鞋套/.test(text)) return 'Бахилы многоразовые водонепроницаемые для обуви';
  if (isSleepMask(product, x)) return 'Маска для сна 3D с затемнением мягкая';
  if (/сабо|洞洞鞋|护士鞋/.test(text)) return 'Медицинские сабо EVA для работы и повседневной носки';
  if (/сандал|凉鞋/.test(text)) return 'Женские сандалии летние с декоративным элементом';
  return rawTitle || x.title;
}

function seoDescription(product: any, x: ReturnType<typeof buildDecisionContext>, title: string): string {
  const text = `${title} ${product?.titleCn ?? ''}`.toLowerCase();
  const material = materialsLine(x, product).replace(/\s+—\s+подтвердить у поставщика$/i, '');
  if (/бахил|чехл.*обув|鞋套/.test(text)) {
    return 'Высокие многоразовые бахилы помогают защитить обувь от дождя, грязи и брызг во время прогулок, поездок на велосипеде, походов и работы на улице. Модель надевается поверх обуви и подходит для использования в сырую погоду. Перед публикацией подтвердите материал, размерную сетку, вес и заявленные противоскользящие свойства на образце.';
  }
  if (isSleepMask(product, x)) {
    return 'Мягкая 3D-маска для сна помогает закрыть глаза от света дома, в дороге, самолёте, поезде или во время отдыха. Объёмная форма снижает давление на глаза и ресницы, а мягкий материал делает маску удобной для ежедневного использования. Перед публикацией подтвердите материал, размер, вес и качество резинки на образце.';
  }
  const uses = useCasesLine(x) || 'повседневного использования';
  const features = uniq([...(x.sku.componentOptions ?? []), ...asArray<string>(x.intelligence.productIdentity?.visibleFeatures)], 4).join(', ');
  return `${title} — товар для ${uses}. ${material && material !== 'уточнить у поставщика' ? `Материал: ${material}. ` : ''}${features ? `Ключевые детали: ${features}. ` : ''}Перед публикацией подтвердите выбранный SKU, материал, вес, упаковку и заявленные свойства на образце.`;
}

function seoBullets(product: any, x: ReturnType<typeof buildDecisionContext>): string[] {
  const titleText = `${x.title} ${product?.titleCn ?? ''}`.toLowerCase();
  if (/бахил|чехл.*обув|鞋套/.test(titleText)) {
    return [
      'Защита обуви от дождя, грязи и брызг',
      'Высокая посадка поверх обуви',
      'Подходит для прогулок, велосипеда, походов и работы на улице',
      'Многоразовый формат',
      'Заявленное антискольжение — проверить на образце',
    ];
  }
  if (isSleepMask(product, x)) {
    return [
      '3D-форма не давит на глаза',
      'Подходит для сна дома и в поездках',
      'Помогает закрыть глаза от света',
      'Несколько цветов и вариантов упаковки',
      'Мягкий материал — подтвердить на образце',
    ];
  }
  return uniq([
    ...(asArray<string>(x.intelligence.productIdentity?.visibleFeatures).map(cautiousClaim)),
    ...(x.sku.componentOptions ?? []),
    ...(useCasesLine(x) ? [`Для: ${useCasesLine(x)}`] : []),
    'Перед партией проверить качество образца',
  ], 5).slice(0, 5);
}

export function buildSeoDraft(product: any): string {
  const x = buildDecisionContext(product);
  const content = product?.seoContent ?? {};
  const title = seoFriendlyTitle(product, x, content);
  const description = seoDescription(product, x, title);
  const bullets = seoBullets(product, x);
  const facts = mergeFacts(collectRawAttributes(product, 24), collectIntelFacts(product, x.intelligence, 12))
    .filter(f => !/^(?:производитель|место производства|провинция|бренд)$/i.test(f.name))
    .filter(f => !/(Product Intelligence|AI-черновик|debug)/i.test(f.value + ' ' + f.status))
    .slice(0, 10);
  const colors = x.sku.colorOptions?.length ? x.sku.colorOptions.join(', ') : null;
  const sizes = x.sku.sizeOptions?.length ? x.sku.sizeOptions.join(', ') : null;
  const keywords = uniq([
    title.toLowerCase(),
    x.title.toLowerCase(),
    ...(asArray<string>(x.intelligence.wbSearch?.queryCandidates).slice(0, 8)),
    ...(colors ? colors.split(', ').map(c => `${x.title.toLowerCase()} ${c}`) : []),
  ], 18);
  return [
    '# Черновик карточки WB/Ozon',
    '',
    'Статус документа: черновик. Можно использовать после подтверждения веса, материала, размерной сетки и выбранного SKU.',
    '',
    '## Название',
    title,
    '',
    '## Описание',
    description,
    '',
    '## Буллеты для карточки',
    ...bullets.map((b, i) => `${i + 1}. ${b}`),
    '',
    '## Характеристики',
    '| Параметр | Значение | Статус |',
    '|---|---|---|',
    `| Тип | ${x.title} | из карточки |`,
    `| Материал | ${materialsLine(x, product).replace(/\|/g, '/')} | подтвердить |`,
    ...(colors ? [`| Цвета | ${colors} | из SKU |`] : []),
    ...(sizes ? [`| Размеры | ${sizes} | из SKU, уточнить сетку |`] : []),
    ...(x.sku.componentOptions?.length ? [`| Детали | ${x.sku.componentOptions.join(', ')} | из SKU/фото, проверить |`] : []),
    ...facts.slice(0, 5).map(f => `| ${f.name.replace(/\|/g, '/')} | ${f.value.replace(/\|/g, '/')} | ${f.status} |`),
    '',
    '## Ключевые слова',
    keywords.join(', '),
    '',
    '## Что уточнить перед публикацией',
    ...uniq([...x.readiness.missingData, 'материал', 'вес с упаковкой', 'реальные фото выбранного SKU'], 7).map(s => `- ${s}`),
    '',
    '## Нельзя писать как факт',
    ...(x.intelligence.claimsPolicy?.forbiddenAsFact?.length ? x.intelligence.claimsPolicy.forbiddenAsFact.slice(0, 8).map(s => `- ${s}`) : ['- 100% влагозащита без теста', '- сертификация без документов', '- лечебные/медицинские свойства без документов', '- прибыльность/ROI без расчёта']),
  ].join('\n');
}

export function buildSupplierQuestions(product: any, x = buildDecisionContext(product)): { ru: string[]; cn: string[] } {
  const ru: string[] = [];
  const cn: string[] = [];
  if (x.price.calculationPriceYuan) { ru.push(`Подтвердите цену выбранного SKU: ${cny(x.price.calculationPriceYuan)}.`); cn.push(`请确认所选SKU的价格是否为${cny(x.price.calculationPriceYuan).replace(' ¥', '元')}？`); }
  else { ru.push('Укажите цену выбранного цвета/размера/комплектации.'); cn.push('请告诉我所选颜色/尺码/套装的价格。'); }
  if (!x.weight.canUseForCargo) { ru.push('Укажите вес с упаковкой именно для выбранного SKU.'); cn.push('请提供所选SKU含包装的重量。'); }
  ru.push('Укажите габариты индивидуальной упаковки.'); cn.push('请提供单件产品包装尺寸。');
  if (x.sku.needsSelection) { ru.push('Подтвердите точную комплектацию выбранного SKU.'); cn.push('请确认所选SKU的准确套装内容。'); }
  ru.push('Подтвердите материал товара и упаковки.'); cn.push('请确认产品材质和包装材质。');
  ru.push('Пришлите реальные фото товара, выбранного SKU и упаковки.'); cn.push('请发送所选SKU、产品和包装的实拍照片。');
  ru.push('Можно ли заказать 1–2 образца перед партией?'); cn.push('批量采购前可以先购买1-2个样品吗？');
  const hasClaims = mergeFacts(collectIntelFacts(product, x.intelligence, 10), collectRawAttributes(product, 10)).some(f => /заявлен|сертифик|документ|испытан|антибактер|противоскольз|влагозащит|водонепрониц/i.test(f.value + ' ' + f.name));
  if (hasClaims) { ru.push('Какие заявленные свойства подтверждены документами или испытаниями, а какие являются только описанием поставщика?'); cn.push('页面里的功能描述哪些有检测报告或证书，哪些只是产品描述？'); }
  return { ru: uniq(ru, 12), cn: uniq(cn, 12) };
}

export function buildBuyerBrief(product: any, sourceUrl = ''): string {
  const x = buildDecisionContext(product);
  const qs = buildSupplierQuestions(product, x).ru;
  const skuExamples = x.sku.skuVariantsNormalized.slice(0, 8).map(v => v.label);
  const sampleChecks = categorySpecificSampleChecks(product, x);
  return [
    '# ТЗ байеру',
    '',
    'Статус документа: готово для отправки байеру после выбора SKU.',
    '',
    '## 1. Ссылка',
    sourceUrl || '—',
    '',
    '## 2. Что закупаем',
    `Название: ${x.title}`,
    `Цена: ${displayPriceSummary(x.price.displayPriceText)}`,
    `SKU: ${displaySkuSummary(x.sku.skuSummary)}`,
    ...(skuExamples.length ? ['Примеры SKU:', ...skuExamples.map(s => `- ${s}`)] : []),
    `Цвет: ${x.sku.colorOptions?.length ? x.sku.colorOptions.join(', ') : 'уточнить выбранный SKU'}`,
    `Размер: ${x.sku.sizeOptions?.length ? x.sku.sizeOptions.join(', ') : 'если применимо — уточнить'}`,
    `Комплектация: ${x.sku.componentOptions?.length ? x.sku.componentOptions.join(', ') : (x.sku.isMultiPack ? 'зависит от комплектации' : 'уточнить')}`,
    `MOQ: ${positive(product?.moq ?? product?.normalized1688?.moq) ? `${positive(product?.moq ?? product?.normalized1688?.moq)} шт.` : 'уточнить'}`,
    '',
    '## 3. Поставщик',
    `Название: ${normalizeFact(product?.supplierName) || 'не указано'}`,
    `Тип: ${normalizeFact(product?.supplierType) || 'не указан'}`,
    `Рейтинг: ${normalizeFact(product?.supplierRating) || '—'}`,
    `Заказы: ${normalizeFact(product?.sold) || '—'}`,
    '',
    '## 4. Что подтвердить у поставщика',
    ...qs.map(q => `- ${q}`),
    '',
    '## 5. Что проверить на образце',
    ...sampleChecks.map(q => `- ${q}`),
    '',
    '## 6. Фото, которые нужно запросить',
    '- общий вид выбранного SKU',
    '- крупно материал и детали',
    '- упаковка и маркировка',
    '- фото SKU рядом с линейкой/размерной сеткой, если применимо',
    '',
    '## 7. Риски',
    ...uniq([...x.readiness.risks, ...x.sku.skuRisks], 8).map(r => `- ${r}`),
    '',
    '## 8. Решение',
    x.readiness.canRecommendSample ? 'Можно запрашивать данные для образца. Партию не закупать до проверки веса, упаковки и образца.' : 'Пока не готово к закупке: закрыть недостающие данные поставщика.',
  ].join('\n');
}

export function buildCargoBrief(product: any, sourceUrl = ''): string {
  const x = buildDecisionContext(product);
  const category = x.categoryType;
  const extra = isSleepMask(product, x)
    ? ['- тип упаковки: OPP-пакет или цветная коробка', '- вес и габариты упаковки выбранного SKU', '- материал маски и ремешка']
    : category === 'electronics'
    ? ['- есть ли батарейка / аккумулятор / магнит', '- мощность и тип зарядки, если товар электрический', '- инструкция и документы']
    : category === 'beauty'
      ? ['- состав, срок годности, документы', '- герметичность упаковки']
      : category === 'shoes'
        ? ['- вес одной пары с коробкой', '- габариты коробки одной пары', '- количество пар в транспортной коробке']
        : ['- есть ли батарейка / жидкость / порошок / магнит / стекло'];
  return [
    '# ТЗ для карго',
    '',
    'Статус документа: готово для запроса расчёта, но точное карго возможно только после веса и габаритов.',
    '',
    '## Товар',
    x.title,
    sourceUrl ? `Ссылка: ${sourceUrl}` : '',
    '',
    '## Что нужно запросить',
    '- вес одной единицы с упаковкой',
    '- габариты индивидуальной упаковки',
    '- количество в транспортной коробке',
    '- вес транспортной коробки',
    '- габариты транспортной коробки',
    '- фото индивидуальной упаковки',
    '- фото транспортной коробки',
    '- материал товара',
    '- код ТН ВЭД, если поставщик знает',
    ...extra,
    '',
    '## Текущий статус',
    `Вес: ${x.weight.displayText.replace(/^Вес:\s*/i, '')}`,
    `Габариты: уточнить`,
    `SKU: ${displaySkuSummary(x.sku.skuSummary)}`,
    '',
    '## Важно',
    'Карго не рассчитывается точно без веса и габаритов выбранного SKU.',
  ].filter(Boolean).join('\n');
}

function categorySpecificSampleChecks(product: any, x: ReturnType<typeof buildDecisionContext>): string[] {
  const text = `${x.title} ${product?.titleCn ?? ''}`.toLowerCase();
  if (isSleepMask(product, x)) return [
    'материал и мягкость после распаковки',
    'форма 3D-углублений и место для глаз/ресниц',
    'не давит ли маска на глаза',
    'насколько хорошо закрывает свет',
    'качество резинки/ремешка и регулировки',
    'запах после распаковки',
    'качество швов и краёв',
    'комфорт при носке 10–15 минут',
    'упаковка OPP/коробка',
    'вес и габариты упаковки',
  ];
  if (/бахил|чехл.*обув|鞋套/.test(text)) return [
    'соответствие цвета/размера выбранному SKU',
    'удобство надевания поверх обуви',
    'качество молнии',
    'качество манжеты/утяжки',
    'материал и запах после распаковки',
    'вес с упаковкой',
    'габариты упаковки',
    'как сидит на обуви',
    'не рвётся ли при натяжении',
    'антискольжение проверить самостоятельно, не писать как факт без теста',
  ];
  const checks = CATEGORY_BUYER_CHECKS[x.categoryType] ?? CATEGORY_BUYER_CHECKS.other;
  return checks.slice(0, 10);
}

export function buildInfographicBrief(product: any): string {
  const x = buildDecisionContext(product);
  const title = x.title;
  const text = `${title} ${product?.titleCn ?? ''}`.toLowerCase();
  const isShoeCovers = /бахил|чехл[ыа]? для обув|鞋套/i.test(text);
  const isMask = isSleepMask(product, x);
  const slides = isShoeCovers
    ? [
        { h: 'главный', copy: 'Многоразовые бахилы для защиты обуви', show: 'общий вид бахил на обуви' },
        { h: 'сценарии применения', copy: 'Для дождя, грязи, походов и велосипеда', show: 'иконки: дождь / грязь / велосипед / лес / работа на улице' },
        { h: 'конструкция', copy: 'Высокая посадка поверх обуви', show: 'как бахила закрывает обувь и часть ноги' },
        { h: 'фиксация', copy: x.sku.componentOptions?.length ? `Молния и фиксация сверху: ${x.sku.componentOptions.join(', ')}` : 'Фиксацию подтвердить по фото выбранного SKU', show: 'крупно молнию, манжету или шнурок' },
        { h: 'размеры/SKU', copy: 'Выберите цвет и размер', show: `цвета/размеры: ${displaySkuSummary(x.sku.skuSummary)}` },
      ]
    : isMask
      ? [
          { h: 'главный', copy: 'Мягкая 3D-маска для сна', show: 'маска на лице или рядом с подушкой, чистый спокойный фон' },
          { h: 'сценарии применения', copy: 'Для дома, поездок, самолёта и дневного отдыха', show: 'иконки: дом / поезд / самолёт / отдых' },
          { h: '3D-форма', copy: 'Не давит на глаза и ресницы', show: 'крупно углубления для глаз, боковой разрез' },
          { h: 'затемнение', copy: 'Помогает закрыть глаза от света', show: 'сравнение свет/темнота, без обещания 100% затемнения' },
          { h: 'цвета и упаковка', copy: 'Выберите цвет и вариант упаковки', show: displaySkuSummary(x.sku.skuSummary) },
        ]
    : [
        { h: 'главный', copy: title, show: 'товар крупно на чистом фоне + главный сценарий применения' },
        { h: 'сценарии применения', copy: useCasesLine(x) || 'Сценарии применения товара', show: '3–4 иконки или фото, где используют товар' },
        { h: 'конструкция', copy: x.sku.componentOptions?.length ? x.sku.componentOptions.join(', ') : 'Материал и детали — проверить на образце', show: 'крупные детали материала, креплений, подошвы/дна/корпуса' },
        { h: 'размеры/SKU', copy: 'Выберите нужный цвет, размер и комплектацию', show: displaySkuSummary(x.sku.skuSummary) },
        { h: 'упаковка/комплектация', copy: 'Перед партией подтвердите вес, упаковку и фото выбранного SKU', show: 'упаковка, комплектация, вес и габариты' },
      ];
  return [
    '# ТЗ для инфографики',
    '',
    'Статус документа: черновик для дизайнера. Использовать после подтверждения фото выбранного SKU.',
    '',
    '## Цель карточки',
    'Показать товар, сценарии применения и ключевые преимущества без неподтверждённых claims.',
    '',
    ...slides.flatMap((s, i) => [`## Слайд ${i + 1} — ${s.h}`, `Текст: ${cautiousClaim(s.copy)}`, `Что показать: ${s.show}`, '']),
    '## Что нельзя писать',
    '- 100% водонепроницаемые без теста',
    '- противоскользящие как факт без проверки',
    '- сертифицированные без документов',
    '- прибыльность/ROI без ручного расчёта',
  ].join('\n');
}

export function buildRiskChecklist(product: any): string {
  const x = buildDecisionContext(product);
  const sampleChecks = categorySpecificSampleChecks(product, x);
  return [
    '# Риск-чеклист товара',
    '',
    'Статус документа: рабочий чек-лист для закупки. Красные флаги обязательны к проверке до партии.',
    '',
    '## Главные риски',
    ...(x.readiness.risks.length ? x.readiness.risks.map(r => `- ${r}`) : ['- рынок и конкуренты не проверены вручную']),
    '',
    '## Что проверить до образца',
    ...uniq([...x.readiness.missingData, 'цена выбранного SKU', 'вес и габариты упаковки', 'реальные фото товара и упаковки'], 10).map(m => `- ${m}`),
    '',
    '## Что проверить на образце',
    ...sampleChecks.map(r => `- ${r}`),
    '',
    '## Что проверить перед партией',
    '- ручную проверку 3–5 конкурентов WB/Ozon',
    '- финальную себестоимость с карго',
    '- упаковку для маркетплейса',
    '- возвраты/размерную сетку/комплектацию',
    '- документы/маркировку для регулируемых claims',
    '',
    '## Красные флаги',
    '- поставщик не подтверждает вес',
    '- поставщик не даёт реальные фото',
    '- SKU на фото отличается от выбранного',
    '- цена меняется после уточнения',
    '- материал не подтверждается',
    '- заявленные свойства без тестов/документов',
    '- упаковка не подходит для маркетплейса',
    '',
    '## Решение',
    x.readiness.canRecommendSample ? 'Можно переходить к образцу после подтверждения SKU, веса и упаковки. Партию не закупать.' : 'Пока не готово к закупке: закрыть недостающие данные.',
  ].join('\n');
}

export function buildSampleRecommendation(product: any): string {
  const x = buildDecisionContext(product);
  const sku = x.sku.recommendedSampleSku || 'базовый/самый массовый SKU';
  const checks = categorySpecificSampleChecks(product, x);
  return [
    '# Рекомендация по образцу',
    '',
    'Статус документа: план проверки образца. Использовать перед заказом 1–2 единиц.',
    '',
    '## Лучше взять',
    `- SKU: ${sku}`,
    '- Количество: 1–2 единицы, не партия',
    '- Почему этот SKU: проверить качество, вес, упаковку и соответствие карточке с минимальным риском',
    '',
    '## Что проверить',
    ...checks.map(c => `- ${c}`),
    '',
    '## Что измерить',
    '- вес с упаковкой',
    '- габариты индивидуальной упаковки',
    '- фактические размеры товара',
    '- размер/посадку, если применимо',
    '',
    '## Какие фото сделать',
    '- общий вид товара',
    '- крупно материал и детали',
    '- упаковка и маркировка',
    '- SKU рядом с линейкой/размерной сеткой',
    '',
    '## Решение после образца',
    '- брать в тестовую партию',
    '- доработать SKU/упаковку/контент',
    '- не брать, если качество/вес/материал не подтверждены',
  ].join('\n');
}

export function buildSafeSummary(product: any, reason?: string): string {
  const x = buildDecisionContext(product);
  return ['⚠️ <b>Анализ требует уточнения</b>', '', `Товар: ${html(x.title)}`, `Статус: ${html(procurementStatusText(x))}`, '', `Главный риск: ${html(reason || x.readiness.blockers[0] || x.readiness.risks[0] || 'данные недостаточно подтверждены')}`, 'Следующий шаг: отправьте вопросы поставщику или внесите ответ поставщика — пересчитаю закупочный статус.', '', 'Не делать: не закупать партию, пока не подтверждены SKU, вес, упаковка и образец.', '', 'Кредит не списан.'].join('\n');
}

export function validateGeneratedText(input: { productIntelligence?: ProductIntelligenceLike; generatedText: string; reportType: 'main' | 'detail1688' | 'seo' | 'buyerBrief' | 'supplierQuestions'; categoryType?: string; marketDecision?: MarketDecision; weightDecision?: WeightDecision }): { ok: boolean; errors: string[]; fixedText: string } {
  const errors: string[] = [];
  let fixed = String(input.generatedText ?? '');
  const before = fixed;
  if (/\b(?:undefined|null|NaN|Infinity|-Infinity)\b/i.test(fixed)) errors.push('technical garbage');
  if (/0(?:[,.]0+)?\s*[¥￥₽]/i.test(fixed)) errors.push('zero price');
  if (/0(?:[,.]0+)?\s*(?:кг|kg)\b/i.test(fixed)) errors.push('zero weight');
  if (/Product Intelligence|AI-черновик|debug/i.test(fixed)) errors.push('internal labels');
  fixed = fixed
    .replace(/\b(?:undefined|null|NaN|Infinity|-Infinity)\b/gi, '—')
    .replace(/0(?:[,.]0+)?\s*[¥￥]/gi, 'цена уточняется')
    .replace(/0(?:[,.]0+)?\s*₽/gi, 'цена уточняется')
    .replace(/0(?:[,.]0+)?\s*(?:кг|kg)\b/gi, 'вес уточняется')
    .replace(/Product Intelligence|AI-черновик/gi, 'по данным карточки')
    .replace(/""/g, '—')
    .replace(/(^|\n)\s*(?:цвет|color)\s*[:—-]\s*(заявлен[^\n]*|противоскольз[^\n]*|антибактер[^\n]*|влагозащит[^\n]*)/gi, '$1Особенность: $2');
  if (input.reportType !== 'detail1688' && /[一-鿿]/.test(fixed)) {
    errors.push('raw chinese normalized');
    fixed = fixed.split('\n').map(line => normalizeMixedProductText(line)).filter(Boolean).join('\n');
  }
  if (/\bROI\b[^\n]*(?:\d|%)/i.test(fixed) && !/сценар|введ[её]нн|по\s+вашей\s+цене|manual/i.test(fixed)) {
    errors.push('roi without manual scenario');
    fixed = fixed.split('\n').filter(line => !/\bROI\b[^\n]*(?:\d|%)/i.test(line)).join('\n');
  }
  const category = String(input.categoryType ?? '').toLowerCase();
  if (/shoes|обув/.test(category)) fixed = fixed.replace(/\b(?:мощность|напряжение|аккумулятор|тип вилки|рукав|усадка после стирки)\b[^\n]*/gi, '').replace(/\n{3,}/g, '\n\n');
  if (/passive_insect_trap|ловуш/.test(category)) fixed = fixed.replace(/\b(?:мощность|напряжение|тип вилки|аккумулятор|тип лампы|электрическая)\b[^\n]*/gi, '').replace(/\n{3,}/g, '\n\n');
  if (/маск[аи]\s+для\s+сна|sleep\s*mask|3d-маск/i.test(fixed)) {
    fixed = fixed
      .replace(/\b(?:срок годности|консистенция образца|подошв[аы]|дно|корпус|герметичность упаковки как обязательное|размерная сетка)\b[^\n]*/gi, '')
      .replace(/товар\s+для\s+для/gi, 'товар для')
      .replace(/\n{3,}/g, '\n\n');
  }
  fixed = fixed.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return { ok: errors.length === 0 || fixed !== before, errors, fixedText: fixed };
}

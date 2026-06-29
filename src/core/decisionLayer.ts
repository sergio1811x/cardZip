import type { RawProduct1688 } from '../types';
import { cleanChineseTitle, normalizeSkuText, normalizeMixedProductText, detectPackCount, extractShoeSize } from './cnNormalize';

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
  skuVariantsNormalized: Array<{ raw: string; label: string; priceYuan: number | null; packCount?: number; size?: string; color?: string }>;
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

export function buildSkuDecision(product: RawProduct1688 | any, intelligence?: ProductIntelligenceLike): SkuDecision {
  const variantsRaw = collectSku(product);
  const variants = variantsRaw.map((s, i) => {
    const raw = String(s?.name ?? s?.label ?? s?.skuName ?? `SKU ${i + 1}`);
    const label = normalizeSkuText(raw) || normalizeFact(raw) || `SKU ${i + 1}`;
    return { raw, label, priceYuan: skuPrice(s), packCount: detectPackCount(raw), size: extractShoeSize(raw) };
  }).filter(v => v.raw || v.label);
  const prices = variants.map(v => v.priceYuan).filter((p): p is number => !!p);
  const rawText = variants.map(v => `${v.raw} ${v.label}`).join(' ');
  const dims: string[] = [];
  if (/цвет|color|白|黑|红|蓝|绿|黄|粉|хаки|бел|черн|чёрн|розов/i.test(rawText)) dims.push('color');
  if (/размер|size|码|\b3[5-9]\b|\b4[0-9]\b/i.test(rawText) || categoryType(product, intelligence) === 'shoes') dims.push('size');
  if (/модель|version|款|型号|经典|普通|高版本/i.test(rawText)) dims.push('model');
  const isMultiPack = variants.some(v => !!v.packCount);
  if (isMultiPack) dims.push('packCount');
  const sizes = uniq(variants.map(v => v.size || '').filter(Boolean), 50).map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
  const parts = variants.length ? [`SKU: ${variants.length} вариантов`] : ['SKU: не указаны'];
  if (dims.length) parts.push(dims.map(d => ({ color: 'цвета', size: 'размеры', model: 'модели', packCount: 'количество штук' } as any)[d] ?? d).join(' × '));
  if (sizes.length) parts.push(`размеры ${sizes[0]}–${sizes[sizes.length - 1]}`);
  if (/маломер|偏小一码/.test(rawText)) parts.push('маломерит на 1 размер');
  if (prices.length) parts.push(`цена по SKU ${rangeText(Math.min(...prices), Math.max(...prices))}`);
  if (variants.length > 15) parts.push('показаны первые 15');
  const safeVariants = variants.slice(0, 15);
  const rec = safeVariants.find(v => /бел|черн|чёрн|хаки|40|39|38/.test(v.label))?.label ?? safeVariants[0]?.label;
  const skuRisks = uniq([
    ...(variants.length > 1 ? ['нужно выбрать конкретный SKU перед расчётом'] : []),
    ...(isMultiPack ? ['цена и вес зависят от комплектации'] : []),
    ...(/маломер|偏小一码/.test(rawText) ? ['поставщик указывает риск маломерности'] : []),
  ], 8);
  return { skuDimensions: dims, skuSummary: parts.join(' · '), skuCount: variants.length, shownSkuCount: safeVariants.length, skuVariantsNormalized: safeVariants, isMultiPack, needsSelection: variants.length > 1, priceText: prices.length ? `Цена по SKU: ${rangeText(Math.min(...prices), Math.max(...prices))}` : undefined, recommendedSampleSku: rec, skuRisks };
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
  return { displayPriceText: 'Цена: нужно уточнить', calculationPriceYuan: null, minPriceYuan: null, maxPriceYuan: null, priceSource: 'missing', isEstimated: false, isSkuDependent: sku.needsSelection, isPackDependent: sku.isMultiPack, canCalculateCost: false, canCalculateRoi: false, needsSkuConfirmation: sku.needsSelection, reason: 'Нет положительной цены в direct/promotion/SKU/priceRange.' };
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
  if (!price.canCalculateCost || !price.calculationPriceYuan) return { status: 'not_calculated_no_price', canShowPurchaseRub: false, canShowCostWithoutCargo: false, canShowCargo: false, canShowRoi: false, purchaseRub: null, costWithoutCargoRub: null, cargoRub: null, totalCostRub: null, manualSalePriceRub: input.manualSalePriceRub ?? null, scenarioProfitRub: null, scenarioRoiPercent: null, breakEvenPriceRub: null, warnings: ['Экономика не рассчитана — нет цены товара.'], nextAction: 'Уточнить цену выбранного SKU у поставщика.' };
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

function collectRawAttributes(product: any, limit = 24): Array<{ name: string; value: string; status: string }> {
  const attrs = asArray<any>(product?.normalized1688?.attributes ?? product?.attributes ?? product?.raw1688?.attributesRaw);
  const out: Array<{ name: string; value: string; status: string }> = [];
  for (const a of attrs) { const name = normalizeFact(a?.name ?? a?.key ?? a?.attrName); const value = cautiousClaim(a?.value ?? a?.val ?? a?.attrValue); if (!name || !value || /^(id|url|debug|raw)$/i.test(name)) continue; out.push({ name, value, status: /заявлен|подтверд|проверить|уточнить/i.test(value) ? 'заявлено поставщиком' : 'из 1688' }); if (out.length >= limit) break; }
  return out;
}
function collectIntelFacts(product: any, intel = getIntel(product), limit = 20): Array<{ name: string; value: string; status: string }> {
  const id = getIdentity(product, intel); const facts = asRecord((intel as any).facts ?? product?.productContext?.facts);
  const pairs: Array<[string, unknown]> = [['Тип', id.productKind || id.coreObject || titleForReport(product, intel)], ['Форм-фактор', id.formFactor], ['Аудитория', id.audience], ['Пол', id.gender], ['Сезон', id.season], ['Материалы', asArray(id.materials ?? id.material).map((m:any)=> typeof m === 'string' ? m : m?.value).join(', ')], ['Сценарии использования', asArray(id.useCases).join(', ')], ['Видимые особенности', asArray(id.visibleFeatures).join(', ')], ['Важные особенности', asArray(id.importantFeatures).map((v:any)=> typeof v === 'string' ? v : v?.value).join(', ')], ...Object.entries(facts)];
  const out: Array<{ name: string; value: string; status: string }> = []; for (const [n, v] of pairs) { const name = normalizeFact(n); const value = cautiousClaim(v); if (!name || !value || value === '—') continue; out.push({ name, value, status: /заявлен|подтверд|проверить|уточнить/i.test(value) ? 'заявлено/уточнить' : 'Product Intelligence' }); if (out.length >= limit) break; } return out;
}
function mergeFacts(...groups: Array<Array<{ name: string; value: string; status?: string }>>): Array<{ name: string; value: string; status: string }> { const seen = new Set<string>(); const out: Array<{ name: string; value: string; status: string }> = []; for (const g of groups) for (const f of g) { const name = normalizeFact(f.name); const value = cautiousClaim(f.value); const key = `${name.toLowerCase()}:${value.toLowerCase()}`; if (!name || !value || seen.has(key)) continue; seen.add(key); out.push({ name, value, status: f.status ?? 'уточнить' }); } return out; }

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
  const x = buildDecisionContext(product); const source = String(product?.platform ?? '1688').toUpperCase(); const moq = positive(product?.normalized1688?.moq ?? product?.moq); const sold = positive(product?.normalized1688?.salesCount ?? product?.sold); const facts = mergeFacts(collectIntelFacts(product, x.intelligence, 8), collectRawAttributes(product, 10)).slice(0, 6);
  const costLines = x.cost.status === 'not_calculated_no_price' ? ['Экономика не рассчитана — нет цены товара.'] : [ ...(x.cost.purchaseRub ? [`• Закупка: ${cny(x.price.calculationPriceYuan)} ≈ ${money(x.cost.purchaseRub)}`] : []), ...(x.cost.costWithoutCargoRub ? [`• Себестоимость без карго: ${money(x.cost.costWithoutCargoRub)}`] : []), ...(x.cost.cargoRub ? [`• Карго: ${money(x.cost.cargoRub)}`] : ['• Карго не рассчитано — нужен вес с упаковкой.']), ...(x.cost.canShowRoi ? [`• Сценарная прибыль до рекламы: ${money(x.cost.scenarioProfitRub)}`, `• Сценарный ROI: ${x.cost.scenarioRoiPercent}%`, 'Это сценарий по цене, введённой пользователем, не подтверждённая рыночная цена.'] : ['• ROI не считаю — продажная цена/рынок не заданы.']) ];
  const lines = [`📦 <b>${html(x.title)}</b>`, '', `Источник: ${html(source)}`, `Поставщик: ${html(product?.supplierType || product?.normalized1688?.supplierType || 'не указан')}`, '', '📌 <b>Данные 1688</b>', `• Цена: ${html(x.price.displayPriceText)}`, `• MOQ: ${moq ? `${Math.round(moq).toLocaleString('ru-RU')} шт.` : 'уточняется'}`, `• SKU: ${html(x.sku.skuSummary)}`, `• Фото: ${imagesCount(product) || '—'} шт`, `• Вес: ${html(x.weight.displayText.replace(/^Вес:\s*/i, ''))}`, `• Продано/заказов: ${sold ? Math.round(sold).toLocaleString('ru-RU') : '—'}`, '', `<b>${html(x.readiness.label)}</b>`, `Готовность к проверке: ${x.readiness.score}/100`, '', '✅ <b>Что уже понятно</b>', ...(x.readiness.positiveSignals.length ? x.readiness.positiveSignals.map(s => `• ${html(s)}`) : ['• товар распознан и готов к первичной проверке']), ...(facts.length ? ['', '🧾 <b>Важные свойства из карточки</b>', ...facts.map(f => `• ${html(f.name)}: ${html(f.value)} (${html(f.status)})`)] : []), '', '⚠️ <b>Что мешает закупке</b>', ...(x.readiness.blockers.length || x.readiness.risks.length ? [...x.readiness.blockers, ...x.readiness.risks].slice(0, 7).map(s => `• ${html(s)}`) : ['• нужно вручную проверить рынок/конкурентов перед партией']), '', '💰 <b>Экономика</b>', ...costLines.map(html), ...(x.cost.warnings.length ? ['', ...x.cost.warnings.map(w => `⚠️ ${html(w)}`)] : []), '', '📌 <b>Что уточнить у поставщика</b>', ...topQuestions(product, x).map(q => `• ${html(q)}`), '', '📄 <b>Что уже подготовлено</b>', '• SEO-черновик WB/Ozon', '• ТЗ байеру', '• ТЗ карго', '• ТЗ для инфографики', '• Риск-чеклист', '• Рекомендация по образцу', '', '🎯 <b>Вердикт</b>', html(x.readiness.canRecommendSample ? 'Партию закупать рано. Можно готовить карточку и запросить данные для образца.' : 'Закупать рано. Сначала закрыть недостающие данные у поставщика.'), '', 'Что сделать:', ...x.readiness.nextActions.slice(0, 3).map((a, i) => `${i + 1}. ${html(a)}`) ]; if (typeof statusInfo?.creditsRemaining === 'number') lines.push('', `📦 Осталось: ${statusInfo.creditsRemaining} анализов`); return lines.join('\n').replace(/\n{3,}/g, '\n\n'); }

export function build1688Detail(product: any): string { const x = buildDecisionContext(product); const facts = mergeFacts(collectIntelFacts(product, x.intelligence, 12), collectRawAttributes(product, 16)).slice(0, 14); const skuExamples = x.sku.skuVariantsNormalized.slice(0, 12).map(v => `• ${normalizeSkuText(v.raw || v.label) || v.label}${v.priceYuan ? ` — ${cny(v.priceYuan)}` : ''}`); return ['📦 Данные товара с 1688', '', 'Название CN:', cleanChineseTitle(product?.titleCn ?? product?.normalized1688?.titleCn ?? '') || '—', '', 'Название RU:', x.title, '', 'Цена:', x.price.displayPriceText, '', 'SKU:', x.sku.skuSummary, ...(skuExamples.length ? skuExamples : ['• варианты SKU не распознаны']), '', 'Поставщик:', `• название: ${normalizeFact(product?.supplierName) || 'не указано'}`, `• тип: ${normalizeFact(product?.supplierType) || 'не указан'}`, `• рейтинг: ${normalizeFact(product?.supplierRating) || '—'}`, `• заказов: ${normalizeFact(product?.sold) || '—'}`, `• MOQ: ${positive(product?.moq) ? `${positive(product?.moq)} шт.` : 'уточняется'}`, '', 'Ключевые характеристики:', ...(facts.length ? facts.map(f => `• ${f.name}: ${f.value} (${f.status})`) : ['• характеристики нужно уточнить у поставщика']), '', 'Логистика:', `• вес: ${x.weight.displayText.replace(/^Вес:\s*/i, '')}`, `• фото: ${imagesCount(product) || '—'}`, `• остаток: ${normalizeFact(product?.stock) || '—'}`].join('\n'); }

export function buildSeoDraft(product: any): string { const x = buildDecisionContext(product); const content = product?.seoContent ?? {}; const facts = mergeFacts(collectIntelFacts(product, x.intelligence, 16), collectRawAttributes(product, 24)); const title = normalizeFact(content.titleRu || x.intelligence.cleanTitles?.titleForWb || x.title); const desc = normalizeFact(content.description) || `${x.title}. Черновик карточки собран по данным 1688. Перед публикацией подтвердите выбранный SKU, вес с упаковкой, реальные фото и документы для заявленных свойств.`; const bullets = uniq([...asArray<string>(content.bullets).map(cautiousClaim), ...asArray<string>(x.intelligence.productIdentity?.useCases).map(v => `Подходит для: ${v}`), ...asArray<string>(x.intelligence.productIdentity?.visibleFeatures).map(v => `Особенность: ${v}`), x.sku.skuSummary, 'Перед публикацией подтвердите вес, упаковку и свойства выбранного SKU'], 5); while (bullets.length < 5) bullets.push(['Уточните характеристики выбранного SKU', 'Запросите реальные фото', 'Проверьте комплектацию', 'Подготовьте размерную сетку/габариты', 'Не используйте claims без подтверждения'][bullets.length]); const chars = mergeFacts(Object.entries(asRecord(content.characteristics)).map(([name, value]) => ({ name, value: cautiousClaim(value), status: 'AI-черновик' })), facts).slice(0, 18); const keywords = uniq([...(asArray<string>(content.keywords)), title, ...(x.intelligence.wbSearch?.queryCandidates ?? [])], 14); const clarify = uniq([...(x.readiness.missingData ?? []), ...x.cost.warnings, ...(x.price.needsSkuConfirmation ? ['выбранный SKU и цена'] : []), ...(x.weight.canUseForCargo ? [] : ['вес с упаковкой выбранного SKU'])].map(cautiousClaim), 12); const forbidden = uniq([...(x.intelligence.claimsPolicy?.forbiddenAsFact ?? []), ...(x.intelligence.reportRules?.seoForbiddenClaims ?? []), 'лечебный эффект', 'сертификация без документов', 'безопасность для детей без документов', 'оригинальный бренд без подтверждения'].map(cautiousClaim), 12); return ['# CardZip — Черновик WB/Ozon-карточки', '', '## Название', title, '', '## Описание', desc, '', '## Буллеты для инфографики', ...bullets.map((b, i) => `${i + 1}. ${b}`), '', '## Характеристики', '| Параметр | Значение | Статус |', '|---|---|---|', ...chars.map(f => `| ${f.name} | ${f.value} | ${f.status} |`), '', '## Ключевые слова', keywords.join(', ') || title, '', '## Что использовать осторожно', ...facts.filter(f => /заявлен|подтверд|проверить|уточнить/i.test(f.value)).slice(0, 8).map(f => `- ${f.name}: ${f.value}`), '', '## Требует уточнения', ...(clarify.length ? clarify.map(q => `- ${q}`) : ['- выбранный SKU, упаковка и вес']), '', '## Нельзя писать как факт', ...forbidden.map(q => `- ${q}`), ''].join('\n'); }

export function buildSupplierQuestions(product: any, x = buildDecisionContext(product)): { ru: string[]; cn: string[] } { const ru: string[] = []; const cn: string[] = []; if (x.price.calculationPriceYuan) { ru.push(`Подтвердите цену выбранного SKU: ${cny(x.price.calculationPriceYuan)}.`); cn.push(`请确认所选SKU的价格是否为${cny(x.price.calculationPriceYuan).replace(' ¥', '元')}？`); } else { ru.push('Укажите цену выбранного цвета/размера/комплектации.'); cn.push('请告诉我所选颜色/尺码/套装的价格。'); } if (!x.weight.canUseForCargo) { ru.push('Укажите вес с упаковкой именно для выбранного SKU.'); cn.push('请提供所选SKU含包装的重量。'); } ru.push('Укажите габариты индивидуальной упаковки.'); cn.push('请提供单件产品包装尺寸。'); if (x.sku.needsSelection) { ru.push('Подтвердите точную комплектацию выбранного SKU.'); cn.push('请确认所选SKU的准确套装内容。'); } const facts = mergeFacts(collectIntelFacts(product, x.intelligence, 10), collectRawAttributes(product, 10)); if (facts.some(f => /заявлен|сертифик|документ|испытан|антибактер|противоскольз/i.test(f.value + ' ' + f.name))) { ru.push('Какие свойства из карточки подтверждены документами или испытаниями, а какие являются только описанием поставщика?'); cn.push('页面里的功能描述哪些有检测报告或证书，哪些只是产品描述？'); }
  ru.push('Пришлите реальные фото товара и упаковки выбранного SKU.'); cn.push('请发送所选SKU产品和包装的实拍照片。'); ru.push('Можно ли заказать образец 1–2 шт. перед партией?'); cn.push('批量采购前是否可以先购买1-2个样品？'); const checks = [...(x.intelligence.supplierQuestions?.ru ?? []), ...(x.intelligence.reportRules?.buyerMustCheck ?? []), ...(CATEGORY_BUYER_CHECKS[x.categoryType] ?? CATEGORY_BUYER_CHECKS.other)]; const forbidden = [...(x.intelligence.reportRules?.buyerMustNotAsk ?? []), ...(CATEGORY_MUST_NOT_ASK[x.categoryType] ?? [])].map(s => s.toLowerCase()); const cleanRu = uniq([...ru, ...checks].map(stripNumber), 12).filter(q => !forbidden.some(f => q.toLowerCase().includes(f))); return { ru: cleanRu, cn: uniq([...cn, ...(x.intelligence.supplierQuestions?.cn ?? [])].map(stripNumber), 12) }; }

export function buildBuyerBrief(product: any, sourceUrl = ''): string { const x = buildDecisionContext(product); const facts = mergeFacts(collectIntelFacts(product, x.intelligence, 12), collectRawAttributes(product, 16)).slice(0, 10); const qs = buildSupplierQuestions(product, x).ru; const skuExamples = x.sku.skuVariantsNormalized.slice(0, 8).map(v => normalizeSkuText(v.raw || v.label) || v.label); return ['# ТЗ для байера / карго', '', '## Ссылка', sourceUrl || '—', '', '## Товар', `Название RU: ${x.title}`, `Название CN clean: ${cleanChineseTitle(product?.titleCn ?? product?.normalized1688?.titleCn ?? '') || '—'}`, `Источник: ${String(product?.platform ?? '1688').toUpperCase()}`, '', '## Что закупаем', `Цена: ${x.price.displayPriceText}`, `SKU: ${x.sku.skuSummary}`, ...(skuExamples.length ? ['Примеры SKU:', ...skuExamples.map(s => `- ${s}`)] : []), `Цвет: ${x.sku.skuDimensions.includes('color') ? 'выбрать конкретный цвет SKU' : 'если есть — уточнить'}`, `Размер: ${x.sku.skuDimensions.includes('size') ? 'выбрать конкретный размер SKU' : 'если применимо — уточнить'}`, `Комплектация: ${x.sku.isMultiPack ? 'зависит от SKU/количества штук' : 'уточнить'}`, `MOQ: ${positive(product?.moq) ? `${positive(product?.moq)} шт.` : 'уточнить'}`, '', '## Поставщик', `Название: ${normalizeFact(product?.supplierName) || 'не указано'}`, `Тип: ${normalizeFact(product?.supplierType) || 'не указан'}`, `Рейтинг: ${normalizeFact(product?.supplierRating) || '—'}`, `Заказы: ${normalizeFact(product?.sold) || '—'}`, '', '## Подтверждённые/заявленные данные из карточки', ...(facts.length ? facts.map(f => `- ${f.name}: ${f.value} (${f.status})`) : ['- данных мало — запросить спецификацию у поставщика']), '', '## Что подтвердить у поставщика', ...qs.map(q => `- ${q}`), '', '## Что проверить на образце', ...(x.intelligence.reportRules?.sampleCheckList?.length ? x.intelligence.reportRules.sampleCheckList.map(q => `- ${q}`) : ['- соответствие выбранному SKU', '- материал и запах после распаковки', '- реальные размеры/комплектацию', '- качество упаковки', '- заявленные свойства только на образце/по документам']), '', '## Фото, которые нужно запросить', '- общий вид выбранного SKU', '- фото упаковки', '- фото маркировки/этикетки', '- фото подошвы/дна/креплений/деталей, если применимо', '', '## Логистика', `Вес: ${x.weight.displayText.replace(/^Вес:\s*/i, '')}`, 'Габариты: уточнить по выбранному SKU', 'Упаковка: индивидуальная/транспортная — уточнить', '', '## Бюджет', `Образец: ${x.price.calculationPriceYuan ? cny(x.price.calculationPriceYuan) : 'не рассчитано'}`, '20 шт: после подтверждения цены/веса/карго', '50 шт: после подтверждения цены/веса/карго', '', '## Риски', ...x.readiness.risks.slice(0, 8).map(r => `- ${r}`), '', '## Что не включено в расчёт', '- финальная стоимость карго без веса/габаритов', '- возвраты, реклама, хранение и комиссии маркетплейса', '- сертификация/маркировка, если потребуется', '- ручная проверка конкурентов и рынка', '', '## Вывод', x.readiness.canRecommendSample ? 'Можно запрашивать данные для образца. Партию не закупать до проверки рынка и веса.' : 'Закупать партию рано: сначала закрыть недостающие данные.'].join('\n'); }

export function buildCargoBrief(product: any, sourceUrl = ''): string { const x = buildDecisionContext(product); const category = x.categoryType; const extra = category === 'electronics' ? ['- есть ли батарейка/аккумулятор', '- мощность и тип зарядки', '- сертификаты/инструкция'] : category === 'beauty' ? ['- состав, срок годности, документы', '- герметичность упаковки'] : category === 'shoes' ? ['- вес пары с коробкой', '- габариты коробки одной пары', '- количество пар в транспортной коробке'] : ['- есть ли жидкость / магнит / порошок / стекло / батарейка']; return ['# ТЗ для расчёта карго', '', '## Ссылка', sourceUrl || '—', '', '## Товар', x.title, '', '## Что нужно запросить', '- вес 1 единицы с упаковкой', '- габариты индивидуальной упаковки', '- количество в транспортной коробке', '- вес транспортной коробки', '- габариты транспортной коробки', '- фото индивидуальной и транспортной упаковки', '- материал товара', '- код ТН ВЭД, если поставщик знает', ...extra, '', '## Текущий статус', `Вес: ${x.weight.displayText.replace(/^Вес:\s*/i, '')}`, `SKU: ${x.sku.skuSummary}`, '', '## Важно', 'Карго не рассчитывается точно без веса и габаритов выбранного SKU.'].join('\n'); }

export function buildInfographicBrief(product: any): string { const x = buildDecisionContext(product); const ideas = uniq([...(x.intelligence.reportRules?.infographicIdeas ?? []), ...(x.intelligence.reportRules?.photoBriefItems ?? []), 'общий вид товара', ...(x.sku.skuCount > 1 ? ['SKU: цвета/размеры/комплектации'] : []), ...(x.weight.canUseForCargo ? ['вес/упаковка после подтверждения'] : ['запросить фото упаковки и вес']), 'сценарии применения', 'важные особенности с пометкой “заявлено/подтвердить”'], 6); return ['# ТЗ для инфографики', '', '## Главный слайд', `Название: ${x.title}`, 'Акцент: понятный тип товара и основной сценарий применения', '', ...ideas.slice(0,5).flatMap((idea, i) => [`## Слайд ${i + 1} — ${idea}`, 'Что показать: фото/ракурс, подтверждающий этот пункт', `Текст: ${cautiousClaim(idea)}`, '']), '## Что нельзя писать на инфографике', '- лечебный эффект, сертификацию, безопасность, оригинальность бренда и регулируемые свойства как факт без документов', '- ROI/прибыльность без ручного сценария и подтверждённой цены продажи'].join('\n'); }

export function buildRiskChecklist(product: any): string { const x = buildDecisionContext(product); const categoryRisks = CATEGORY_BUYER_CHECKS[x.categoryType] ?? CATEGORY_BUYER_CHECKS.other; return ['# Риск-чеклист товара', '', '## Главные риски', ...(x.readiness.risks.length ? x.readiness.risks.map(r => `- ${r}`) : ['- рынок и конкуренты не проверены вручную']), '', '## Что проверить до образца', ...x.readiness.missingData.map(m => `- ${m}`), '- цену выбранного SKU', '- вес и габариты упаковки', '- реальные фото', '', '## Что проверить на образце', ...categoryRisks.slice(0, 8).map(r => `- ${r}`), '', '## Что проверить перед партией', '- ручную проверку 3–5 конкурентов WB/Ozon', '- финальную себестоимость с карго', '- документы/маркировку для регулируемых claims', '- возвраты/размерную сетку/упаковку', '', '## Красные флаги', ...(x.readiness.blockers.length ? x.readiness.blockers.map(b => `- ${b}`) : ['- поставщик не подтверждает вес/комплектацию', '- claims без документов', '- фото не совпадают со SKU']), '', '## Решение', x.readiness.canRecommendSample ? 'Можно переходить к образцу после подтверждения SKU/веса. Партию не закупать.' : 'Пока не готово к закупке: закрыть недостающие данные.'].join('\n'); }

export function buildSampleRecommendation(product: any): string { const x = buildDecisionContext(product); const sku = x.sku.recommendedSampleSku || 'базовый/самый массовый SKU'; const categoryTip = x.categoryType === 'shoes' ? 'Для обуви лучше взять средний размер 39/40 или 40/41 и не брать полный размерный ряд.' : x.sku.isMultiPack ? 'Для multi-pack лучше взять минимальную и максимальную комплектацию, чтобы сравнить вес и упаковку.' : 'Для первого образца берите 1–2 единицы, не партию.'; return ['# Рекомендация по образцу', '', '## Лучше взять', `- SKU: ${sku}`, '- 1–2 единицы, не партию', '- вариант без спорных claims, если есть выбор', '', '## Почему', '- дешевле проверить качество', '- можно измерить вес и габариты', '- можно сделать свои фото', '- можно проверить упаковку', '- можно проверить заявленные свойства на образце', '', '## Категорийная рекомендация', categoryTip, '', '## До заказа образца', ...topQuestions(product, x, 5).map(q => `- ${q}`)].join('\n'); }

export function buildSafeSummary(product: any, reason?: string): string { const x = buildDecisionContext(product); return ['⚠️ <b>Анализ требует уточнения</b>', '', `Товар: ${html(x.title)}`, `Статус: ${html(x.readiness.label)}`, '', `Главный риск: ${html(reason || x.readiness.blockers[0] || x.readiness.risks[0] || 'данные недостаточно подтверждены')}`, 'Следующий шаг: отправьте вопросы поставщику или внесите вес/ответ поставщика — пересчитаю себестоимость.', '', 'Не делать: не закупать партию, пока не подтверждены SKU, вес, упаковка и ручная проверка рынка.', '', 'Кредит не списан.'].join('\n'); }

export function validateGeneratedText(input: { productIntelligence?: ProductIntelligenceLike; generatedText: string; reportType: 'main' | 'detail1688' | 'seo' | 'buyerBrief' | 'supplierQuestions'; categoryType?: string; marketDecision?: MarketDecision; weightDecision?: WeightDecision }): { ok: boolean; errors: string[]; fixedText: string } { const errors: string[] = []; let fixed = String(input.generatedText ?? ''); if (/\b(?:undefined|null|NaN|Infinity|-Infinity)\b/i.test(fixed)) errors.push('technical garbage'); if (/0(?:[,.]0+)?\s*[¥￥₽]/i.test(fixed)) errors.push('zero price'); if (/0(?:[,.]0+)?\s*(?:кг|kg)\b/i.test(fixed)) errors.push('zero weight'); fixed = fixed.replace(/\b(?:undefined|null|NaN|Infinity|-Infinity)\b/gi, '—').replace(/0(?:[,.]0+)?\s*[¥￥]/gi, 'цена уточняется').replace(/0(?:[,.]0+)?\s*₽/gi, 'цена уточняется').replace(/0(?:[,.]0+)?\s*(?:кг|kg)\b/gi, 'вес уточняется').replace(/""/g, '—'); if (input.reportType !== 'detail1688' && /[一-鿿]/.test(fixed)) { errors.push('raw chinese normalized'); fixed = fixed.split('\n').map(line => normalizeMixedProductText(line)).filter(Boolean).join('\n'); }
  // Never block a useful report just because WB/ROI is absent. Only remove numeric ROI when it is presented without user scenario context.
  if (/\bROI\b[^\n]*(?:\d|%)/i.test(fixed) && !/сценар|введ[её]нн|по\s+вашей\s+цене|manual/i.test(fixed)) { errors.push('roi without manual scenario'); fixed = fixed.split('\n').filter(line => !/\bROI\b[^\n]*(?:\d|%)/i.test(line)).join('\n'); }
  fixed = fixed.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim(); return { ok: errors.length === 0, errors, fixedText: fixed }; }

import { getCategoryRules, type ProductCategoryType } from './categoryRules';
import type { ProductIntelligence } from '../types';

interface ValidationResult {
  ok: boolean;
  errors: string[];
  fixedText: string;
}

export type HardValidatorSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface HardValidatorIssue {
  field: string;
  severity: HardValidatorSeverity;
  problem: string;
  action: string;
}

export interface HardValidatorSafeSummary {
  status: 'черновик' | 'рабочая гипотеза' | 'надёжный расчёт' | 'отклонить';
  verdict: string;
  mainRisk: string;
  nextStep: string;
  doNotDo: string;
}

export interface HardValidatorResult {
  ok: boolean;
  block: boolean;
  canShowFullReport: boolean;
  issues: HardValidatorIssue[];
  warnings: HardValidatorIssue[];
  fixedArtifacts: Record<string, unknown>;
  safeUserSummary: HardValidatorSafeSummary;
}

const CHINESE_PATTERN = /[一-鿿]/;
const RAW_CN_VALUES = ['现货', '加厚', '注塑鞋', '包头拖', '出口', '整单', '库存类型', '货源类别'];
const TECH_GARBAGE_PATTERN = /\b(?:NaN|undefined|null)\b/i;
const ZERO_PRICE_PATTERN = /(?:^|[^\d])0(?:[,.]0+)?\s*[¥￥₽]/i;
const ZERO_WEIGHT_PATTERN = /(?:^|[^\d])0(?:[,.]0+)?\s*(?:кг|kg)\b/i;
const LONG_FLOAT_PATTERN = /\d+[.,]\d{4,}/;
const RAW_DEBUG_PATTERN = /\b(?:debug|rawPriceFields|extraInfoKeys|quote_type|stack trace|object Object)\b/i;
const ROI_PATTERN = /\b(?:ROI|марж[аиу]|прибыль|рентабельность)\b[^\n\r]*(?:\d|%|₽)/i;
const MARKET_PRICE_PATTERN = /\b(?:рыночн\w*\s+цен\w*|цена\s+продажи|sellPrice|marketPrice)\b[^\n\r]*(?:\d|₽)/i;
const POSITIVE_BUY_PATTERN = /\b(?:можно\s+(?:закупать|брать|тестировать)|заказать\s+тест|тест\s*\d+\s*[–-]\s*\d+\s*шт|закупка\s+целесообразна)\b/i;
const UNCONFIRMED_CLAIMS = [
  'водонепроницаемый',
  'влагозащищенный',
  'влагозащищённый',
  'ip67',
  'ip68',
  'сертифицированный',
  'сертификат есть',
  'безопасный',
  'лечебный',
  'медицинский',
  'ортопедический',
  'гипоаллергенный',
  'антибактериальный',
  'для детей',
  'премиальный',
  'профессиональный',
];

function toPlainText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(toPlainText).join('\n');
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).map(toPlainText).join('\n');
  return '';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
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
  return n !== null && n > 0 ? n : null;
}

function addIssue(
  issues: HardValidatorIssue[],
  field: string,
  severity: HardValidatorSeverity,
  problem: string,
  action: string,
): void {
  issues.push({ field, severity, problem, action });
}

function cleanPublicText(text: string): string {
  let fixed = text
    .replace(/\bNaN\b/gi, '—')
    .replace(/\bundefined\b/gi, '—')
    .replace(/\bnull\b/gi, '—')
    .replace(/\b0(?:[,.]0+)?\s*[¥￥]/gi, 'цена уточняется')
    .replace(/\b0(?:[,.]0+)?\s*₽/gi, 'цена уточняется')
    .replace(/\b0(?:[,.]0+)?\s*(?:кг|kg)\b/gi, 'вес уточняется')
    .replace(/\d+([,.]\d{4,})/g, (match) => {
      const parsed = Number(match.replace(',', '.'));
      return Number.isFinite(parsed) ? String(Math.round(parsed * 100) / 100).replace('.', ',') : '—';
    })
    .replace(/^.*(?:debug|rawPriceFields|extraInfoKeys|quote_type|stack trace|object Object).*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (CHINESE_PATTERN.test(fixed)) {
    fixed = fixed
      .split('\n')
      .filter((line) => !CHINESE_PATTERN.test(line))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  return fixed;
}

function sanitizeArtifacts(artifacts: Record<string, unknown>, snapshot?: Record<string, unknown>): Record<string, unknown> {
  const fixed: Record<string, unknown> = {};
  const directAnalogsCount = asNumber(asRecord(snapshot?.market).directAnalogsCount) ?? 0;
  const marketConfirmed = Boolean(asRecord(snapshot?.market).marketConfirmed);

  const cleanValue = (value: unknown): unknown => {
    if (typeof value === 'string') {
      let text = cleanPublicText(value);
      if (directAnalogsCount <= 0 || !marketConfirmed) {
        text = text
          .split('\n')
          .filter((line) => !ROI_PATTERN.test(line))
          .join('\n')
          .trim();
      }
      return text;
    }
    if (Array.isArray(value)) return value.map(cleanValue).filter((item) => item !== '' && item !== null && item !== undefined);
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const cleanedKey = cleanPublicText(key);
        if (!cleanedKey) continue;
        const cleanedValue = cleanValue(child);
        if (cleanedValue === '' || cleanedValue === null || cleanedValue === undefined) continue;
        out[cleanedKey] = cleanedValue;
      }
      return out;
    }
    if (typeof value === 'number') {
      return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
    }
    return value;
  };

  for (const [key, value] of Object.entries(artifacts)) {
    fixed[key] = cleanValue(value);
  }

  return fixed;
}

function hasConfirmedClaim(snapshot: Record<string, unknown>, claim: string): boolean {
  const text = toPlainText([
    asRecord(snapshot.productContext).seoPolicy,
    asRecord(snapshot.productContext).facts,
    asRecord(snapshot.raw1688).attributesRaw,
  ]).toLowerCase();

  if (claim.startsWith('ip')) return text.includes(claim);
  if (claim.includes('водо') || claim.includes('влаго')) return /водонепрониц|влагозащит|ip\s*\d{2}/i.test(text);
  if (claim.includes('серти')) return /сертифик|декларац|eac|тр\s*тс|ce\b/i.test(text);
  if (claim.includes('дет')) return /детск|реб[её]н|children|kids/i.test(text);
  if (claim.includes('леч') || claim.includes('медиц') || claim.includes('ортопед')) return /медиц|лечеб|ортопед|medical|therapy/i.test(text);
  return text.includes(claim);
}

function inferSafeSummary(snapshot: Record<string, unknown>, issues: HardValidatorIssue[]): HardValidatorSafeSummary {
  const productContext = asRecord(snapshot.productContext);
  const titles = asRecord(productContext.titles);
  const identity = asRecord(productContext.identity);
  const market = asRecord(snapshot.market);
  const economics = asRecord(snapshot.economics);
  const purchasePrice = asRecord(snapshot.purchasePrice);
  const weight = asRecord(snapshot.weight);
  const sku = asRecord(snapshot.sku);

  const productName = String(titles.shortRu || titles.cleanRu || identity.productType || 'товар').trim();
  const directAnalogsCount = asNumber(market.directAnalogsCount) ?? 0;
  const marketConfirmed = Boolean(market.marketConfirmed);
  const economicsStatus = String(economics.status ?? 'not_calculated');
  const criticalIssues = issues.filter((issue) => issue.severity === 'critical' || issue.severity === 'high');
  const hasPrice = positiveNumber(purchasePrice.valueCny) !== null || positiveNumber(economics.purchasePriceCny) !== null;
  const hasWeight = positiveNumber(weight.packedWeightKg) !== null || positiveNumber(weight.valueKg) !== null;
  const skuNeedsSelection = Boolean(sku.needsSelection);

  let status: HardValidatorSafeSummary['status'] = 'черновик';
  if (criticalIssues.some((issue) => /claim|закуп|roi|рын/i.test(issue.field))) status = 'отклонить';
  else if (economicsStatus === 'confirmed' && marketConfirmed && directAnalogsCount > 0 && hasPrice && hasWeight && !skuNeedsSelection) status = 'надёжный расчёт';
  else if (hasPrice || marketConfirmed || directAnalogsCount > 0) status = 'рабочая гипотеза';

  const missing: string[] = [];
  if (!hasPrice) missing.push('цена выбранного SKU/партии');
  if (!hasWeight) missing.push('вес с упаковкой');
  if (skuNeedsSelection) missing.push('выбранный SKU');
  if (!marketConfirmed || directAnalogsCount <= 0) missing.push('прямые аналоги и рыночная цена');

  const mainRisk = criticalIssues[0]?.problem || (missing.length ? `Не подтверждены: ${missing.join(', ')}.` : 'Остаётся риск расхождения данных поставщика и рынка.');

  return {
    status,
    verdict: status === 'надёжный расчёт'
      ? `${productName}: можно рассматривать только как проверенную рабочую гипотезу, не как гарантию закупки.`
      : `${productName}: полный отчёт заблокирован валидатором, потому что данные нельзя показывать как надёжный расчёт.`,
    mainRisk,
    nextStep: missing.length
      ? `Запросить у поставщика: ${missing.slice(0, 4).join(', ')}.`
      : 'Сверить выбранный SKU, упаковку и прямые аналоги вручную перед закупкой.',
    doNotDo: 'Не считать ROI/маржу и не закупать партию, пока не подтверждены SKU, вес с упаковкой, цена партии и прямой рынок.',
  };
}

function textHasAnyClaim(text: string, claim: string): boolean {
  const lower = text.toLowerCase();
  if (claim === 'ip67' || claim === 'ip68') return lower.includes(claim);
  return lower.includes(claim);
}

export function runHardValidator(input: {
  analysisSnapshot?: unknown;
  snapshot?: unknown;
  artifacts?: Record<string, unknown> | unknown;
  generatedArtifacts?: Record<string, unknown> | unknown;
}): HardValidatorResult {
  const snapshot = asRecord(input.analysisSnapshot ?? input.snapshot);
  const artifacts = asRecord(input.artifacts ?? input.generatedArtifacts);
  const fullText = toPlainText(artifacts);
  const issues: HardValidatorIssue[] = [];
  const warnings: HardValidatorIssue[] = [];

  if (ZERO_PRICE_PATTERN.test(fullText)) {
    addIssue(issues, 'artifacts.price', 'critical', 'В пользовательском тексте найден технический ноль цены: 0 ¥/₽.', 'Заменить на “цена уточняется” или “—”.');
  }
  if (ZERO_WEIGHT_PATTERN.test(fullText)) {
    addIssue(issues, 'artifacts.weight', 'critical', 'В пользовательском тексте найден технический ноль веса: 0 кг.', 'Заменить на “вес уточняется” или “—”.');
  }
  if (TECH_GARBAGE_PATTERN.test(fullText)) {
    addIssue(issues, 'artifacts.rawTokens', 'critical', 'В пользовательском тексте есть NaN/undefined/null.', 'Удалить технические значения из всех пользовательских материалов.');
  }
  if (LONG_FLOAT_PATTERN.test(fullText)) {
    addIssue(warnings, 'artifacts.floatPrecision', 'medium', 'В тексте есть длинные неокруглённые float-значения.', 'Округлить числа до 1–2 знаков.');
  }
  if (RAW_DEBUG_PATTERN.test(fullText)) {
    addIssue(issues, 'artifacts.debug', 'high', 'В пользовательский текст попал debug/raw-output.', 'Удалить debug/raw поля.');
  }

  const market = asRecord(snapshot.market);
  const economics = asRecord(snapshot.economics);
  const purchasePrice = asRecord(snapshot.purchasePrice);
  const weight = asRecord(snapshot.weight);
  const sku = asRecord(snapshot.sku);
  const supplier = asRecord(snapshot.supplier);
  const moq = asRecord(supplier.moq);

  const directAnalogsCount = asNumber(market.directAnalogsCount) ?? 0;
  const broadCategoryCount = asNumber(market.broadCategoryCount) ?? 0;
  const crossBorderCount = asNumber(market.crossBorderCount) ?? 0;
  const marketConfirmed = Boolean(market.marketConfirmed);
  const canUseForEconomics = Boolean(market.canUseForEconomics);
  const canShowRoi = Boolean(economics.canShowRoi);
  const canShowMargin = Boolean(economics.canShowMargin);
  const sellPriceRub = positiveNumber(economics.sellPriceRub);
  const purchasePriceCny = positiveNumber(economics.purchasePriceCny) ?? positiveNumber(purchasePrice.valueCny);
  const economicsStatus = String(economics.status ?? 'not_calculated');

  if (directAnalogsCount <= 0 && (canShowRoi || canShowMargin || ROI_PATTERN.test(fullText))) {
    addIssue(issues, 'economics.roi', 'critical', 'ROI/маржа показаны без прямых аналогов.', 'Скрыть ROI и маржу. Написать: “Рыночная цена не подтверждена. ROI и маржу считать нельзя.”');
  }

  if ((!marketConfirmed || !canUseForEconomics) && (sellPriceRub !== null || MARKET_PRICE_PATTERN.test(fullText))) {
    addIssue(issues, 'market.price', 'critical', 'Рыночная цена используется при неподтверждённом рынке.', 'Не показывать цену продажи как рыночную, пока marketConfirmed/canUseForEconomics не true.');
  }

  if (directAnalogsCount <= 0 && broadCategoryCount > 0 && /рынок\s+подтвержд|рыночная\s+цена|можно\s+считать\s+roi/i.test(fullText)) {
    addIssue(issues, 'market.broadCategory', 'critical', 'Широкая категория выглядит использованной как подтверждение рынка.', 'Разделить broad category и direct analogs; broad category не использовать для экономики.');
  }

  if (crossBorderCount > 0 && /cross[-\s]?border[^\n]*(?:эконом|roi|марж|цена\s+продажи)|(?:эконом|roi|марж)[^\n]*cross[-\s]?border/i.test(fullText)) {
    addIssue(issues, 'market.crossBorder', 'critical', 'Cross-border товары используются или могут быть поняты как база экономики локального WB.', 'Указать, что cross-border не используется для локальной экономики.');
  }

  if (POSITIVE_BUY_PATTERN.test(fullText)) {
    const missingForPurchase = [
      Boolean(sku.needsSelection) ? 'SKU не выбран' : '',
      purchasePriceCny === null ? 'цена партии/SKU не подтверждена' : '',
      positiveNumber(weight.packedWeightKg) === null && positiveNumber(weight.valueKg) === null ? 'вес с упаковкой не подтверждён' : '',
      !marketConfirmed || directAnalogsCount <= 0 ? 'прямой рынок не подтверждён' : '',
      economicsStatus !== 'confirmed' ? `экономика ${economicsStatus}` : '',
    ].filter(Boolean);

    if (missingForPurchase.length) {
      addIssue(issues, 'verdict.purchaseAction', 'critical', `Позитивный закупочный verdict при неполных данных: ${missingForPurchase.join(', ')}.`, 'Заменить на “проверять дальше”, “только образец” или “недостаточно данных”.');
    }
  }

  if (purchasePriceCny === null && /\d+(?:[,.]\d+)?\s*[¥￥]/.test(fullText)) {
    addIssue(issues, 'purchasePrice.contradiction', 'high', 'В тексте есть цена в ¥, но в snapshot цена закупки отсутствует.', 'Показывать “цена уточняется”.');
  }

  if (positiveNumber(weight.packedWeightKg) === null && positiveNumber(weight.valueKg) === null && /\d+(?:[,.]\d+)?\s*(?:кг|kg)\b/i.test(fullText)) {
    addIssue(issues, 'weight.contradiction', 'high', 'В тексте есть вес, но в snapshot вес отсутствует.', 'Показывать “вес уточняется”.');
  }

  if (positiveNumber(moq.value) === null && /MOQ|минимальн\w*\s+заказ[^\n]*\d|\d+\s*шт\.?\s*(?:миним|MOQ)/i.test(fullText)) {
    addIssue(warnings, 'supplier.moq', 'medium', 'В тексте может быть MOQ, которого нет в snapshot.', 'Проверить, что MOQ не противоречит источнику.');
  }

  for (const claim of UNCONFIRMED_CLAIMS) {
    if (textHasAnyClaim(fullText, claim) && !hasConfirmedClaim(snapshot, claim)) {
      addIssue(issues, `claim.${claim}`, ['ip67', 'ip68', 'сертифицированный', 'для детей', 'лечебный', 'медицинский'].includes(claim) ? 'critical' : 'high', `Неподтверждённый claim в пользовательских материалах: “${claim}”.`, 'Удалить claim или заменить на вопрос поставщику/риск.');
    }
  }

  const lastMessage = String(artifacts.lastMessage ?? artifacts.LastMessage ?? '');
  const userCard = String(artifacts.userCard ?? artifacts.UserCard ?? '');
  if (lastMessage && userCard) {
    const lastHasRoi = ROI_PATTERN.test(lastMessage);
    const mainHasRoi = ROI_PATTERN.test(userCard);
    if (lastHasRoi !== mainHasRoi && directAnalogsCount <= 0) {
      addIssue(issues, 'lastMessage.sourceOfTruth', 'high', '/last и основная карточка расходятся по ROI/марже.', 'Собрать оба текста из одного AnalysisSnapshot и скрыть ROI без direct analogs.');
    }
  }

  const fixedArtifacts = sanitizeArtifacts(artifacts, snapshot);
  const blockingIssues = issues.filter((issue) => issue.severity === 'critical' || issue.severity === 'high');
  const safeUserSummary = inferSafeSummary(snapshot, issues);

  return {
    ok: blockingIssues.length === 0 && warnings.length === 0,
    block: blockingIssues.some((issue) => issue.severity === 'critical'),
    canShowFullReport: blockingIssues.length === 0,
    issues,
    warnings,
    fixedArtifacts,
    safeUserSummary,
  };
}

export function validateReport(
  text: string,
  categoryType: ProductCategoryType,
  context: {
    hasPrice: boolean;
    hasWeight: boolean;
    hasDirectAnalogs: boolean;
    wb429: boolean;
    intelligence?: ProductIntelligence | null;
  }
): ValidationResult {
  const errors: string[] = [];
  const rules = getCategoryRules(categoryType);
  let fixed = cleanPublicText(text);

  // 1. No debug fields
  if (RAW_DEBUG_PATTERN.test(fixed)) {
    errors.push('debug fields found');
    fixed = fixed.replace(/^.*(?:debug|quote_type|rawPriceFields|extraInfoKeys).*$/gm, '');
  }

  // 2. No 0 ¥ / 0 ₽ / 0 кг
  if (ZERO_PRICE_PATTERN.test(fixed) && !context.hasPrice) {
    errors.push('0 ¥/₽ shown without price');
    fixed = fixed.replace(/\b0(?:[,.]0+)?\s*¥/gi, 'нужно уточнить');
    fixed = fixed.replace(/\b0(?:[,.]0+)?\s*₽/gi, 'нужно уточнить');
  }
  if (ZERO_WEIGHT_PATTERN.test(fixed) && !context.hasWeight) {
    errors.push('0 кг shown without weight');
    fixed = fixed.replace(/\b0(?:[,.]0+)?\s*(?:кг|kg)\b/gi, 'нужно уточнить');
  }

  // 3. No Chinese characters in user-facing text
  if (CHINESE_PATTERN.test(fixed)) {
    errors.push('Chinese characters found');
    fixed = fixed.split('\n').filter(line => !CHINESE_PATTERN.test(line)).join('\n');
  }

  // 4. No raw CN values
  for (const raw of RAW_CN_VALUES) {
    if (fixed.includes(raw)) {
      errors.push(`raw CN value: ${raw}`);
      fixed = fixed.replace(new RegExp(raw, 'g'), '');
    }
  }

  // 5. No forbidden category terms
  for (const forbidden of rules.forbiddenFields) {
    const pattern = new RegExp(forbidden, 'gi');
    if (pattern.test(fixed)) {
      errors.push(`forbidden term for ${categoryType}: ${forbidden}`);
      fixed = fixed.replace(pattern, '');
    }
  }

  // 6. ROI without direct analogs
  if (!context.hasDirectAnalogs && ROI_PATTERN.test(fixed)) {
    errors.push('ROI calculated without direct analogs');
    fixed = fixed
      .split('\n')
      .filter((line) => !ROI_PATTERN.test(line))
      .join('\n');
  }

  // 7. WB 429 not mentioned
  if (context.wb429 && !fixed.includes('ограничил') && !fixed.includes('429')) {
    errors.push('WB 429 not mentioned');
  }

  // 8. Intelligence-based forbidden content
  if (context.intelligence?.reportRules?.buyerMustNotAsk) {
    for (const forbidden of context.intelligence.reportRules.buyerMustNotAsk) {
      if (fixed.toLowerCase().includes(forbidden.toLowerCase())) {
        errors.push(`intelligence forbidden: ${forbidden}`);
      }
    }
  }
  if (context.intelligence?.reportRules?.seoForbiddenClaims) {
    for (const forbidden of context.intelligence.reportRules.seoForbiddenClaims) {
      if (fixed.toLowerCase().includes(forbidden.toLowerCase())) {
        errors.push(`intelligence seo forbidden claim: ${forbidden}`);
      }
    }
  }

  fixed = fixed.replace(/\n{3,}/g, '\n\n').trim();

  return {
    ok: errors.length === 0,
    errors,
    fixedText: fixed,
  };
}

function isSuspiciousCharacteristicMapping(key: string, value: string): boolean {
  const k = key.toLowerCase();
  const v = value.toLowerCase();
  const colorWords = /\b(?:красн|ж[её]лт|син|зел[её]н|черн|ч[её]рн|бел|розов|сер|brown|red|yellow|blue|green|black|white|pink|gray|grey)\b/i;
  const numericFields = /мощность|напряжение|вольт|ватт|ёмкость|емкость|ток|частота|размер|вес|длина|ширина|высота|диаметр/i;
  const textileFields = /цвет|материал|ткань|состав/i;
  const electricValues = /\b(?:\d+\s*(?:w|вт|v|в|mah|мач|hz|гц)|usb|type-c|аккумулятор|батар)/i;

  if (numericFields.test(k) && colorWords.test(v)) return true;
  if (textileFields.test(k) && electricValues.test(v)) return true;
  return false;
}

export function validateSeoContent(
  seo: { title?: string; titleRu?: string; description?: string; bullets?: string[]; characteristics?: Record<string, string> },
  categoryType: ProductCategoryType,
  intelligence?: ProductIntelligence | null,
): { ok: boolean; errors: string[]; fixed: typeof seo } {
  const errors: string[] = [];
  const rules = getCategoryRules(categoryType);
  const fixed = { ...seo };

  const checkText = (text: string, field: string): string => {
    let safe = cleanPublicText(text);
    if (CHINESE_PATTERN.test(safe)) {
      errors.push(`Chinese in SEO ${field}`);
      safe = safe.replace(/[一-鿿]+/g, '').trim();
    }
    if (TECH_GARBAGE_PATTERN.test(safe) || ZERO_PRICE_PATTERN.test(safe) || ZERO_WEIGHT_PATTERN.test(safe)) {
      errors.push(`technical garbage in SEO ${field}`);
      safe = cleanPublicText(safe);
    }
    for (const raw of RAW_CN_VALUES) {
      if (safe.includes(raw)) {
        errors.push(`raw CN in SEO ${field}: ${raw}`);
        safe = safe.replace(new RegExp(raw, 'g'), '');
      }
    }
    for (const forbidden of rules.forbiddenFields) {
      if (safe.toLowerCase().includes(forbidden.toLowerCase())) {
        errors.push(`forbidden in SEO ${field}: ${forbidden}`);
      }
    }
    // Intelligence-based forbidden claims
    if (intelligence?.reportRules?.seoForbiddenClaims) {
      for (const forbidden of intelligence.reportRules.seoForbiddenClaims) {
        if (safe.toLowerCase().includes(forbidden.toLowerCase())) {
          errors.push(`intelligence seo forbidden in ${field}: ${forbidden}`);
        }
      }
    }
    return safe.replace(/\s{2,}/g, ' ').trim();
  };

  if (fixed.title) fixed.title = checkText(fixed.title, 'title');
  if (fixed.titleRu) fixed.titleRu = checkText(fixed.titleRu, 'titleRu');
  if (fixed.description) fixed.description = checkText(fixed.description, 'description');
  if (fixed.bullets) {
    fixed.bullets = fixed.bullets
      .map((b, i) => checkText(b, `bullet[${i}]`))
      .filter(b => b && !CHINESE_PATTERN.test(b));
  }
  if (fixed.characteristics) {
    const cleanChars: Record<string, string> = {};
    for (const [k, v] of Object.entries(fixed.characteristics)) {
      const safeKey = checkText(k, 'characteristic.key');
      const safeValue = checkText(String(v), `characteristic.${k}`);
      if (!safeKey || !safeValue) continue;
      if (CHINESE_PATTERN.test(safeKey) || CHINESE_PATTERN.test(safeValue)) {
        errors.push(`Chinese in characteristics: ${k}`);
        continue;
      }
      const kLower = safeKey.toLowerCase();
      if (rules.forbiddenFields.some(f => kLower.includes(f.toLowerCase()))) {
        errors.push(`forbidden characteristic: ${safeKey}`);
        continue;
      }
      if (isSuspiciousCharacteristicMapping(safeKey, safeValue)) {
        errors.push(`suspicious characteristic mapping: ${safeKey}: ${safeValue}`);
        continue;
      }
      // Intelligence: hide specific attributes
      if (intelligence?.reportRules?.attributesToHide?.some(
        (h) => kLower.includes(h.toLowerCase())
      )) {
        errors.push(`intelligence hidden characteristic: ${safeKey}`);
        continue;
      }
      cleanChars[safeKey] = safeValue;
    }
    fixed.characteristics = cleanChars;
  }

  return { ok: errors.length === 0, errors, fixed };
}

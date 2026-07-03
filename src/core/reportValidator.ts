import { getCategoryRules, type ProductCategoryType } from "./categoryRules";
import { normalizeMixedProductText } from "./cnNormalize";
import type { ProductIntelligence } from "../types";

interface ValidationResult {
  ok: boolean;
  errors: string[];
  fixedText: string;
}

export type HardValidatorSeverity = "low" | "medium" | "high" | "critical";

export interface HardValidatorIssue {
  field: string;
  severity: HardValidatorSeverity;
  problem: string;
  action: string;
}

export interface HardValidatorSafeSummary {
  status: "черновик" | "рабочая гипотеза" | "надёжный расчёт" | "отклонить";
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
const RAW_CN_VALUES = [
  "现货",
  "加厚",
  "注塑鞋",
  "包头拖",
  "出口",
  "整单",
  "库存类型",
  "货源类别",
];
const TECH_GARBAGE_PATTERN = /\b(?:NaN|undefined|null)\b/i;
const ZERO_PRICE_PATTERN = /(?:^|[^\d])0(?:[,.]0+)?\s*[¥￥₽]/i;
const ZERO_WEIGHT_PATTERN = /(?:^|[^\d])0(?:[,.]0+)?\s*(?:кг|kg)\b/i;
const LONG_FLOAT_PATTERN = /\d+[.,]\d{4,}/;
const RAW_DEBUG_PATTERN =
  /\b(?:debug|rawPriceFields|extraInfoKeys|quote_type|stack trace|object Object)\b/i;
const показатель_PATTERN =
  /\b(?:показатель|марж[аиу]|результат|рентабельность)\b[^\n\r]*(?:\d|%|₽)/i;
const MARKET_PRICE_PATTERN =
  /(?:рыночн[а-яё]*\s+цен[а-яё]*|цена\s+продажи|sellPrice|marketPrice)[^\n\r]*(?:\d|₽)/i;
const POSITIVE_BUY_PATTERN =
  /(?:можно\s+(?:закупать|брать|тестировать)|заказать\s+тест|тест\s*\d+\s*[–-]\s*\d+\s*шт|закупка\s+целесообразна)/i;
type ClaimPolicy = {
  id: string;
  label: string;
  severity: HardValidatorSeverity;
  patterns: RegExp[];
  evidencePattern: RegExp;
  replacement: string;
  negativeContextReplacement: string;
};

const BASE_CLAIM_POLICIES: ClaimPolicy[] = [
  {
    id: "protection_rating",
    label: "класс защиты / IP-рейтинг",
    severity: "critical",
    patterns: [
      /\bIP\s*\d{2,3}\s*[\/\-]\s*IP?\s*\d{2,3}\b/gi,
      /\bIP\s*\d{2,3}\b/gi,
    ],
    evidencePattern: /\bIP\s*\d{2,3}\b|класс\s+защит/i,
    replacement: "заявленный класс защиты — уточнить у поставщика",
    negativeContextReplacement: "неподтверждённый класс защиты",
  },
  {
    id: "water_resistance",
    label: "влагозащита / водонепроницаемость",
    severity: "high",
    patterns: [/водонепроницаем\w*/gi, /влагозащищ[её]нн\w*/gi, /waterproof/gi],
    evidencePattern: /водонепрониц|влагозащит|waterproof|\bIP\s*\d{2,3}\b/i,
    replacement: "заявленная влагозащита — уточнить у поставщика",
    negativeContextReplacement: "влагозащита без подтверждения",
  },
  {
    id: "certification",
    label: "сертификация / документы",
    severity: "critical",
    patterns: [
      /сертифицир[а-яё]*/gi,
      /сертификат\s+есть/gi,
      /сертифицированн\w*/gi,
      /\bEAC\b/gi,
      /ТР\s*ТС/gi,
      /деклараци[яи]/gi,
    ],
    evidencePattern:
      /сертифик|декларац|\bEAC\b|ТР\s*ТС|\bCE\b|протокол\s+испытан/i,
    replacement: "сертификацию нужно подтвердить документами",
    negativeContextReplacement: "сертификация без документов",
  },
  {
    id: "safety_compliance",
    label: "безопасность / соответствие нормам",
    severity: "high",
    patterns: [/безопасн[а-яё]*/gi, /нетоксичн[а-яё]*/gi, /non[-\s]?toxic/gi],
    evidencePattern:
      /безопасн|нетоксич|non[-\s]?toxic|протокол\s+испытан|сертифик|декларац/i,
    replacement: "безопасность нужно подтвердить документами/составом",
    negativeContextReplacement: "обещания безопасности без подтверждения",
  },
  {
    id: "regulated_audience",
    label: "детское назначение / регулируемая аудитория",
    severity: "critical",
    patterns: [/для\s+детей/gi, /детск[а-яё]*/gi, /kids|children/gi],
    evidencePattern: /детск|для\s+детей|kids|children|сертифик|декларац/i,
    replacement: "детское назначение — только после подтверждения документов",
    negativeContextReplacement: "детское назначение без документов",
  },
  {
    id: "medical_health",
    label: "медицинские / лечебные свойства",
    severity: "critical",
    patterns: [
      /лечебн[а-яё]*/gi,
      /медицинск[а-яё]*(?:\s+(?:эффект|свойств|назначени|издели|товар|сертифик|документ))/gi,
      /ортопедическ[а-яё]*/gi,
      /гипоаллергенн[а-яё]*/gi,
      /антибактериальн[а-яё]*/gi,
      /medical\s+(?:effect|claim|device|certification)|therapy|hypoallergenic|antibacterial/gi,
    ],
    evidencePattern:
      /лечеб|ортопед|гипоаллерген|антибактериальн|medical\s+(?:effect|claim|device|certification)|therapy|сертифик|регистрационн/i,
    replacement: "заявленное спецсвойство — подтвердить документами/испытаниями",
    negativeContextReplacement: "спецсвойство без документов",
  },
  {
    id: "quality_grade",
    label: "класс качества / премиальность",
    severity: "medium",
    patterns: [
      /премиальн[а-яё]*/gi,
      /профессиональн[а-яё]*/gi,
      /лучший|топовый|идеальн[а-яё]*/gi,
      /premium|professional|best/gi,
    ],
    evidencePattern:
      /премиальн|профессиональн|premium|professional|серия|модель|версия|grade/i,
    replacement: "класс качества требует подтверждения",
    negativeContextReplacement: "обещания класса качества без подтверждения",
  },
  {
    id: "authenticity_brand",
    label: "оригинальность / бренд",
    severity: "critical",
    patterns: [
      /оригинальн[а-яё]*/gi,
      /брендов[а-яё]*/gi,
      /official|original|authentic/gi,
    ],
    evidencePattern:
      /оригинальн|official|authentic|бренд|товарн[а-яё]+\s+знак|лиценз/i,
    replacement: "оригинальность/бренд нужно подтвердить документами",
    negativeContextReplacement: "оригинальность/бренд без подтверждения",
  },
  {
    id: "eco_food_contact",
    label: "эко / пищевой контакт",
    severity: "high",
    patterns: [
      /экологичн[а-яё]*/gi,
      /эко[-\s]?материал[а-яё]*/gi,
      /пищев[а-яё]+\s+(?:пластик|силикон|контакт)/gi,
      /food[-\s]?grade|eco[-\s]?friendly/gi,
    ],
    evidencePattern:
      /экологич|эко|food[-\s]?grade|пищев|сертифик|декларац|протокол/i,
    replacement: "эко/пищевой контакт нужно подтвердить документами",
    negativeContextReplacement: "эко/пищевой claim без документов",
  },
];

function toPlainText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) return value.map(toPlainText).join("\n");
  if (typeof value === "object")
    return Object.values(value as Record<string, unknown>)
      .map(toPlainText)
      .join("\n");
  return "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const normalized = value.replace(",", ".").replace(/[^\d.-]/g, "");
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
    .replace(/\bNaN\b/gi, "—")
    .replace(/\bundefined\b/gi, "—")
    .replace(/\bnull\b/gi, "—")
    .replace(/\b0(?:[,.]0+)?\s*[¥￥]/gi, "цена уточняется")
    .replace(/\b0(?:[,.]0+)?\s*₽/gi, "цена уточняется")
    .replace(/\b0(?:[,.]0+)?\s*(?:кг|kg)\b/gi, "вес уточняется")
    .replace(/\d+([,.]\d{4,})/g, (match) => {
      const parsed = Number(match.replace(",", "."));
      return Number.isFinite(parsed)
        ? String(Math.round(parsed * 100) / 100).replace(".", ",")
        : "—";
    })
    .replace(
      /^.*(?:debug|rawPriceFields|extraInfoKeys|quote_type|stack trace|object Object).*$/gim,
      "",
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (CHINESE_PATTERN.test(fixed)) {
    fixed = fixed
      .split("\n")
      .filter((line) => !CHINESE_PATTERN.test(line))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  return fixed;
}

function sanitizeArtifacts(
  artifacts: Record<string, unknown>,
  snapshot?: Record<string, unknown>,
): Record<string, unknown> {
  const fixed: Record<string, unknown> = {};
  const directAnalogsCount =
    asNumber(asRecord(snapshot?.market).directAnalogsCount) ?? 0;
  const marketConfirmed = Boolean(asRecord(snapshot?.market).marketConfirmed);

  const cleanValue = (value: unknown): unknown => {
    if (typeof value === "string") {
      let text = sanitizeUnconfirmedClaims(
        cleanPublicText(value),
        snapshot ?? {},
      );
      if (directAnalogsCount <= 0 || !marketConfirmed) {
        text = text
          .split("\n")
          .filter(
            (line) =>
              isNegativeEconomyContext(line) ||
              isScenarioEconomyContext(line) ||
              (!показатель_PATTERN.test(line) && (!MARKET_PRICE_PATTERN.test(line) || isScenarioEconomyContext(line))),
          )
          .join("\n")
          .trim();
      }
      return text;
    }
    if (Array.isArray(value))
      return value
        .map(cleanValue)
        .filter((item) => item !== "" && item !== null && item !== undefined);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(
        value as Record<string, unknown>,
      )) {
        const cleanedKey = cleanPublicText(key);
        if (!cleanedKey) continue;
        const cleanedValue = cleanValue(child);
        if (
          cleanedValue === "" ||
          cleanedValue === null ||
          cleanedValue === undefined
        )
          continue;
        out[cleanedKey] = cleanedValue;
      }
      return out;
    }
    if (typeof value === "number") {
      return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
    }
    return value;
  };

  for (const [key, value] of Object.entries(artifacts)) {
    fixed[key] = cleanValue(value);
  }

  return fixed;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeClaimId(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-zа-яё0-9]+/gi, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "dynamic_claim"
  );
}

function getSnapshotClaimText(snapshot: Record<string, unknown>): string {
  const productContext = asRecord(snapshot.productContext);
  const productIntelligence = asRecord(productContext.productIntelligence);
  const seoPolicy = asRecord(productContext.seoPolicy);
  const reportRules = asRecord(productIntelligence.reportRules);
  return toPlainText([
    asRecord(productContext.titles),
    asRecord(productContext.identity),
    asRecord(productContext.productIdentity),
    seoPolicy.allowedClaims,
    reportRules.seoAllowedClaims,
    asRecord(productContext.facts),
    asRecord(snapshot.raw1688).titleCn,
    asRecord(snapshot.raw1688).attributesRaw,
  ]).toLowerCase();
}

// Only these genuinely dangerous / unverifiable claim families may spawn a
// destructive dynamic "неподтверждённое свойство …" replacement. Ordinary
// descriptive adjectives (острый, прочный, классический, удобный, компактный,
// стильный …) must NOT trigger it — otherwise a knife SKU label like
// "острый и прочный, классический дизайн" gets shredded into doubled
// "неподтверждённое свойство — уточнить у поставщика".
const DANGEROUS_CLAIM_TERMS: RegExp[] = [
  /антибактериальн/i,
  /антимикробн/i,
  /бактерицидн/i,
  /медицинск/i,
  /лечебн/i,
  /ортопедическ/i,
  /терапевтическ/i,
  /сертифицирован/i,
  /гипоаллергенн/i,
  /безопасн[а-яё]*\s+для\s+детей/i,
  /детск[а-яё]*\s+безопасн/i,
  /профессиональн/i,
  /оригинальн[а-яё]*\s+бренд/i,
  /водонепроницаем/i,
  /водостойк/i,
  /влагозащищ/i,
  /влагонепроницаем/i,
  /UPF\s*50/i,
  /дезинфекц/i,
  /стерилизац/i,
  /пищев[а-яё]*\s+силикон/i,
  /графенов/i,
  /защит[а-яё]*\s+от\s+перегрев/i,
  /быстр[а-яё]*\s+нагрев/i,
  /равномерн[а-яё]*\s+нагрев/i,
  /энергосберегающ/i,
  /экологичн/i,
  /нетоксичн/i,
  /огнеупорн/i,
  /жаропрочн/i,
  /термостойк/i,
  /наноматериал/i,
  /витамин/i,
  /коллаген/i,
];

function isDangerousClaim(value: string): boolean {
  return DANGEROUS_CLAIM_TERMS.some((re) => re.test(value));
}

function collectDynamicForbiddenClaims(
  snapshot: Record<string, unknown>,
): string[] {
  const productContext = asRecord(snapshot.productContext);
  const productIntelligence = asRecord(productContext.productIntelligence);
  const seoPolicy = asRecord(productContext.seoPolicy);
  const reportRules = asRecord(productIntelligence.reportRules);
  const raw = [
    ...String(toPlainText(seoPolicy.forbiddenClaims)).split(/\n|,|;/),
    ...String(toPlainText(reportRules.seoForbiddenClaims)).split(/\n|,|;/),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const value = item.replace(/^[-•\s]+/g, "").trim();
    if (!value || value.length < 3 || value.length > 80) continue;
    // Only genuinely dangerous/unverifiable claims may become a destructive
    // replacement. Neutral descriptors coming through SEO forbiddenClaims are
    // ignored here so they don't wreck SKU labels/titles.
    if (!isDangerousClaim(value)) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function buildClaimPolicies(snapshot: Record<string, unknown>): ClaimPolicy[] {
  const byId = new Map<string, ClaimPolicy>();
  for (const policy of BASE_CLAIM_POLICIES) byId.set(policy.id, policy);

  for (const claim of collectDynamicForbiddenClaims(snapshot)) {
    const id = `dynamic_${normalizeClaimId(claim)}`;
    if (byId.has(id)) continue;
    const exact = new RegExp(escapeRegExp(claim), "gi");
    byId.set(id, {
      id,
      label: claim,
      severity: "high",
      patterns: [exact],
      evidencePattern: new RegExp(escapeRegExp(claim), "i"),
      replacement: "неподтверждённое свойство — уточнить у поставщика",
      negativeContextReplacement: "неподтверждённое свойство без документов",
    });
  }

  return [...byId.values()];
}

function hasConfirmedClaim(
  snapshot: Record<string, unknown>,
  policy: ClaimPolicy,
): boolean {
  // Dynamic forbidden claims are intentionally not confirmed by their own
  // presence in forbiddenClaims. They can be confirmed only by allowedClaims/facts/raw.
  return policy.evidencePattern.test(getSnapshotClaimText(snapshot));
}

function inferSafeSummary(
  snapshot: Record<string, unknown>,
  issues: HardValidatorIssue[],
): HardValidatorSafeSummary {
  const productContext = asRecord(snapshot.productContext);
  const titles = asRecord(productContext.titles);
  const identity = asRecord(productContext.identity);
  const market = asRecord(snapshot.market);
  const economics = asRecord(snapshot.economics);
  const purchasePrice = asRecord(snapshot.purchasePrice);
  const weight = asRecord(snapshot.weight);
  const sku = asRecord(snapshot.sku);

  const productName = String(
    titles.shortRu || titles.cleanRu || identity.productType || "товар",
  ).trim();
  const directAnalogsCount = asNumber(market.directAnalogsCount) ?? 0;
  const marketConfirmed = Boolean(market.marketConfirmed);
  const economicsStatus = String(economics.status ?? "not_calculated");
  const criticalIssues = issues.filter(
    (issue) => issue.severity === "critical" || issue.severity === "high",
  );
  const hasPrice =
    positiveNumber(purchasePrice.valueCny) !== null ||
    positiveNumber(economics.purchasePriceCny) !== null;
  const hasWeight =
    positiveNumber(weight.packedWeightKg) !== null ||
    positiveNumber(weight.valueKg) !== null;
  const skuNeedsSelection = Boolean(sku.needsSelection);

  let status: HardValidatorSafeSummary["status"] = "черновик";
  if (criticalIssues.some((issue) => /claim|закуп|roi|рын/i.test(issue.field)))
    status = "отклонить";
  else if (
    economicsStatus === "confirmed" &&
    marketConfirmed &&
    directAnalogsCount > 0 &&
    hasPrice &&
    hasWeight &&
    !skuNeedsSelection
  )
    status = "надёжный расчёт";
  else if (hasPrice || marketConfirmed || directAnalogsCount > 0)
    status = "рабочая гипотеза";

  const missing: string[] = [];
  if (!hasPrice) missing.push("цена выбранного SKU/партии");
  if (!hasWeight) missing.push("вес с упаковкой");
  if (skuNeedsSelection) missing.push("выбранный SKU");
  /* карточки товара market is optional in no-карточка товара MVP; do not add it as blocking missing data. */

  const mainRisk =
    criticalIssues[0]?.problem ||
    (missing.length
      ? `Не подтверждены: ${missing.join(", ")}.`
      : "Остаётся риск расхождения данных поставщика и рынка.");

  return {
    status,
    verdict:
      status === "надёжный расчёт"
        ? `${productName}: можно рассматривать только как проверенную рабочую гипотезу, не как гарантию закупки.`
        : `${productName}: полный отчёт заблокирован валидатором, потому что данные нельзя показывать как надёжный расчёт.`,
    mainRisk,
    nextStep: missing.length
      ? `Запросить у поставщика: ${missing.slice(0, 4).join(", ")}.`
      : "Сверить выбранный SKU, упаковку и прямые похожие товары вручную перед закупкой.",
    doNotDo:
      "Не закупать партию, пока не подтверждены SKU, вес с упаковкой, упаковка и ручная проверка рынка.",
  };
}

function textHasClaim(text: string, policy: ClaimPolicy): boolean {
  return policy.patterns.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

function isBenignMedicalProductContext(line: string): boolean {
  const text = line.toLowerCase();
  // Category/use-case phrases such as “медицинские сабо” or
  // “обувь для медработников” are product positioning, not health claims.
  const productNoun =
    /(?:сабо|обув[ьиь]|тапочк|туфл|сланц|халат|форма|одежд|маск|перчатк|шапочк|костюм|комплект|носок|сумк)/i;
  const medicalAudience =
    /(?:медицинск|медработник|медперсонал|врач|медсестр|клиник|больниц|салон|лаборатор)/i;
  const realClaim =
    /(?:лечебн|ортопед|гипоаллерген|антибактериальн|издели[ея]\s+медицинск|регистрационн|сертифик|декларац|протокол|эффект|терап)/i;
  return medicalAudience.test(text) && productNoun.test(text) && !realClaim.test(text);
}

function isSafeClaimContext(line: string, policy?: ClaimPolicy): boolean {
  const text = String(line ?? "");
  if (!text.trim()) return true;
  if (isVerificationQuestionContext(text) || isNegativeClaimContext(text)) return true;
  if (/(?:заявлен[а-яё]*|по\s+заявлени[юя]|нужно\s+подтвердить|требует\s+(?:уточнения|проверки|подтверждения)|подтвердить\s+(?:документами|испытаниями|на\s+образце)|уточнить\s+у\s+поставщика|без\s+подтверждения|без\s+документов|проверить\s+на\s+образце)/i.test(text)) {
    return true;
  }
  if (policy?.id === "medical_health" && isBenignMedicalProductContext(text)) return true;
  return false;
}

function riskyClaimLines(text: string, policy: ClaimPolicy): string[] {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !isSafeClaimContext(line, policy) && textHasClaim(line, policy));
}

function hasRiskyClaim(text: string, policy: ClaimPolicy): boolean {
  return riskyClaimLines(text, policy).length > 0;
}

function isVerificationQuestionContext(line: string): boolean {
  return /(?:есть\s+ли|какие|подтвердите|уточните|укажите|можно\s+получить|запросить|проверить)/i.test(
    line,
  );
}

function isNegativeClaimContext(line: string): boolean {
  return /(?:есть\s+ли.*(?:сертифик|документ|протокол)|какие.*(?:сертифик|документ|протокол)|подтвердите|уточните|укажите|проверить|нельзя|запрещено|не\s+писать|не\s+использовать|не\s+утверждать|недопустимо|запрет|требует\s+уточнения|требует\s+проверки|нужно\s+подтвердить|без\s+документов|если\s+потребуется|что\s+не\s+включено|заявлен[а-яё]*)/i.test(
    line,
  );
}

function isNegativeEconomyContext(line: string): boolean {
  return /(?:не\s+считаю|не\s+считать|не\s+показываю|не\s+подтвержден[а-яё]*|контекст закупки\s+не\s+подтвержд|нет\s+подтвержд|нельзя\s+считать|без\s+прямых\s+похожих товаров)/i.test(
    line,
  );
}

function textForEconomyScan(text: string): string {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter((line) => !isNegativeEconomyContext(line))
    .join("\n");
}

function textForClaimScan(text: string): string {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter((line) => !isNegativeClaimContext(line))
    .join("\n");
}

function replaceClaimPatterns(
  text: string,
  policy: ClaimPolicy,
  replacement: string,
): string {
  let fixed = text;
  for (const pattern of policy.patterns) {
    fixed = fixed.replace(pattern, replacement);
  }
  return fixed;
}

function neutralizeClaimWarningLine(
  line: string,
  policies: ClaimPolicy[],
): string {
  if (!isNegativeClaimContext(line)) return line;
  return policies.reduce(
    (current, policy) =>
      replaceClaimPatterns(current, policy, policy.negativeContextReplacement),
    line,
  );
}

function sanitizeUnconfirmedClaims(
  text: string,
  snapshot: Record<string, unknown>,
): string {
  const policies = buildClaimPolicies(snapshot);
  const fixedLines = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => {
      if (isVerificationQuestionContext(line)) return line;
      if (isNegativeClaimContext(line))
        return neutralizeClaimWarningLine(line, policies);
      let fixedLine = line;
      for (const policy of policies) {
        if (!hasConfirmedClaim(snapshot, policy)) {
          fixedLine = replaceClaimPatterns(
            fixedLine,
            policy,
            policy.replacement,
          );
        }
      }
      return fixedLine;
    });

  const UNVERIFIED = "неподтверждённое свойство — уточнить у поставщика";
  const unverifiedEsc = escapeRegExp(UNVERIFIED);
  return fixedLines
    .join("\n")
    .replace(
      /\s+—\s+уточнить у поставщика\s+—\s+уточнить у поставщика/gi,
      " — уточнить у поставщика",
    )
    // "X и X" (or comma) → single X, then any run of the phrase → one phrase.
    .replace(
      new RegExp(`${unverifiedEsc}(?:\\s*(?:и|,)\\s*${unverifiedEsc})+`, "gi"),
      UNVERIFIED,
    )
    .replace(
      new RegExp(`${unverifiedEsc}(?:\\s+${unverifiedEsc})+`, "gi"),
      UNVERIFIED,
    )
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function unresolvedAfterSanitizer(
  issue: HardValidatorIssue,
  sanitizedText: string,
  snapshot: Record<string, unknown>,
): boolean {
  if (issue.field.startsWith("claim.")) {
    const claimId = issue.field.slice("claim.".length);
    const policy = buildClaimPolicies(snapshot).find(
      (item) => item.id === claimId,
    );
    return policy
      ? hasRiskyClaim(textForClaimScan(sanitizedText), policy)
      : false;
  }
  if (issue.field === "artifacts.price")
    return ZERO_PRICE_PATTERN.test(sanitizedText);
  if (issue.field === "artifacts.weight")
    return ZERO_WEIGHT_PATTERN.test(sanitizedText);
  if (issue.field === "artifacts.rawTokens")
    return TECH_GARBAGE_PATTERN.test(sanitizedText);
  if (issue.field === "artifacts.debug")
    return RAW_DEBUG_PATTERN.test(sanitizedText);
  if (issue.field === "economics.roi")
    return показатель_PATTERN.test(textForEconomyScan(sanitizedText));
  if (issue.field === "market.price")
    return MARKET_PRICE_PATTERN.test(textForEconomyScan(sanitizedText));
  return true;
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
  const factSheet = asRecord(snapshot.factSheet);

  if (ZERO_PRICE_PATTERN.test(fullText)) {
    addIssue(
      issues,
      "artifacts.price",
      "critical",
      "В пользовательском тексте найден технический ноль цены: 0 ¥/₽.",
      "Заменить на “цена уточняется” или “—”.",
    );
  }
  if (ZERO_WEIGHT_PATTERN.test(fullText)) {
    addIssue(
      issues,
      "artifacts.weight",
      "critical",
      "В пользовательском тексте найден технический ноль веса: 0 кг.",
      "Заменить на “вес уточняется” или “—”.",
    );
  }
  if (TECH_GARBAGE_PATTERN.test(fullText)) {
    addIssue(
      issues,
      "artifacts.rawTokens",
      "critical",
      "В пользовательском тексте есть NaN/undefined/null.",
      "Удалить технические значения из всех пользовательских материалов.",
    );
  }
  if (LONG_FLOAT_PATTERN.test(fullText)) {
    addIssue(
      warnings,
      "artifacts.floatPrecision",
      "medium",
      "В тексте есть длинные неокруглённые float-значения.",
      "Округлить числа до 1–2 знаков.",
    );
  }
  if (RAW_DEBUG_PATTERN.test(fullText)) {
    addIssue(
      issues,
      "artifacts.debug",
      "high",
      "В пользовательский текст попал debug/raw-output.",
      "Удалить debug/raw поля.",
    );
  }

  const market = asRecord(snapshot.market);
  const economics = asRecord(snapshot.economics);
  const purchasePrice = asRecord(snapshot.purchasePrice);
  const weight = asRecord(snapshot.weight);
  const sku = asRecord(snapshot.sku);
  const supplier = asRecord(snapshot.supplier);
  const moq = asRecord(supplier.moq);
  const factBlockingIssues = Array.isArray(factSheet.summary && (factSheet.summary as any).blockingIssues)
    ? (factSheet.summary as any).blockingIssues as string[]
    : [];
  if (factBlockingIssues.length) {
    addIssue(
      warnings,
      'snapshot.factSheet',
      'medium',
      `В canonical facts есть незакрытые блокирующие пункты: ${factBlockingIssues.slice(0, 3).join('; ')}`,
      'Не превращать эти поля в подтверждённые факты в пользовательских материалах.',
    );
  }

  const directAnalogsCount = asNumber(market.directAnalogsCount) ?? 0;
  const broadCategoryCount = asNumber(market.broadCategoryCount) ?? 0;
  const crossBorderCount = asNumber(market.crossBorderCount) ?? 0;
  const marketConfirmed = Boolean(market.marketConfirmed);
  const canUseForEconomics = Boolean(market.canUseForEconomics);
  const canShowRoi = Boolean(economics.canShowRoi);
  const canShowMargin = Boolean(economics.canShowMargin);
  const sellPriceRub = positiveNumber(economics.sellPriceRub);
  const purchasePriceCny =
    positiveNumber(economics.purchasePriceCny) ??
    positiveNumber(purchasePrice.valueCny);
  const economicsStatus = String(economics.status ?? "not_calculated");

  if (
    directAnalogsCount <= 0 &&
    ((canShowRoi || canShowMargin) && !/scenario|manual|сценар|ручн|введ[её]нн|по\s+вашей\s+цене/i.test(`${economicsStatus} ${fullText}`) ||
      (показатель_PATTERN.test(textForEconomyScan(fullText)) && !/сценар|введ[её]нн|по\s+вашей\s+цене|ручн|manual/i.test(fullText)))
  ) {
    addIssue(
      issues,
      "economics.roi",
      "critical",
      "показатель/себестоимость показаны без прямых похожих товаров.",
      "Скрыть показатель и себестоимость. Написать: “Рыночная цена не подтверждена. показатель и себестоимость считать нельзя.”",
    );
  }

  if (
    (!marketConfirmed || !canUseForEconomics) &&
    (sellPriceRub !== null ||
      (MARKET_PRICE_PATTERN.test(textForEconomyScan(fullText)) && !/сценар|введ[её]нн|по\s+вашей\s+цене|ручн|manual|предполагаем/i.test(fullText)))
  ) {
    addIssue(
      issues,
      "market.price",
      "critical",
      "Рыночная цена используется при неподтверждённом рынке.",
      "Не показывать цену продажи как закупочную, пока marketConfirmed/canUseForEconomics не true.",
    );
  }

  if (
    directAnalogsCount <= 0 &&
    broadCategoryCount > 0 &&
    /контекст закупки\s+подтвержд|закупочная\s+цена|можно\s+считать\s+roi/i.test(fullText)
  ) {
    addIssue(
      issues,
      "market.broadCategory",
      "critical",
      "Широкая категория выглядит использованной как подтверждение рынка.",
      "Разделить broad category и direct analogs; broad category не использовать для экономики.",
    );
  }

  if (
    crossBorderCount > 0 &&
    /cross[-\s]?border[^\n]*(?:эконом|roi|марж|цена\s+продажи)|(?:эконом|roi|марж)[^\n]*cross[-\s]?border/i.test(
      fullText,
    )
  ) {
    addIssue(
      issues,
      "market.crossBorder",
      "critical",
      "Cross-border товары используются или могут быть поняты как база экономики локального карточка товара.",
      "Указать, что cross-border не используется для локальной экономики.",
    );
  }

  if (POSITIVE_BUY_PATTERN.test(fullText)) {
    const missingForPurchase = [
      Boolean(sku.needsSelection) ? "SKU не выбран" : "",
      purchasePriceCny === null ? "цена партии/SKU не подтверждена" : "",
      positiveNumber(weight.packedWeightKg) === null &&
      positiveNumber(weight.valueKg) === null
        ? "вес с упаковкой не подтверждён"
        : "",
      /confirmed|full|scenario/.test(economicsStatus) ? "" : `экономика ${economicsStatus}`, 
    ].filter(Boolean);

    if (missingForPurchase.length) {
      addIssue(
        issues,
        "verdict.purchaseAction",
        "critical",
        `Позитивный закупочный verdict при неполных данных: ${missingForPurchase.join(", ")}.`,
        "Заменить на “проверять дальше”, “только образец” или “недостаточно данных”.",
      );
    }
  }

  if (purchasePriceCny === null && /\d+(?:[,.]\d+)?\s*[¥￥]/.test(fullText)) {
    addIssue(
      issues,
      "purchasePrice.contradiction",
      "high",
      "В тексте есть цена в ¥, но в snapshot цена закупки отсутствует.",
      "Показывать “цена уточняется”.",
    );
  }

  if (
    positiveNumber(weight.packedWeightKg) === null &&
    positiveNumber(weight.valueKg) === null &&
    /\d+(?:[,.]\d+)?\s*(?:кг|kg)\b/i.test(fullText)
  ) {
    addIssue(
      issues,
      "weight.contradiction",
      "high",
      "В тексте есть вес, но в snapshot вес отсутствует.",
      "Показывать “вес уточняется”.",
    );
  }

  if (
    positiveNumber(moq.value) === null &&
    /MOQ|минимальн\w*\s+заказ[^\n]*\d|\d+\s*шт\.?\s*(?:миним|MOQ)/i.test(
      fullText,
    )
  ) {
    addIssue(
      warnings,
      "supplier.moq",
      "medium",
      "В тексте может быть MOQ, которого нет в snapshot.",
      "Проверить, что MOQ не противоречит источнику.",
    );
  }

  const claimScanText = textForClaimScan(fullText);
  for (const policy of buildClaimPolicies(snapshot)) {
    const riskyLines = riskyClaimLines(claimScanText, policy);
    if (riskyLines.length > 0 && !hasConfirmedClaim(snapshot, policy)) {
      addIssue(
        issues,
        `claim.${policy.id}`,
        policy.severity,
        `Неподтверждённое утверждение в пользовательских материалах: ${policy.label}.`,
        "Сформулировать как “заявлено поставщиком / подтвердить документами / проверить на образце”.",
      );
    }
  }

  const lastMessage = String(
    artifacts.lastMessage ?? artifacts.LastMessage ?? "",
  );
  const userCard = String(artifacts.userCard ?? artifacts.UserCard ?? "");
  if (lastMessage && userCard) {
    const lastHasRoi = показатель_PATTERN.test(textForEconomyScan(lastMessage));
    const mainHasRoi = показатель_PATTERN.test(textForEconomyScan(userCard));
    if (lastHasRoi !== mainHasRoi && directAnalogsCount <= 0) {
      addIssue(
        issues,
        "lastMessage.sourceOfTruth",
        "high",
        "/last и основная карточка расходятся по показатель/марже.",
        "Собрать оба текста из одного AnalysisSnapshot и скрыть показатель без direct analogs.",
      );
    }
  }

  const fixedArtifacts = sanitizeArtifacts(artifacts, snapshot);
  const sanitizedText = toPlainText(fixedArtifacts);
  const unresolvedIssues = issues.filter((issue) =>
    unresolvedAfterSanitizer(issue, sanitizedText, snapshot),
  );
  const autoFixedIssues = issues.filter(
    (issue) => !unresolvedAfterSanitizer(issue, sanitizedText, snapshot),
  );
  const allWarnings = [
    ...warnings,
    ...autoFixedIssues.map((issue) => ({
      ...issue,
      severity: "low" as HardValidatorSeverity,
      action: `${issue.action} Исправлено deterministic sanitizer перед отправкой.`,
    })),
  ];
  const blockingIssues = unresolvedIssues.filter(
    (issue) => issue.severity === "critical" || issue.severity === "high",
  );
  const safeUserSummary = inferSafeSummary(snapshot, unresolvedIssues);

  return {
    ok: blockingIssues.length === 0 && allWarnings.length === 0,
    block: blockingIssues.some((issue) => issue.severity === "critical"),
    canShowFullReport: blockingIssues.length === 0,
    issues: unresolvedIssues,
    warnings: allWarnings,
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
  },
): ValidationResult {
  const errors: string[] = [];
  const rules = getCategoryRules(categoryType);
  let fixed = cleanPublicText(text);

  // 1. No debug fields
  if (RAW_DEBUG_PATTERN.test(fixed)) {
    errors.push("debug fields found");
    fixed = fixed.replace(
      /^.*(?:debug|quote_type|rawPriceFields|extraInfoKeys).*$/gm,
      "",
    );
  }

  // 2. No 0 ¥ / 0 ₽ / 0 кг
  if (ZERO_PRICE_PATTERN.test(fixed) && !context.hasPrice) {
    errors.push("0 ¥/₽ shown without price");
    fixed = fixed.replace(/\b0(?:[,.]0+)?\s*¥/gi, "нужно уточнить");
    fixed = fixed.replace(/\b0(?:[,.]0+)?\s*₽/gi, "нужно уточнить");
  }
  if (ZERO_WEIGHT_PATTERN.test(fixed) && !context.hasWeight) {
    errors.push("0 кг shown without weight");
    fixed = fixed.replace(/\b0(?:[,.]0+)?\s*(?:кг|kg)\b/gi, "нужно уточнить");
  }

  // 3. No Chinese characters in user-facing text
  if (CHINESE_PATTERN.test(fixed)) {
    errors.push("Chinese characters found");
    fixed = fixed
      .split("\n")
      .filter((line) => !CHINESE_PATTERN.test(line))
      .join("\n");
  }

  // 4. No raw CN values
  for (const raw of RAW_CN_VALUES) {
    if (fixed.includes(raw)) {
      errors.push(`raw CN value: ${raw}`);
      fixed = fixed.replace(new RegExp(raw, "g"), "");
    }
  }

  // 5. No forbidden category terms
  for (const forbidden of rules.forbiddenFields) {
    const pattern = new RegExp(forbidden, "gi");
    if (pattern.test(fixed)) {
      errors.push(`forbidden term for ${categoryType}: ${forbidden}`);
      fixed = fixed.replace(pattern, "");
    }
  }

  // 6. показатель without direct analogs
  if (
    !context.hasDirectAnalogs &&
    показатель_PATTERN.test(textForEconomyScan(fixed)) &&
    !/сценар|введ[её]нн|по\s+вашей\s+цене|ручн|manual/i.test(fixed)
  ) {
    errors.push("показатель calculated without direct analogs");
    fixed = fixed
      .split("\n")
      .filter(
        (line) => isNegativeEconomyContext(line) || !показатель_PATTERN.test(line),
      )
      .join("\n");
  }

  // 7. карточка товара 429 not mentioned
  if (context.wb429 && !fixed.includes("ограничил") && !fixed.includes("429")) {
    errors.push("карточка товара 429 not mentioned");
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
    for (const forbidden of context.intelligence.reportRules
      .seoForbiddenClaims) {
      if (fixed.toLowerCase().includes(forbidden.toLowerCase())) {
        errors.push(`intelligence seo forbidden claim: ${forbidden}`);
      }
    }
  }

  fixed = fixed.replace(/\n{3,}/g, "\n\n").trim();

  return {
    ok: errors.length === 0,
    errors,
    fixedText: fixed,
  };
}


function isScenarioEconomyContext(line: string): boolean {
  return /(?:сценар|введ[её]нн|по\s+вашей\s+цене|ручн(?:ой|ая)|manual sale|manual price|предполагаем(?:ая|ой)\s+цен)/i.test(String(line ?? ''));
}

function isSuspiciousCharacteristicMapping(
  key: string,
  value: string,
): boolean {
  const k = key.toLowerCase();
  const v = value.toLowerCase();
  const colorWords =
    /\b(?:красн|ж[её]лт|син|зел[её]н|черн|ч[её]рн|бел|розов|сер|brown|red|yellow|blue|green|black|white|pink|gray|grey)\b/i;
  const numericFields =
    /мощность|напряжение|вольт|ватт|ёмкость|емкость|ток|частота|размер|вес|длина|ширина|высота|диаметр/i;
  const textileFields = /цвет|материал|ткань|состав/i;
  const electricValues =
    /\b(?:\d+\s*(?:w|вт|v|в|mah|мач|hz|гц)|usb|type-c|аккумулятор|батар)/i;

  if (numericFields.test(k) && colorWords.test(v)) return true;
  if (textileFields.test(k) && electricValues.test(v)) return true;
  return false;
}

export function validateSeoContent(
  seo: {
    title?: string;
    titleRu?: string;
    description?: string;
    bullets?: string[];
    characteristics?: Record<string, string>;
  },
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
      safe = normalizeMixedProductText(safe);
    }
    if (
      TECH_GARBAGE_PATTERN.test(safe) ||
      ZERO_PRICE_PATTERN.test(safe) ||
      ZERO_WEIGHT_PATTERN.test(safe)
    ) {
      errors.push(`technical garbage in SEO ${field}`);
      safe = cleanPublicText(safe);
    }
    for (const raw of RAW_CN_VALUES) {
      if (safe.includes(raw)) {
        errors.push(`raw CN in SEO ${field}: ${raw}`);
        safe = safe.replace(new RegExp(raw, "g"), "");
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
    return safe.replace(/[ \t]{2,}/g, " ").trim();
  };

  if (fixed.title) fixed.title = checkText(fixed.title, "title");
  if (fixed.titleRu) fixed.titleRu = checkText(fixed.titleRu, "titleRu");
  if (fixed.description)
    fixed.description = checkText(fixed.description, "description");
  if (fixed.bullets) {
    fixed.bullets = fixed.bullets
      .map((b, i) => checkText(b, `bullet[${i}]`))
      .filter((b) => b && !CHINESE_PATTERN.test(b));
  }
  if (fixed.characteristics) {
    const cleanChars: Record<string, string> = {};
    for (const [k, v] of Object.entries(fixed.characteristics)) {
      const safeKey = checkText(k, "characteristic.key");
      const safeValue = checkText(String(v), `characteristic.${k}`);
      if (!safeKey || !safeValue) continue;
      if (CHINESE_PATTERN.test(safeKey) || CHINESE_PATTERN.test(safeValue)) {
        errors.push(`Chinese in characteristics: ${k}`);
        continue;
      }
      const kLower = safeKey.toLowerCase();
      if (rules.forbiddenFields.some((f) => kLower.includes(f.toLowerCase()))) {
        errors.push(`forbidden characteristic: ${safeKey}`);
        continue;
      }
      if (isSuspiciousCharacteristicMapping(safeKey, safeValue)) {
        errors.push(
          `suspicious characteristic mapping: ${safeKey}: ${safeValue}`,
        );
        continue;
      }
      // Intelligence: hide specific attributes
      if (
        intelligence?.reportRules?.attributesToHide?.some((h) =>
          kLower.includes(h.toLowerCase()),
        )
      ) {
        errors.push(`intelligence hidden characteristic: ${safeKey}`);
        continue;
      }
      cleanChars[safeKey] = safeValue;
    }
    fixed.characteristics = cleanChars;
  }

  return { ok: errors.length === 0, errors, fixed };
}

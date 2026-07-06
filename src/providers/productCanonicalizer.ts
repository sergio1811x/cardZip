import type { ProductContext } from "../types";
import { cleanRawAttributes } from "../core/rawAttributeCleaner";
import { selectBestProductTitle } from "../core/titleSelection";

type ProductIntelligenceImageInput = {
  url: string;
  role?: string;
  note?: string;
};

export type RawProductForCanonicalizer = {
  offerId: string;
  titleCn: string;
  titleRu?: string;
  titleEn?: string;
  categoryName?: string;
  attributes?: Array<{ name: string; value: string }>;
  skus?: Array<{
    id?: string;
    skuId?: string;
    name: string;
    price?: number;
    stock?: number;
    image?: string;
  }>;
  normalizedSkuTable?: Array<{
    id?: string;
    label: string;
    priceYuan?: number;
    stock?: number;
    image?: string;
  }>;
  selectedSkuId?: string;
  selectedSkuName?: string;
  selectedSkuPriceYuan?: number;
  selectedSkuImage?: string;
  moq?: number;
  supplierName?: string;
  supplierType?: string;
  supplierRating?: number | string;
  orders?: number | string;
  price?: number;
  priceRange?: Array<{ minQty: number; maxQty: number; price: number }>;
  weightKg?: number;
  mainImageUrl?: string;
  imageUrls?: ProductIntelligenceImageInput[];
  sold?: number;
  stock?: number;
};

type OpenRouterMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "user";
      content: Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      >;
    };

export type CanonicalizerModelResult = Partial<ProductContext> & {
  identity?: Partial<ProductContext["identity"]>;
  titles?: Partial<ProductContext["titles"]>;
  facts?: Record<string, unknown>;
  sku?: Partial<ProductContext["sku"]>;
  price?: Partial<ProductContext["price"]>;
  conflicts?: unknown;
  missingCritical?: unknown;
  searchHints?: Partial<ProductContext["wbSearch"]>;
  seoPolicy?: Partial<ProductContext["seoPolicy"]>;
  supplierQuestions?: Partial<ProductContext["supplierQuestions"]>;
  riskTags?: unknown;
  dataQuality?: Partial<ProductContext["dataQuality"]>;
  procurementProfile?: Record<string, unknown>;
  productProcurementProfile?: Record<string, unknown>;
  productKindClassifier?: Record<string, unknown>;
  classifier?: Record<string, unknown>;
};

// Канонизатор — самый тяжёлый multimodal reasoning шаг (тип товара, разбор SKU,
// электрика/вилки). Ведущая модель должна быть сильной по vision+reasoning,
// дальше идут быстрые дешёвые модели как fallback.
const DEFAULT_VISION_MODELS = [
  "google/gemini-2.5-flash",
  "google/gemini-2.5-flash",
];

const DEFAULT_TEXT_MODELS = [
  "google/gemini-2.5-flash",
  "google/gemini-2.5-flash",
  "deepseek/deepseek-v4-flash",
];

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_TIMEOUT_MS = 75_000;
const DEFAULT_IMAGE_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_IMAGE_BYTES = 1_200_000;
const DEFAULT_MAX_TOKENS = 10000;
const DEFAULT_TEMPERATURE = 0.15;

const CATEGORY_TYPES = [
  "shoes",
  "clothes",
  "electronics",
  "home",
  "beauty",
  "accessory",
  "kitchen",
  "fishing",
  "tools",
  "other",
] as const;

const DATA_QUALITY_STATUSES = [
  "reliable",
  "working_hypothesis",
  "draft",
] as const;
const CONFLICT_SEVERITIES = ["low", "medium", "high"] as const;

function getEnvList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  return parsed.length ? parsed : fallback;
}

const VISION_MODELS = getEnvList(
  "PRODUCT_CANONICALIZER_VISION_MODELS",
  DEFAULT_VISION_MODELS,
);
const TEXT_MODELS = getEnvList(
  "PRODUCT_CANONICALIZER_TEXT_MODELS",
  DEFAULT_TEXT_MODELS,
);

function getNumberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function safeString(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  return value.trim();
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max).trim()}…` : value;
}

function uniqueStrings(values: unknown, max = 12): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];

  for (const item of values) {
    const value = safeString(item);
    if (!value) continue;
    const normalized = value.replace(/\s+/g, " ").trim();
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= max) break;
  }

  return out;
}

function stripChineseFromRussianField(value: string): string {
  return value
    .replace(/[\u3400-\u9FFF\uF900-\uFAFF]+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function safeRu(value: unknown, fallback = ""): string {
  return stripChineseFromRussianField(safeString(value, fallback));
}

function clampInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function normalizeCategoryType(
  value: unknown,
): ProductContext["identity"]["categoryType"] {
  const raw = safeString(value).toLowerCase();
  return CATEGORY_TYPES.includes(raw as any)
    ? (raw as ProductContext["identity"]["categoryType"])
    : "other";
}

function normalizeDataQualityStatus(
  value: unknown,
): ProductContext["dataQuality"]["status"] {
  const raw = safeString(value).toLowerCase();
  return DATA_QUALITY_STATUSES.includes(raw as any)
    ? (raw as ProductContext["dataQuality"]["status"])
    : "draft";
}

function normalizeConflictSeverity(value: unknown): "low" | "medium" | "high" {
  const raw = safeString(value).toLowerCase();
  return CONFLICT_SEVERITIES.includes(raw as any)
    ? (raw as "low" | "medium" | "high")
    : "medium";
}

function normalizeFacts(
  rawFacts: unknown,
  maxEntries = 30,
): Record<string, string> {
  if (!rawFacts || typeof rawFacts !== "object" || Array.isArray(rawFacts))
    return {};

  const out: Record<string, string> = {};
  for (const [keyRaw, valueRaw] of Object.entries(
    rawFacts as Record<string, unknown>,
  )) {
    const key = safeRu(keyRaw);
    const value = safeRu(String(valueRaw ?? ""));

    if (!key || !value) continue;
    if (key.length > 60 || value.length > 160) continue;
    if (["undefined", "null", "nan"].includes(value.toLowerCase())) continue;

    out[key] = value;
    if (Object.keys(out).length >= maxEntries) break;
  }

  return out;
}

function normalizeConflicts(value: unknown): ProductContext["conflicts"] {
  if (!Array.isArray(value)) return [];

  return value.slice(0, 12).map((item) => {
    const obj =
      item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    return {
      field: safeString(obj.field, "unknown"),
      problem: safeRu(obj.problem, "Неясное противоречие"),
      severity: normalizeConflictSeverity(obj.severity),
      action: safeRu(obj.action, "Не выводить как подтверждённый факт"),
    };
  });
}

type NormalizedLogistics = {
  weightKg: number | null;
  weightSource: "card" | "attribute" | "unknown";
  dimensionsCm: string | null;
  packageNote: string | null;
};

function normalizeLogistics(rawLogistics: unknown): NormalizedLogistics {
  const obj =
    rawLogistics && typeof rawLogistics === "object" && !Array.isArray(rawLogistics)
      ? (rawLogistics as Record<string, unknown>)
      : {};

  const weightRaw =
    typeof obj.weightKg === "number" ? obj.weightKg : Number(obj.weightKg);
  const weightKg =
    Number.isFinite(weightRaw) && weightRaw > 0 && weightRaw < 100000
      ? Math.round(weightRaw * 1000) / 1000
      : null;

  const weightSourceRaw = safeString(obj.weightSource).toLowerCase();
  const weightSource: NormalizedLogistics["weightSource"] =
    weightSourceRaw === "card" || weightSourceRaw === "attribute"
      ? weightSourceRaw
      : "unknown";

  const dimsRaw = safeString(obj.dimensionsCm);
  const dimensionsCm = dimsRaw
    ? dimsRaw.replace(/[x*х]/gi, "×").replace(/\s+/g, "") || null
    : null;

  const noteRaw = safeRu(obj.packageNote);
  const packageNote = noteRaw ? truncate(noteRaw, 160) : null;

  return {
    weightKg,
    // Если модель дала вес, но не указала источник, считаем его атрибутом карточки.
    weightSource:
      weightKg && weightSource === "unknown" ? "attribute" : weightSource,
    dimensionsCm,
    packageNote,
  };
}

const CARGO_NATURES = [
  "inflatable",
  "liquid",
  "aerosol",
  "battery",
  "powder",
  "fragile",
  "oversized",
  "textile",
  "food_contact",
  "none",
] as const;

type NormalizedDomainSeo = {
  description: string;
  sellingBullets: string[];
  keywords: string[];
};

type NormalizedDomainCargo = {
  cargoNature: (typeof CARGO_NATURES)[number];
  sensitiveIssues: string[];
  whatToRequest: string[];
  packagingNotes: string;
};

function normalizeDomainSeo(value: unknown): NormalizedDomainSeo | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const obj = value as Record<string, unknown>;

  const description = safeRu(obj.description, "");
  const sellingBullets = uniqueStrings(obj.sellingBullets, 6)
    .map((v) => stripChineseFromRussianField(v))
    .filter(Boolean);
  const keywords = uniqueStrings(obj.keywords, 15)
    .map((v) => stripChineseFromRussianField(v))
    .filter(Boolean);

  if (!description && !sellingBullets.length && !keywords.length)
    return undefined;

  return {
    description: description ? truncate(description, 600) : "",
    sellingBullets,
    keywords,
  };
}

function normalizeDomainCargo(value: unknown): NormalizedDomainCargo | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const obj = value as Record<string, unknown>;

  const natureRaw = safeString(obj.cargoNature).toLowerCase();
  const cargoNature = CARGO_NATURES.includes(natureRaw as any)
    ? (natureRaw as NormalizedDomainCargo["cargoNature"])
    : "none";

  const sensitiveIssues = uniqueStrings(obj.sensitiveIssues, 8)
    .map((v) => stripChineseFromRussianField(v))
    .filter(Boolean);
  const whatToRequest = uniqueStrings(obj.whatToRequest, 8)
    .map((v) => stripChineseFromRussianField(v))
    .filter(Boolean);
  const packagingRaw = safeRu(obj.packagingNotes, "");
  const packagingNotes = packagingRaw ? truncate(packagingRaw, 300) : "";

  if (
    cargoNature === "none" &&
    !sensitiveIssues.length &&
    !whatToRequest.length &&
    !packagingNotes
  )
    return undefined;

  return { cargoNature, sensitiveIssues, whatToRequest, packagingNotes };
}

function cleanJson(raw: string): string {
  return raw
    .replace(/^\uFEFF/, "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function extractJsonObject(raw: string): string | null {
  const cleaned = cleanJson(raw);
  const firstBrace = cleaned.indexOf("{");
  if (firstBrace === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = firstBrace; i < cleaned.length; i += 1) {
    const char = cleaned[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;

    if (depth === 0) {
      return cleaned.slice(firstBrace, i + 1);
    }
  }

  return null;
}

function parseJsonResult(raw: string): CanonicalizerModelResult | null {
  const json = extractJsonObject(raw);
  if (!json) return null;

  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function hasCanonicalizerPayload(
  value: CanonicalizerModelResult | null | undefined,
): value is CanonicalizerModelResult {
  if (!value || typeof value !== "object") return false;
  const profile = (value.procurementProfile ??
    value.productProcurementProfile) as any;
  return Boolean(
    value.identity ||
    (profile && typeof profile === "object" && profile.identity),
  );
}

function profileDraftOf(result: CanonicalizerModelResult): Record<string, any> {
  const profile = (result.procurementProfile ??
    result.productProcurementProfile) as any;
  return profile && typeof profile === "object" && !Array.isArray(profile)
    ? profile
    : {};
}

function cleanCanonicalizerTitle(value: unknown): string {
  return safeRu(value)
    .replace(/cross[\s-]?border/gi, "")
    .replace(/для\s+торговли\s+функции/gi, "")
    .replace(/\b(?:товар|функции|undefined|null|nan)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function getRawPriceStats(raw: RawProductForCanonicalizer): {
  visiblePriceCny: number | null;
  minPriceCny: number | null;
  maxPriceCny: number | null;
  source: string;
  needsConfirmation: boolean;
} {
  const skuPrices = (raw.skus ?? [])
    .map((sku) => sku.price)
    .filter(isPositiveNumber);

  const tierPrices = (raw.priceRange ?? [])
    .map((tier) => tier.price)
    .filter(isPositiveNumber);

  const allPrices = [
    ...(isPositiveNumber(raw.price) ? [raw.price] : []),
    ...skuPrices,
    ...tierPrices,
  ];

  if (!allPrices.length) {
    return {
      visiblePriceCny: null,
      minPriceCny: null,
      maxPriceCny: null,
      source: "unknown",
      needsConfirmation: true,
    };
  }

  const minPriceCny = Math.min(...allPrices);
  const maxPriceCny = Math.max(...allPrices);

  let source = "visible_1688_price";
  if (skuPrices.length)
    source = skuPrices.length > 1 ? "sku_range" : "sku_price";
  else if (tierPrices.length)
    source =
      tierPrices.length > 1 ? "discount_tier_range" : "discount_tier_price";

  return {
    visiblePriceCny: isPositiveNumber(raw.price) ? raw.price : minPriceCny,
    minPriceCny,
    maxPriceCny,
    source,
    needsConfirmation: true,
  };
}

function buildFallbackContext(raw: RawProductForCanonicalizer): ProductContext {
  const price = getRawPriceStats(raw);
  const skuCount = raw.skus?.length ?? 0;
  const knownOptions = (raw.skus ?? [])
    .slice(0, 12)
    .map((sku) => safeString(sku.name))
    .filter(Boolean);

  const cleaned = cleanRawAttributes((raw.attributes as any[]) ?? []);
  const titleSelection = selectBestProductTitle({
    intelligenceTitle: raw.titleRu || raw.titleEn,
    translatedTitle: raw.titleRu || raw.titleEn,
    rawTitleCn: raw.titleCn,
    productKind: raw.categoryName,
    candidates: cleaned.rejectedTitleCandidates.map((x) => x.value),
  });
  const safeTitle = titleSelection.titleForReport || "Товар с 1688";
  return {
    offerId: raw.offerId,
    identity: {
      productType: safeTitle,
      coreObject: safeTitle,
      categoryType: "other",
      useCases: [],
      notThis: [],
      audience: "",
      season: "не применимо",
      gender: "неизвестно",
    },
    titles: {
      titleCn: cleanCanonicalizerTitle(raw.titleCn),
      cleanRu: safeTitle,
      shortRu: safeTitle,
      titleForSeo: safeTitle,
    },
    facts: normalizeFacts(
      Object.fromEntries(
        cleaned.userFacing.slice(0, 20).map((attr) => [attr.label, attr.value]),
      ),
    ),
    sku: {
      hasMultipleSku: skuCount > 1,
      skuCount,
      knownOptions,
      needsSelection: skuCount > 1,
    },
    price,
    conflicts: [],
    missingCritical: [
      ...(raw.weightKg ? [] : ["вес с упаковкой"]),
      ...(skuCount > 1 ? ["выбранный SKU"] : []),
      "подтверждение цены партии",
    ],
    wbSearch: {
      coreQuery: raw.titleRu ?? raw.titleEn ?? "",
      queryLadder: [raw.titleRu ?? raw.titleEn ?? raw.titleCn].filter(Boolean),
      mustInclude: [],
      mustExclude: [],
      directMatchRules: [],
      rejectRules: [],
    },
    seoPolicy: {
      allowedClaims: [],
      forbiddenClaims: [
        "сертифицированный",
        "безопасный",
        "лечебный",
        "премиальный",
      ],
    },
    supplierQuestions: {
      ru: buildDefaultSupplierQuestions(raw, "ru"),
      cn: buildDefaultSupplierQuestions(raw, "cn"),
    },
    riskTags: ["canonicalizer_fallback"],
    dataQuality: {
      score: 2,
      status: "draft",
      explanation:
        "LLM-каноникализация недоступна, использован безопасный fallback из raw-данных.",
    },
  };
}

function buildDefaultSupplierQuestions(
  raw: RawProductForCanonicalizer,
  lang: "ru" | "cn",
): string[] {
  const hasSku = (raw.skus?.length ?? 0) > 1;
  const hasWeight = isPositiveNumber(raw.weightKg);

  if (lang === "cn") {
    const questions = ["您好，我想采购这个产品，请问："];

    if (hasSku) questions.push("1. 请确认所选SKU的单价是多少？");
    else questions.push("1. 请确认这个产品的当前单价是多少？");

    questions.push("2. 购买20/50/100件分别是什么价格？");
    if (!hasWeight) questions.push("3. 单件带包装重量是多少？");
    questions.push("4. 单件包装尺寸是多少？");
    questions.push("5. 产品是否包含所有配件？请发实物照片或视频。");
    questions.push("6. 是否可以先订样品？");
    questions.push("7. 生产/发货周期多久？");

    return questions;
  }

  const questions = [
    hasSku
      ? "1. Подтвердите цену выбранного SKU."
      : "1. Подтвердите актуальную цену товара.",
    "2. Какая цена при заказе 20 / 50 / 100 шт?",
  ];

  if (!hasWeight) questions.push("3. Какой вес одной единицы с упаковкой?");
  questions.push("4. Какой размер индивидуальной упаковки?");
  questions.push("5. Что входит в комплектацию? Пришлите реальные фото/видео.");
  questions.push("6. Можно ли заказать образец?");
  questions.push("7. Какой срок производства/отгрузки?");

  return questions;
}

function buildInfo(raw: RawProductForCanonicalizer): string {
  const lines: string[] = [`Товар с 1688 (offerId: ${raw.offerId})`];

  lines.push(`Название CN: ${raw.titleCn}`);
  if (raw.titleRu) lines.push(`Название RU: ${raw.titleRu}`);
  if (raw.titleEn) lines.push(`Название EN: ${raw.titleEn}`);
  if (raw.categoryName) lines.push(`Категория: ${raw.categoryName}`);
  if (raw.selectedSkuName)
    lines.push(
      `Выбранный SKU: ${raw.selectedSkuName}${isPositiveNumber(raw.selectedSkuPriceYuan) ? ` — ${raw.selectedSkuPriceYuan} ¥` : ""}`,
    );
  if (raw.selectedSkuId)
    lines.push(`selectedSkuId из URL/API: ${raw.selectedSkuId}`);
  if (isPositiveNumber(raw.moq)) lines.push(`MOQ: ${raw.moq} шт`);
  if (
    raw.supplierType ||
    raw.supplierName ||
    raw.supplierRating ||
    raw.orders
  ) {
    lines.push(
      `Поставщик: type=${raw.supplierType ?? "unknown"}; name=${raw.supplierName ?? "—"}; rating=${raw.supplierRating ?? "—"}; orders=${raw.orders ?? raw.sold ?? "—"}`,
    );
  }

  if (isPositiveNumber(raw.price)) lines.push(`Цена: ${raw.price} ¥`);
  else lines.push("Цена: не распознана");

  if (raw.priceRange?.length) {
    lines.push("Оптовые цены:");
    raw.priceRange.slice(0, 10).forEach((tier) => {
      if (isPositiveNumber(tier.price)) {
        lines.push(`- ${tier.minQty}+ шт: ${tier.price} ¥`);
      }
    });
  }

  if (isPositiveNumber(raw.weightKg))
    lines.push(`Вес товара: ${raw.weightKg} кг`);
  else lines.push("Вес товара: не указан");

  if (typeof raw.sold === "number") lines.push(`Продажи/заказы: ${raw.sold}`);
  if (typeof raw.stock === "number" && raw.stock > 0 && raw.stock < 1_000_000)
    lines.push(`Остаток: ${raw.stock}`);

  if (raw.attributes?.length) {
    const cleaned = cleanRawAttributes(raw.attributes as any[], {
      fashionLike: /одежд|обув|clothing|footwear|鞋|衣/i.test(
        `${raw.titleCn} ${raw.titleRu ?? ""} ${raw.categoryName ?? ""}`,
      ),
    });
    if (cleaned.userFacing.length) {
      lines.push("Cleaned useful attributes:");
      cleaned.userFacing.slice(0, 24).forEach((attr) => {
        lines.push(`- ${attr.label}: ${attr.value} (${attr.confidence})`);
      });
    }
    if (cleaned.evidenceOnly.length) {
      lines.push("Evidence-only raw labels, DO NOT copy to user-facing text:");
      cleaned.evidenceOnly.slice(0, 12).forEach((attr) => {
        lines.push(`- ${attr.key}: ${attr.value}`);
      });
    }
    if (cleaned.rejectedTitleCandidates.length) {
      lines.push("Rejected title candidates:");
      cleaned.rejectedTitleCandidates.slice(0, 10).forEach((item) => {
        lines.push(`- ${item.value} (${item.reason})`);
      });
    }
  }

  if (raw.imageUrls?.length) {
    lines.push("Фото для Product Intelligence:");
    raw.imageUrls
      .slice(0, 3)
      .forEach((img) => lines.push(`- ${img.role ?? "image"}: ${img.url}`));
  }

  if (raw.normalizedSkuTable?.length) {
    lines.push(`Normalized SKU table (${raw.normalizedSkuTable.length}):`);
    raw.normalizedSkuTable.slice(0, 20).forEach((sku) => {
      const price = isPositiveNumber(sku.priceYuan)
        ? `${sku.priceYuan} ¥`
        : "цена не указана";
      const stock =
        typeof sku.stock === "number" && sku.stock > 0 && sku.stock < 1_000_000
          ? `остаток: ${sku.stock}`
          : "остаток не выводить";
      lines.push(
        `- ${sku.label} — ${price}, ${stock}${sku.id ? `, id=${sku.id}` : ""}`,
      );
    });
  }

  if (raw.skus?.length) {
    lines.push(`SKU (${raw.skus.length}):`);
    raw.skus.slice(0, 20).forEach((sku) => {
      const price = isPositiveNumber(sku.price)
        ? `${sku.price} ¥`
        : "цена не указана";
      const stock =
        typeof sku.stock === "number" && sku.stock > 0 && sku.stock < 1_000_000
          ? `остаток: ${sku.stock}`
          : "остаток не выводить";
      lines.push(`- ${sku.name} — ${price}, ${stock}`);
    });
  }

  return lines.join("\n");
}

const CANONICALIZER_PROMPT = `Ты — старший закупщик 1688/Taobao/Tmall. Твоя работа — по фото и данным карточки точно определить реальный товар и собрать единый ProductProcurementProfile, из которого детерминированно строится закупочный пакет (отчёт, вопросы поставщику, ТЗ байеру/карго, чек-лист образца, SEO, фото).

Задача: определить товар и вернуть один JSON-объект по контракту ниже. Это единственный источник правды — дальше товар не переугадывается.

Фото используй только для визуально очевидного: тип товара, форма, конструкция, материал/текстура, комплектация, упаковка, видимые маркировки. Не извлекай с фото цену, вес, MOQ, остатки или SKU. Цена, MOQ, supplier, selected SKU и SKU-таблица берутся только из provider/API данных.

Верни СТРОГО JSON без markdown:
{
  "classifier": {
    "visionKind": "видимый тип товара или null",
    "textKind": "тип по названию/SKU/атрибутам или null",
    "finalKind": "лучший точный тип товара по-русски",
    "domainKind": "свободный snake_case домен товара, не enum",
    "categoryType": "shoes|clothes|electronics|home|beauty|accessory|kitchen|tools|fishing|other",
    "confidence": 0.0,
    "visualEvidence": ["что видно на фото"],
    "textEvidence": ["что подтверждено текстом/SKU/атрибутами"],
    "disagreement": false,
    "reason": "почему выбран этот тип"
  },
  "procurementProfile": {
    "identity": {
      "productKind": "точный свободный домен товара: dish_rack, kitchen_storage_rack, umbrella, clothing и т.п.",
      "categoryType": "общая категория",
      "subCategoryType": "подкатегория",
      "titleForReport": "3-6 слов для отчёта",
      "titleForSeo": "название для карточки товара без неподтверждённых claims",
      "shortTitle": "2-4 слова",
      "coreObject": "базовый объект без маркетинга",
      "formFactor": "форма/конструкция",
      "audience": "мужской|женский|унисекс|детский|неизвестно",
      "gender": "мужской|женский|унисекс|детский|неизвестно",
      "season": "лето|зима|демисезон|всесезон|не применимо|неизвестно",
      "useCases": ["реальные сценарии применения"],
      "materials": ["материалы только из данных или фото, если визуально очевидно"],
      "visibleFeatures": ["только то, что видно на фото"],
      "claimedFeatures": ["заявленные свойства, которые нужно подтвердить"],
      "unconfirmedFeatures": ["что нельзя писать как факт"],
      "notThis": ["с чем можно перепутать, но это не оно"],
      "rejectedTitleCandidates": [{"value":"...","reason":"почему нельзя использовать как title"}]
    },
    "sku": {
      "variants": [
        {
          "raw": "исходная строка SKU как есть",
          "model": "код модели/модель или null",
          "color": "цвет по-русски или null",
          "plugStandard": "US|EU|UK|JP|KR|AU|CN или null",
          "dimensions": [
            {"label":"человекочитаемая метка параметра по-русски","value":"значение с единицей по-русски"}
          ]
        }
      ]
    },
    "procurement": {
      "status": "нужны данные поставщика|можно запрашивать образец|готов к заказу образца|данных мало",
      "verdict": "конкретный вывод закупщика под этот товар",
      "nextAction": "одно действие сейчас",
      "mustAskSupplier": ["5-10 конкретных вопросов поставщику без дублей"],
      "mustCheckBeforeSample": ["что проверить до заказа образца"],
      "mustCheckOnSample": ["8-12 проверок образца именно для этого товара"],
      "redFlags": ["реальные закупочные риски"]
    },
    "cargo": {
      "mustAsk": ["6-10 вопросов по весу, габаритам, коробу, упаковке и ограничениям"],
      "likelySensitiveCargoIssues": ["батарея/жидкость/магнит/стекло/острые части/электроника/нет"]
    },
    "content": {
      "seoAllowedClaims": ["что можно безопасно писать"],
      "seoForbiddenClaims": ["что нельзя писать без подтверждения/теста/документов"],
      "titleWarnings": ["что не добавлять в title"],
      "infographicIdeas": ["5-7 идей слайдов под этот товар"]
    },
    "domainRules": {
      "buyerMustCheck": ["6–10 конкретных вопросов поставщику ИМЕННО про этот товар, выведенных из того, что это за предмет: свойства/параметры, о которых спрашивает профессиональный закупщик именно этого объекта (габариты, марка/сорт материала, механизм, безопасность, совместимость). Без дублей, грамотный русский. НЕ ограничивайся ценой/весом/фото."],
      "mustCheckBeforeSample": ["что проверить/уточнить до заказа образца для этого товара"],
      "sampleMustCheck": ["8–12 проверок образца именно для этого товара: измерить, включить, согнуть, потянуть, проверить швы/механизм/заточку и т.п."],
      "cargoMustAsk": ["6–10 вопросов по весу, габаритам, коробу, упаковке и ограничениям перевозки для этого товара"],
      "redFlags": ["реальные закупочные риски именно для этого товара"],
      "seoAllowedClaims": ["что можно безопасно писать про этот товар"],
      "seoForbiddenClaims": ["что нельзя писать без подтверждения/теста/документов"],
      "infographicIdeas": ["5–7 идей слайдов инфографики под этот товар"],
      "forbiddenOtherCategoryTerms": ["термины чужих категорий, которые нельзя добавлять этому товару"],
      "seo": {
        "description": "2–3 предложения, продающее описание для карточки WB/Ozon, конкретно про ЭТОТ товар, грамотный русский, без выдуманных характеристик",
        "sellingBullets": ["5 буллетов — выгоды/применение для покупателя, НЕ внутренние советы, НЕ 'SKU в карточке', НЕ 'проверьте образец'"],
        "keywords": ["8–15 релевантных поисковых запросов, без дублей, без гигантской строки-заголовка"]
      },
      "cargo": {
        "cargoNature": "one of: inflatable | liquid | aerosol | battery | powder | fragile | oversized | textile | food_contact | none",
        "sensitiveIssues": ["конкретные для этого товара карго-риски"],
        "whatToRequest": ["что запросить у поставщика/карго ИМЕННО для этого товара, помимо базового веса/габаритов"],
        "packagingNotes": "короткая заметка про упаковку/перевозку этого товара, или пусто"
      }
    },
    "logistics": {
      "weightKg": "число в кг (вес единицы, нетто/брутто) если явно указано в карточке/атрибутах, иначе null",
      "weightSource": "card|attribute|unknown",
      "dimensionsCm": "внешние габариты как \"N×N×N\" в см (ДхШхВ) если указаны, иначе null",
      "packageNote": "короткая пометка про вес/упаковку по-русски или null"
    },
    "dataQuality": {
      "missingCriticalFields": ["чего не хватает"],
      "contradictions": ["противоречия"],
      "confidence": "high|medium|low",
      "score": 1,
      "reason": "почему такая оценка"
    }
  }
}

Правила:
1. Не копируй raw attributes в ответ. Сначала отличай физический товар от category/sales-channel/technical labels, marketing claims и полезных закупочных полей.
2. Не используй китайский в русских полях. Передавай смысл на русском.
3. Запрещено использовать как title: cross-border, для cross-border торговли, товар, функции, category labels, raw attribute type, single number, empty/garbled text.
4. Если видишь плохой title candidate — добавь его в rejectedTitleCandidates и не показывай пользователю.
5. Не придумывай материал, размер, вес, документы, сертификаты, свойства, цену, MOQ или комплектацию.
6. Supplier name не должен браться из материала. Если supplier name отсутствует — "не указано".
7. Если titleForSeo получился мусорным — используй titleForReport или safe category title.
8. Если свойство заявлено, но не подтверждено, клади его в claimedFeatures/unconfirmedFeatures и seoForbiddenClaims.
9. selectedSkuName, selectedSkuId и selectedSkuPriceCny — обязательный контекст. Не противоречь выбранному SKU.
10. Если selected SKU ненадёжен или конфликтует с данными, укажи это в dataQuality.contradictions, но не придумывай другой SKU.
11. Если передано selected_sku_image, оно важнее main_product_image.
12. Если фото и текст конфликтуют, не выбирай наугад: снизь confidence, disagreement=true, документы осторожные.
13. SKU раскрывай в терминах товара: цвет, размер, модель, версия, объём, нагрузка, комплектность, упаковка.
14. Если SKU содержит технический параметр с единицей измерения, интерпретируй его как параметр товара: 10kg у весов = максимальная нагрузка 10 кг; 5L у ёмкости = объём 5 л; 300ml у диспенсера = объём 300 мл.
15. Не называй понятный технический параметр “параметром SKU”. Если значение SKU непонятно, не называй его размером или моделью.
16. Не добавляй возможности, которых нет в выбранном SKU: проводной SKU не должен получить Bluetooth, аккумулятор или беспроводное подключение.
17. mustAskSupplier должен быть конкретным под товар, максимум 10 вопросов, без дублей.
18. mustCheckOnSample должен описывать реальные действия: примерить, измерить, включить, открыть, закрыть, согнуть, потянуть, постирать, нагреть, взвесить, проверить швы, упаковку или работу механизма — по смыслу товара.
19. cargo.mustAsk должен включать вес единицы с упаковкой, габариты индивидуальной упаковки, количество в коробе, вес/габариты короба, фото упаковки и релевантные ограничения перевозки.
20. Не добавляй чужие категории: одежде не нужны вилка/напряжение/подошва; обуви не нужны аккумулятор/мощность/рукав; зонту не нужна размерная сетка обуви; технике не нужны стелька/посадка на теле.
21. Для dish_rack/kitchen_storage_rack обязательно учитывай количество ярусов, размеры 43/53 см, устойчивость, материал/покрытие, поддон, комплектацию, сборку, риск деформации при доставке.
22. seoAllowedClaims — только безопасные утверждения из данных или визуально очевидного. seoForbiddenClaims — всё, что нельзя писать без сертификата, ответа поставщика или проверки образца.
23. Dangerous claims без подтверждения запрещены как факт: медицинский, ортопедический, лечебный, антибактериальный, сертифицированный, гипоаллергенный, безопасный для детей, профессиональный, оригинальный бренд, 100% водонепроницаемый, UPF50+, дезинфекция, стерилизация.
24. dataQuality.score от 1 до 10: снижай за отсутствие веса, упаковки, selected SKU, цены, фото, документов и за противоречия.
25. ЭЛЕКТРОТОВАРЫ (categoryType=electronics с вариантами вилки/напряжения/модели): каждый SKU разбирай на модель + цвет + стандарт вилки. Маппинг стандарта: 美规→US, 欧规→EU, 英规→UK, 日规→JP, 韩规/韩国/корейский стандарт→KR, 澳规→AU, 国标→CN. Это стандарт питания/вилки, а НЕ цвет и не размер.
26. Напряжение, мощность и тип вилки НИКОГДА не утверждай как подтверждённые, если их нет явно в источнике: клади в claimedFeatures/unconfirmedFeatures и seoForbiddenClaims. Не выводи 220V/110V из стандарта вилки.
27. Никогда не приклеивай число к fallback-тексту (например "Цена: не указана 98"). Если значения нет — верни null или "не указано" без цифры рядом.
28. sku.variants — обязательно разбирай КАЖДЫЙ вариант SKU на осмысленные размеченные параметры (dimensions). Каждый параметр = {label, value}, label — метка по-русски, value — число с единицей по-русски.
29. Числа с единицами измерения или китайскими единичными словами становятся размеченными значениями, а не голым числом:
    - mAh / 毫安 → label "ёмкость", value например "26800 мА·ч";
    - W / 瓦 / 平方 (в контексте освещения/светильника = ватты) → label "мощность", value например "20 Вт";
    - m / 米 / 长度 → label "длина кабеля" или "длина", value например "10 м";
    - L / 升 → label "объём"; kg / 公斤 → label "нагрузка/вес" по смыслу; ml / 毫升 → label "объём".
    Код модели (например 26800M как модель) оставляй в поле model, а не в dimensions.
30. НИКОГДА не выводи голый список чисел без меток. Если смысл числа непонятен — добавь его как dimension с label "параметр — уточнить" и value равным самому числу; не сваливай числа в анонимную кучу и не теряй их.
31. Не приклеивай число к fallback-тексту внутри value (никаких "80 _10 -"). Каждый value — чистое осмысленное значение или само число с меткой "параметр — уточнить".
32. Материал провода/кабеля/вилки/жилы (铜线 медный провод, 铜芯 медная жила, 线芯) — это материал ПОДкомпонента (шнур/вилка), а НЕ материал корпуса товара. Не выводи такой материал как основной материал товара: клади его в unconfirmedFeatures/claimedFeatures с пометкой, что это относится к шнуру/вилке, а не к корпусу. Китайские материалы переводи на русский (铜 → медь) и не дублируй русский и китайский вариант.
33. logistics.weightKg: заполняй ТОЛЬКО если вес единицы явно указан в карточке или атрибутах (重量/毛重/净重/вес). Переводи граммы в килограммы (2650 г → 2.65). Никогда не выдумывай вес. Если указан только вес короба/партии или вес с упаковкой — всё равно захвати его в weightKg и напиши это в packageNote (например "указан вес короба, а не единицы" или "вес с упаковкой не указан"). weightSource: card — вес виден в основной карточке/на фото данных, attribute — из атрибута/характеристик, unknown — если веса нет.
34. logistics.dimensionsCm: заполняй ТОЛЬКО если внешние габариты указаны (尺寸/规格/外形/размер). Нормализуй в формат "N×N×N" в сантиметрах (ДхШхВ). Если единицы явно миллиметры — переведи мм→см. Используй разделитель × (НЕ * и НЕ х). Если габаритов нет — null.
35. НЕ клади вес и габариты в поля materials, sku или в свободный текст. Только в logistics.
36. domainRules.seo и domainRules.cargo делают SEO-черновик и ТЗ карго уникальными под ЭТОТ товар. Заполняй их конкретно, а не шаблонно.
37. domainRules.seo.description — продающее описание для карточки: выгоды покупателю, грамотный русский, правильные падежи после предлогов ("для йоги, фитнеса, бега"). Без голого существительного в начале, без выдуманных характеристик (состав в %, нагрузка, напряжение) — если не знаешь, говори обобщённо или опусти.
38. domainRules.seo.sellingBullets — 5 буллетов о выгодах/сценариях/ощущении материала/универсальности для ПОКУПАТЕЛЯ. НЕ внутренние советы по закупке/QA, НЕ "проверьте образец/вес", НЕ "SKU в карточке: N".
39. domainRules.seo.keywords — реальные поисковые фразы покупателя, 8–15 штук, без дублей, без огромной строки-заголовка.
40. domainRules.cargo.cargoNature — честно классифицируй: inflatable | liquid | aerosol | battery | powder | fragile | oversized | textile | food_contact | none. Если товар надувной/содержит жидкость/батарею/аэрозоль/порошок/хрупкий/негабаритный/текстильный — укажи это, это управляет карго-предупреждениями дальше по пайплайну.
41. domainRules.cargo.sensitiveIssues и whatToRequest должны быть СПЕЦИФИЧНЫ под товар (надувной → клапан, ножной насос, перевозка в сдутом виде, защита от проколов, макс. нагрузка; текстиль → влага, сжатие, состав; батарея → маркировка/правила перевозки). НЕ выдавай один и тот же обобщённый список для всех товаров. Никогда не выдумывай сертификаты и характеристики.
42. domainRules.buyerMustCheck — ОБЯЗАТЕЛЬНОЕ поле и ГЛАВНЫЙ источник вопросов поставщику. Правила:
    - Всегда 6–10 конкретных вопросов, выведенных из того, ЧТО ИМЕННО этот товар (определи объект по названию/фото), а не общий шаблон.
    - Спрашивай про параметры, важные профессиональному закупщику именно ЭТОГО объекта: точные габариты/размеры, марку и сорт материала, механизм/конструкцию, безопасность, совместимость, комплектацию.
    - ЗАПРЕЩЕНО скатываться к одному лишь «цена / вес / фото». Эти базовые пункты допустимы максимум как 1–2 из списка, остальное — про суть товара.
    - НЕ выдумывай характеристики (марку стали, сорт материала, размеры) — СПРАШИВАЙ их у поставщика.
    - Вопросы различны (без дублей), грамотный русский, каждый — отдельный полезный вопрос.
    - Примеры направления мысли (адаптируй под реальный товар, не копируй буквально): нож → марка и твёрдость стали (HRC), длина и толщина клинка, тип заточки, материал рукояти, монтаж хвостовика (цельнокованый/накладной), антикоррозийная обработка, вес и баланс, заточка с завода; сумка → материал и плотность ткани, фурнитура/молнии, внутренние отделения, размеры, максимальная нагрузка; светильник → мощность, световой поток, температура света, питание, материал корпуса.
43. Зеркаль buyerMustCheck и в procurement.mustAskSupplier (тот же смысл). sampleMustCheck и cargoMustAsk также заполняй конкретно под этот товар, а не шаблонно.
`;

const SYSTEM_MSG =
  "Ты Product Canonicalizer. Отвечай только валидным JSON-объектом. Без markdown. Без пояснений.";

export async function fetchCanonicalizerImageAsDataUrl(url: string): Promise<string | null> {
  const maxBytes = getNumberEnv(
    "PRODUCT_CANONICALIZER_MAX_IMAGE_BYTES",
    DEFAULT_MAX_IMAGE_BYTES,
  );
  const timeoutMs = getNumberEnv(
    "PRODUCT_CANONICALIZER_IMAGE_TIMEOUT_MS",
    DEFAULT_IMAGE_TIMEOUT_MS,
  );

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;

    const contentType = res.headers.get("content-type") || "image/jpeg";
    if (!contentType.startsWith("image/")) return null;

    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length || buffer.length > maxBytes) return null;

    return `data:${contentType};base64,${buffer.toString("base64")}`;
  } catch (error) {
    console.warn(
      "[canonicalizer] image fetch failed:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

export async function callCanonicalizerOpenRouter(
  model: string,
  messages: OpenRouterMessage[],
  apiKey: string,
): Promise<CanonicalizerModelResult | null> {
  const timeoutMs = getNumberEnv(
    "PRODUCT_CANONICALIZER_TIMEOUT_MS",
    DEFAULT_TIMEOUT_MS,
  );
  const maxTokens = getNumberEnv(
    "PRODUCT_CANONICALIZER_MAX_TOKENS",
    DEFAULT_MAX_TOKENS,
  );
  const temperatureRaw = Number(process.env.PRODUCT_CANONICALIZER_TEMPERATURE);
  const temperature = Number.isFinite(temperatureRaw)
    ? temperatureRaw
    : DEFAULT_TEMPERATURE;

  try {
    const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer":
          process.env.OPENROUTER_HTTP_REFERER ??
          "https://github.com/sergio1811x/cardZip",
        "X-Title": process.env.OPENROUTER_X_TITLE ?? "cardZip",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature,
        messages,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      console.warn(`[canonicalizer] ${model} HTTP ${res.status}`);
      return null;
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content ?? "";
    const parsed = parseJsonResult(content);

    if (!hasCanonicalizerPayload(parsed)) {
      console.warn(`[canonicalizer] ${model} returned invalid JSON/context`);
      return null;
    }

    return parsed;
  } catch (error) {
    console.warn(
      `[canonicalizer] ${model} failed:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

export function buildCanonicalizerPrompt(raw: RawProductForCanonicalizer): string {
  return `${CANONICALIZER_PROMPT}

ДАННЫЕ ТОВАРА:
${buildInfo(raw)}`;
}

function mergePrice(
  raw: RawProductForCanonicalizer,
  modelPrice: unknown,
): ProductContext["price"] {
  const rawPrice = getRawPriceStats(raw);
  const model =
    modelPrice && typeof modelPrice === "object"
      ? (modelPrice as Record<string, unknown>)
      : {};

  // Числа из парсера имеют приоритет над LLM. Модель может только дополнить source/needsConfirmation,
  // но не должна ухудшать уже распознанные цены.
  const modelVisible = isPositiveNumber(model.visiblePriceCny)
    ? model.visiblePriceCny
    : null;
  const modelMin = isPositiveNumber(model.minPriceCny)
    ? model.minPriceCny
    : null;
  const modelMax = isPositiveNumber(model.maxPriceCny)
    ? model.maxPriceCny
    : null;

  const visiblePriceCny = rawPrice.visiblePriceCny ?? modelVisible;
  const minPriceCny = rawPrice.minPriceCny ?? modelMin;
  const maxPriceCny = rawPrice.maxPriceCny ?? modelMax;

  return {
    visiblePriceCny,
    minPriceCny,
    maxPriceCny,
    source:
      rawPrice.source !== "unknown"
        ? rawPrice.source
        : safeString(model.source, "unknown"),
    needsConfirmation: true,
  };
}

function mergeSku(
  raw: RawProductForCanonicalizer,
  modelSku: unknown,
): ProductContext["sku"] {
  const obj =
    modelSku && typeof modelSku === "object"
      ? (modelSku as Record<string, unknown>)
      : {};
  const skuCount = raw.skus?.length ?? clampInt(obj.skuCount, 0, 0, 999);
  const knownOptionsFromRaw = (raw.skus ?? [])
    .slice(0, 20)
    .map((sku) => safeString(sku.name))
    .filter(Boolean);

  const knownOptions = knownOptionsFromRaw.length
    ? knownOptionsFromRaw
    : uniqueStrings(obj.knownOptions, 20);

  return {
    hasMultipleSku: skuCount > 1 || Boolean(obj.hasMultipleSku),
    skuCount,
    knownOptions,
    needsSelection: skuCount > 1 || Boolean(obj.needsSelection),
  };
}

export function normalizeCanonicalizerContext(
  raw: RawProductForCanonicalizer,
  result: CanonicalizerModelResult,
): ProductContext {
  const profileDraft = profileDraftOf(result);
  const draftIdentity = (profileDraft.identity ?? {}) as Record<string, any>;
  const draftProcurement = (profileDraft.procurement ?? {}) as Record<
    string,
    any
  >;
  const draftContent = (profileDraft.content ?? {}) as Record<string, any>;
  const identity = (result.identity ?? {}) as Record<string, any>;
  const titles = (result.titles ?? {}) as Record<string, any>;
  const seoPolicy = (result.seoPolicy ?? {}) as Record<string, any>;
  const supplierQuestions = (result.supplierQuestions ?? {}) as Record<
    string,
    any
  >;
  const dataQuality = (profileDraft.dataQuality ??
    result.dataQuality ??
    {}) as Record<string, any>;

  const titleSelection = selectBestProductTitle({
    intelligenceTitle:
      draftIdentity.titleForReport ||
      draftIdentity.titleForSeo ||
      identity.productType ||
      identity.coreObject,
    translatedTitle: titles.cleanRu || raw.titleRu || raw.titleEn,
    rawTitleCn: raw.titleCn,
    productKind:
      draftIdentity.productKind ||
      result.classifier?.domainKind ||
      result.productKindClassifier?.domainKind,
    candidates: [
      draftIdentity.shortTitle,
      draftIdentity.coreObject,
      titles.shortRu,
      titles.titleForSeo,
    ],
  });
  const productType = safeRu(
    draftIdentity.titleForReport ||
      draftIdentity.coreObject ||
      identity.productType,
    titleSelection.titleForReport,
  );
  const coreObject = safeRu(
    draftIdentity.coreObject || identity.coreObject,
    productType,
  );
  const cleanRu = safeRu(
    draftIdentity.titleForReport || titles.cleanRu,
    titleSelection.titleForReport,
  );
  const shortRu = safeRu(
    draftIdentity.shortTitle || titles.shortRu,
    coreObject,
  );
  const titleForSeo = safeRu(
    draftIdentity.titleForSeo || titles.titleForSeo,
    titleSelection.titleForSeo,
  );

  const ruQuestions = uniqueStrings(draftProcurement.mustAskSupplier, 10).length
    ? uniqueStrings(draftProcurement.mustAskSupplier, 10)
    : uniqueStrings(supplierQuestions.ru, 10);
  const cnQuestions = uniqueStrings(supplierQuestions.cn, 12);

  const finalRuQuestions = ruQuestions.length
    ? ruQuestions
    : buildDefaultSupplierQuestions(raw, "ru");
  const finalCnQuestions = cnQuestions.length
    ? cnQuestions
    : buildDefaultSupplierQuestions(raw, "cn");

  const ctx: ProductContext & Record<string, unknown> = {
    offerId: raw.offerId,
    identity: {
      productType,
      coreObject,
      categoryType: normalizeCategoryType(
        draftIdentity.categoryType || identity.categoryType,
      ),
      useCases: uniqueStrings(draftIdentity.useCases || identity.useCases, 10)
        .map((value) => stripChineseFromRussianField(value))
        .filter(Boolean),
      notThis: uniqueStrings(draftIdentity.notThis || identity.notThis, 10)
        .map((value) => stripChineseFromRussianField(value))
        .filter(Boolean),
      audience: safeRu(
        draftIdentity.audience || identity.audience,
        "неизвестно",
      ),
      season: safeRu(draftIdentity.season || identity.season, "неизвестно"),
      gender: safeRu(draftIdentity.gender || identity.gender, "неизвестно"),
    },
    titles: {
      titleCn: cleanCanonicalizerTitle(titles.titleCn || raw.titleCn),
      cleanRu,
      shortRu,
      titleForSeo,
    },
    facts: normalizeFacts(result.facts),
    sku: mergeSku(raw, result.sku),
    price: mergePrice(raw, result.price),
    conflicts: normalizeConflicts(result.conflicts),
    missingCritical: uniqueStrings(result.missingCritical, 15)
      .map((value) => stripChineseFromRussianField(value))
      .filter(Boolean),
    wbSearch: {
      coreQuery: shortRu.slice(0, 80),
      queryLadder: uniqueStrings([shortRu, cleanRu], 8)
        .map((value) => stripChineseFromRussianField(value))
        .filter(Boolean),
      mustInclude: uniqueStrings([], 8)
        .map((value) => stripChineseFromRussianField(value))
        .filter(Boolean),
      mustExclude: uniqueStrings([], 12)
        .map((value) => stripChineseFromRussianField(value))
        .filter(Boolean),
      directMatchRules: uniqueStrings([], 10)
        .map((value) => stripChineseFromRussianField(value))
        .filter(Boolean),
      rejectRules: uniqueStrings([], 12)
        .map((value) => stripChineseFromRussianField(value))
        .filter(Boolean),
    },
    seoPolicy: {
      allowedClaims: uniqueStrings(
        draftContent.seoAllowedClaims || seoPolicy.allowedClaims,
        12,
      )
        .map((value) => stripChineseFromRussianField(value))
        .filter(Boolean),
      forbiddenClaims: uniqueStrings(
        draftContent.seoForbiddenClaims || seoPolicy.forbiddenClaims,
        20,
      )
        .map((value) => stripChineseFromRussianField(value))
        .filter(Boolean),
    },
    supplierQuestions: {
      ru: finalRuQuestions,
      cn: finalCnQuestions,
    },
    riskTags: uniqueStrings(result.riskTags, 15)
      .map((value) => stripChineseFromRussianField(value))
      .filter(Boolean),
    dataQuality: {
      score: clampInt(dataQuality.score, 3, 1, 10),
      status: normalizeDataQualityStatus(dataQuality.status),
      explanation: safeRu(dataQuality.explanation, ""),
    },
  };

  const logistics = normalizeLogistics(profileDraft.logistics);

  // Нормализуем product-specific SEO/cargo под-объекты domainRules. Модель кладёт
  // их в procurementProfile.domainRules.{seo,cargo}; downstream (procurementProfile)
  // читает draft.domainRules, поэтому мержим сюда, не затирая остальные поля.
  const rawDomainRules =
    profileDraft.domainRules &&
    typeof profileDraft.domainRules === "object" &&
    !Array.isArray(profileDraft.domainRules)
      ? (profileDraft.domainRules as Record<string, unknown>)
      : {};
  const domainSeo = normalizeDomainSeo(rawDomainRules.seo);
  const domainCargo = normalizeDomainCargo(rawDomainRules.cargo);

  if (profileDraft && typeof profileDraft === "object") {
    // Гарантируем нормализованный logistics-блок внутри draft, чтобы downstream
    // (procurementProfile) читал его по стабильному пути.
    (profileDraft as Record<string, unknown>).logistics = logistics;

    if (domainSeo || domainCargo) {
      const mergedDomainRules: Record<string, unknown> = { ...rawDomainRules };
      if (domainSeo) mergedDomainRules.seo = domainSeo;
      else delete mergedDomainRules.seo;
      if (domainCargo) mergedDomainRules.cargo = domainCargo;
      else delete mergedDomainRules.cargo;
      (profileDraft as Record<string, unknown>).domainRules = mergedDomainRules;
    }

    ctx.procurementProfileDraft = profileDraft;
  }
  // Дублируем на верхний уровень контекста для удобного доступа downstream.
  ctx.logistics = logistics;
  const classifier = result.productKindClassifier ?? result.classifier;
  if (classifier && typeof classifier === "object")
    ctx.productKindClassifier = classifier;

  return ctx as ProductContext;
}

export function hasUsableCanonicalizerContext(ctx: ProductContext): boolean {
  return Boolean(
    ctx.identity.productType && ctx.identity.coreObject && ctx.titles.cleanRu,
  );
}

export async function runVisionCanonicalizer(
  prompt: string,
  imageDataUrls: string[],
  apiKey: string,
): Promise<CanonicalizerModelResult | null> {
  for (const model of VISION_MODELS) {
    console.log(`[canonicalizer] Trying vision ${model}...`);
    const result = await callCanonicalizerOpenRouter(
      model,
      [
        { role: "system", content: SYSTEM_MSG },
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            ...imageDataUrls
              .slice(0, 3)
              .map((url) => ({
                type: "image_url" as const,
                image_url: { url },
              })),
          ],
        },
      ],
      apiKey,
    );

    if (hasCanonicalizerPayload(result)) {
      console.log(`[canonicalizer] Vision success with ${model}`);
      return result;
    }
  }

  console.warn(
    `[canonicalizer] all vision models failed (${VISION_MODELS.join(", ")})`,
  );
  return null;
}

export async function runTextCanonicalizer(
  prompt: string,
  apiKey: string,
): Promise<CanonicalizerModelResult | null> {
  for (const model of TEXT_MODELS) {
    console.log(`[canonicalizer] Trying text ${model}...`);
    const result = await callCanonicalizerOpenRouter(
      model,
      [
        { role: "system", content: SYSTEM_MSG },
        { role: "user", content: prompt },
      ],
      apiKey,
    );

    if (hasCanonicalizerPayload(result)) {
      console.log(`[canonicalizer] Text success with ${model}`);
      return result;
    }
  }

  console.warn(
    `[canonicalizer] all text models failed (${TEXT_MODELS.join(", ")})`,
  );
  return null;
}

export async function runLegacyCanonicalizerFallback(
  raw: RawProductForCanonicalizer,
): Promise<ProductContext | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    console.warn("[canonicalizer] OPENROUTER_API_KEY is not set");
    return null;
  }

  if (!raw.offerId || !raw.titleCn) {
    console.warn("[canonicalizer] Missing required raw.offerId or raw.titleCn");
    return null;
  }

  const { runLegacyCanonicalizerContract } = await import('./canonicalizerLegacyContractProvider');
  const result = await runLegacyCanonicalizerContract(raw, apiKey);

  if (!hasCanonicalizerPayload(result)) {
    if (process.env.PRODUCT_CANONICALIZER_SAFE_FALLBACK === "1") {
      const fallback = buildFallbackContext(raw);
      console.warn(
        `[canonicalizer] all models failed, using safe fallback for ${raw.offerId}`,
      );
      return fallback;
    }

    console.warn(`[canonicalizer] all models failed for ${raw.offerId}`);
    return null;
  }

  const ctx = normalizeCanonicalizerContext(raw, result);

  if (!hasUsableCanonicalizerContext(ctx)) {
    if (process.env.PRODUCT_CANONICALIZER_SAFE_FALLBACK === "1") {
      const fallback = buildFallbackContext(raw);
      console.warn(
        `[canonicalizer] unusable model result, using safe fallback for ${raw.offerId}`,
      );
      return fallback;
    }

    console.warn(`[canonicalizer] unusable model result for ${raw.offerId}`);
    return null;
  }

  console.log(
    `[canonicalizer] ${ctx.titles.shortRu || ctx.identity.productType} | ` +
      `cat: ${ctx.identity.categoryType} | quality: ${ctx.dataQuality.score}/10`,
  );

  return ctx;
}

// Legacy compatibility entrypoint.
// Основной путь в пайплайне уже должен идти через role-based orchestration,
// а этот вызов остаётся как аварийный fallback для старых мест интеграции.
export async function canonicalizeProduct(
  raw: RawProductForCanonicalizer,
): Promise<ProductContext | null> {
  return runLegacyCanonicalizerFallback(raw);
}

import type { ProductContext } from "../types";

type ProductIntelligenceImageInput = { url: string; role?: string; note?: string };

type RawProductForCanonicalizer = {
  offerId: string;
  titleCn: string;
  titleRu?: string;
  titleEn?: string;
  categoryName?: string;
  attributes?: Array<{ name: string; value: string }>;
  skus?: Array<{ id?: string; skuId?: string; name: string; price?: number; stock?: number; image?: string }>;
  normalizedSkuTable?: Array<{ id?: string; label: string; priceYuan?: number; stock?: number; image?: string }>;
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

type CanonicalizerModelResult = Partial<ProductContext> & {
  identity?: Partial<ProductContext["identity"]>;
  titles?: Partial<ProductContext["titles"]>;
  facts?: Record<string, unknown>;
  sku?: Partial<ProductContext["sku"]>;
  price?: Partial<ProductContext["price"]>;
  conflicts?: unknown;
  missingCritical?: unknown;
  wbSearch?: Partial<ProductContext["wbSearch"]>;
  seoPolicy?: Partial<ProductContext["seoPolicy"]>;
  supplierQuestions?: Partial<ProductContext["supplierQuestions"]>;
  riskTags?: unknown;
  dataQuality?: Partial<ProductContext["dataQuality"]>;
  procurementProfile?: Record<string, unknown>;
  productProcurementProfile?: Record<string, unknown>;
  productKindClassifier?: Record<string, unknown>;
};

const DEFAULT_MULTIMODAL_MODELS = [
  "qwen/qwen3.7-plus",
  "google/gemini-2.5-flash-lite",
  "stepfun/step-3.7-flash",
];

const DEFAULT_TEXT_MODELS = [
  "deepseek/deepseek-v4-pro",
  "qwen/qwen3.7-plus",
  "minimax/minimax-m2.7",
];

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_IMAGE_TIMEOUT_MS = 7_000;
const DEFAULT_MAX_IMAGE_BYTES = 1_200_000;
const DEFAULT_MAX_TOKENS = 5500;
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

const MULTIMODAL_MODELS = getEnvList(
  "PRODUCT_CANONICALIZER_MULTIMODAL_MODELS",
  DEFAULT_MULTIMODAL_MODELS,
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


function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
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

  return {
    offerId: raw.offerId,
    identity: {
      productType: raw.titleRu || raw.titleEn || raw.titleCn,
      coreObject: raw.titleRu || raw.titleEn || raw.titleCn,
      categoryType: "other",
      domainKind: "unknown_product",
      useCases: [],
      notThis: [],
      audience: "",
      season: "не применимо",
      gender: "унисекс",
    },
    titles: {
      titleCn: raw.titleCn,
      cleanRu: raw.titleRu ?? raw.titleEn ?? "",
      shortRu: raw.titleRu ?? raw.titleEn ?? "",
      wbTitleDraft: raw.titleRu ?? raw.titleEn ?? "",
    },
    facts: normalizeFacts(
      Object.fromEntries(
        (raw.attributes ?? [])
          .slice(0, 20)
          .map((attr) => [attr.name, attr.value]),
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
  if (raw.selectedSkuName) lines.push(`Выбранный SKU: ${raw.selectedSkuName}${isPositiveNumber(raw.selectedSkuPriceYuan) ? ` — ${raw.selectedSkuPriceYuan} ¥` : ''}`);
  if (raw.selectedSkuId) lines.push(`selectedSkuId из URL/API: ${raw.selectedSkuId}`);
  if (isPositiveNumber(raw.moq)) lines.push(`MOQ: ${raw.moq} шт`);
  if (raw.supplierType || raw.supplierName || raw.supplierRating || raw.orders) {
    lines.push(`Поставщик: type=${raw.supplierType ?? 'unknown'}; name=${raw.supplierName ?? '—'}; rating=${raw.supplierRating ?? '—'}; orders=${raw.orders ?? raw.sold ?? '—'}`);
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
  if (typeof raw.stock === "number") lines.push(`Остаток: ${raw.stock}`);

  if (raw.attributes?.length) {
    lines.push("Атрибуты поставщика:");
    raw.attributes.slice(0, 30).forEach((attr) => {
      lines.push(`- ${attr.name}: ${attr.value}`);
    });
  }

  if (raw.imageUrls?.length) {
    lines.push('Фото для Product Intelligence:');
    raw.imageUrls.slice(0, 3).forEach((img) => lines.push(`- ${img.role ?? 'image'}: ${img.url}`));
  }

  if (raw.normalizedSkuTable?.length) {
    lines.push(`Normalized SKU table (${raw.normalizedSkuTable.length}):`);
    raw.normalizedSkuTable.slice(0, 20).forEach((sku) => {
      const price = isPositiveNumber(sku.priceYuan) ? `${sku.priceYuan} ¥` : 'цена не указана';
      const stock = typeof sku.stock === 'number' ? `остаток: ${sku.stock}` : 'остаток неизвестен';
      lines.push(`- ${sku.label} — ${price}, ${stock}${sku.id ? `, id=${sku.id}` : ''}`);
    });
  }

  if (raw.skus?.length) {
    lines.push(`SKU (${raw.skus.length}):`);
    raw.skus.slice(0, 20).forEach((sku) => {
      const price = isPositiveNumber(sku.price)
        ? `${sku.price} ¥`
        : "цена не указана";
      const stock =
        typeof sku.stock === "number"
          ? `остаток: ${sku.stock}`
          : "остаток неизвестен";
      lines.push(`- ${sku.name} — ${price}, ${stock}`);
    });
  }

  return lines.join("\n");
}

const CANONICALIZER_PROMPT = `CardZip Product Canonicalizer.

Роль: старший закупщик + product intelligence для 1688/Taobao/Tmall. Цель — за один multimodal-запрос понять реальный тип товара по фото + названию + характеристикам + SKU и собрать НЕ пресный, а товарно-специфичный профиль для закупочного пакета: Telegram-отчёт, вопросы поставщику, ТЗ байеру, ТЗ карго, чек-лист образца и безопасный SEO-черновик.

Главное: товар может быть любым. Не опирайся на фиксированный список категорий. Сначала пойми домен товара и профессиональные параметры именно этой ниши, затем сформируй правила закупки под этот домен.

Верни СТРОГО JSON без markdown:
{
  "identity": {
    "productType": "точный тип товара по-русски, без маркетинга",
    "coreObject": "базовый объект без рекламных слов",
    "categoryType": "shoes|clothes|electronics|home|beauty|accessory|kitchen|fishing|tools|other",
    "domainKind": "свободный snake_case домен товара, не enum; например смысловой домен, который ты вывел из данных",
    "useCases": ["реальные сценарии применения"],
    "notThis": ["чем товар НЕ является, если есть риск путаницы"],
    "audience": "мужской|женский|унисекс|детский|неизвестно",
    "season": "лето|зима|демисезон|всесезон|не применимо|неизвестно",
    "gender": "мужской|женский|унисекс|детский|неизвестно"
  },
  "titles": {
    "titleCn": "CN название без мусора",
    "cleanRu": "чистое русское название",
    "shortRu": "2-5 слов",
    "wbTitleDraft": "черновое название маркетплейса без неподтверждённых claims"
  },
  "facts": {"параметр":"переведённое значение + статус, если нужно подтвердить"},
  "sku": {
    "hasMultipleSku": true,
    "skuCount": 0,
    "knownOptions": ["модель/версия/цвет/размер/комплектация в терминах домена"],
    "needsSelection": true
  },
  "price": {
    "visiblePriceCny": null,
    "minPriceCny": null,
    "maxPriceCny": null,
    "source": "visible_1688_price|sku_price|sku_range|discount_tier_price|discount_tier_range|unknown",
    "needsConfirmation": true
  },
  "conflicts": [{"field":"...","problem":"...","severity":"low|medium|high","action":"..."}],
  "missingCritical": ["что мешает закупке/карго/SEO"],
  "wbSearch": {
    "coreQuery": "1-4 слова",
    "queryLadder": ["точный", "синоним", "шире"],
    "mustInclude": [],
    "mustExclude": [],
    "directMatchRules": [],
    "rejectRules": []
  },
  "seoPolicy": {
    "allowedClaims": ["только безопасные утверждения из данных/фото"],
    "forbiddenClaims": ["что нельзя писать как факт без документов/образца"]
  },
  "supplierQuestions": {
    "ru": ["конкретный вопрос поставщику по этому товару"],
    "cn": []
  },
  "riskTags": ["только реальные бизнес-риски; не теги категории"],
  "dataQuality": {"score": 1, "status": "reliable|working_hypothesis|draft", "explanation": "..."},
  "productKindClassifier": {
    "visionKind": "видимый тип товара или null",
    "textKind": "тип по названию/SKU/атрибутам или null",
    "finalKind": "лучший тип товара",
    "domainKind": "свободный snake_case домен товара",
    "confidence": 0.0,
    "visualEvidence": ["что видно на фото"],
    "textEvidence": ["что подтверждено названием/SKU/атрибутами"],
    "disagreement": false
  },
  "procurementProfile": {
    "identity": {
      "productKind": "свободный домен товара, не enum",
      "domainKind": "тот же домен snake_case",
      "categoryType": "...", "subCategoryType": "...", "titleForReport": "...", "titleForSeo": "...", "shortTitle": "...", "coreObject": "...", "formFactor": "...", "audience": "...", "gender": "...", "season": "...",
      "useCases": [], "materials": [], "visibleFeatures": [], "claimedFeatures": [], "unconfirmedFeatures": []
    },
    "domainRules": {
      "buyerMustCheck": ["7-10 пунктов, которые байер/селлер должен спросить или подтвердить именно для этого типа товара"],
      "sampleMustCheck": ["8-12 проверок образца именно для этого типа товара"],
      "cargoMustAsk": ["6-10 вопросов карго/поставщику по упаковке, весу, ограничениям и специфике перевозки"],
      "seoAllowedClaims": ["что можно писать только если это видно/дано/подтверждено"],
      "seoForbiddenClaims": ["что нельзя писать без документов/теста/сертификата"],
      "redFlags": ["реальные закупочные красные флаги, не теги категории"],
      "verdictTemplate": "вывод закупщика: можно ли идти к образцу, что сначала подтвердить, почему партию рано/можно",
      "forbiddenOtherCategoryTerms": ["слова/темы из чужих категорий, которые нельзя допускать в документах"],
      "confidence": "high|medium|low",
      "evidence": ["почему выбраны именно эти правила"]
    },
    "procurement": {"mustAskSupplier": [], "mustCheckBeforeSample": [], "mustCheckOnSample": [], "redFlags": []},
    "cargo": {"mustAsk": [], "likelySensitiveCargoIssues": []},
    "content": {"seoAllowedClaims": [], "seoForbiddenClaims": [], "infographicIdeas": []}
  }
}

Правила вывода:
- Не используй product-specific hardcode. Не подставляй шаблоны из известных товаров. Выводи domainRules из текущего фото, названия, SKU, характеристик и атрибутов.
- Если домен понятен, domainRules должны быть специфичными. Не заполняй их универсальными фразами вроде “уточнить характеристики”, “проверить качество”, “электроника”, “USB устройство”. У каждого пункта должен быть параметр, проверка, документ, совместимость, комплектность или измерение, относящиеся к данному товару.
- В buyerMustCheck обязательно включи: цену выбранного SKU, вес с упаковкой, габариты упаковки, комплектацию, реальные фото/видео, документы/сертификаты если для домена есть риск, и специфичные параметры товара. Но формулируй это не общо, а в терминах домена.
- В sampleMustCheck включай действия, которые реально делают с образцом: измерить, включить, примерить, сканировать/резать/мыть/нагревать/открывать/закрывать/тянуть/собирать — в зависимости от товара.
- В cargoMustAsk включай упаковку, вес/габариты, короб, ограничения перевозки, батареи/жидкости/магниты/стекло/электронику/острые части только если это релевантно конкретному товару.
- SKU переводи смыслово в терминах домена. Не переводи буквально технические стандарты, коды, модели, размеры, интерфейсы и аббревиатуры; сохраняй их как в исходнике. Если значение SKU похоже на модель/версию/комплектацию — называй это моделью/версией/комплектацией, а не “параметром SKU”.
- Не включай marketing/quality слова в selected SKU как будто это технический параметр. Если слово означает уровень/позиционирование продавца, вынеси его в unconfirmedFeatures или redFlags, но не в имя выбранного SKU.
- Не добавляй возможности, которых нет в выбранном SKU. Если SKU проводной — не пиши про беспроводное соединение/аккумулятор/Bluetooth. Если SKU без батареи — не пиши про аккумулятор. Если SKU без размера — не придумывай размер.
- Фото используй обязательно, если оно передано: сначала определи видимый тип товара, форму, материал/текстуру, комплектацию, упаковку, видимые маркировки и опасные claims. Если передано selected_sku_image — оно важнее main_product_image. Не извлекай с фото цену, вес, MOQ, остатки или SKU. Цена, MOQ, supplier и selected SKU берутся только из provider/API данных.
- selectedSkuName/selectedSkuId/selectedSkuPriceYuan являются обязательным контекстом: не противоречь им. Если selected SKU ненадёжен или конфликтует, укажи это в dataQuality/conflicts, но не придумывай другой SKU.
- productKindClassifier: сначала классифицируй товар по фото, потом сверяй с названием/SKU/атрибутами, затем выведи finalKind/domainKind и confidence. Если фото и текст конфликтуют — не выбирай наугад: снизь confidence, опиши disagreement и сделай документы осторожными.
- SupplierQuestions.ru и procurementProfile.domainRules.buyerMustCheck должны быть согласованы по смыслу, но без дублей внутри каждого списка. Китайский перевод отдельно сделает другой слой, здесь cn можно оставить пустым.
- seoAllowedClaims — только то, что можно написать как осторожный черновик. seoForbiddenClaims — всё, что нельзя писать без сертификата, теста образца или ответа поставщика.
- dataQuality.score 1-10: снижай за отсутствие веса, SKU selection, цены, фото, упаковки, документов и противоречия.
`;

const SYSTEM_MSG =
  "Ты Product Canonicalizer. Отвечай только валидным JSON-объектом. Без markdown. Без пояснений.";

async function fetchImageAsDataUrl(url: string): Promise<string | null> {
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

async function callOpenRouter(
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

    if (!parsed?.identity) {
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

function buildPrompt(raw: RawProductForCanonicalizer): string {
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

function normalizeContext(
  raw: RawProductForCanonicalizer,
  result: CanonicalizerModelResult,
): ProductContext {
  const identity = (result.identity ?? {}) as Record<string, any>;
  const titles = (result.titles ?? {}) as Record<string, any>;
  const wbSearch = (result.wbSearch ?? {}) as Record<string, any>;
  const seoPolicy = (result.seoPolicy ?? {}) as Record<string, any>;
  const supplierQuestions = (result.supplierQuestions ?? {}) as Record<
    string,
    any
  >;
  const dataQuality = (result.dataQuality ?? {}) as Record<string, any>;

  const productType = safeRu(
    identity.productType,
    raw.titleRu ?? raw.titleEn ?? raw.titleCn,
  );
  const coreObject = safeRu(identity.coreObject, productType);
  const cleanRu = safeRu(titles.cleanRu, raw.titleRu ?? productType);
  const shortRu = safeRu(titles.shortRu, coreObject);
  const wbTitleDraft = safeRu(titles.wbTitleDraft, cleanRu);

  const ruQuestions = uniqueStrings(supplierQuestions.ru, 10);
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
      categoryType: normalizeCategoryType(identity.categoryType),
      domainKind: safeString(identity.domainKind || record(result.productKindClassifier).domainKind || record(result.productKindClassifier).finalKind || "").replace(/[^a-z0-9_]+/gi, "_").replace(/^_+|_+$/g, "").toLowerCase() || undefined,
      useCases: uniqueStrings(identity.useCases, 10)
        .map((value) => stripChineseFromRussianField(value))
        .filter(Boolean),
      notThis: uniqueStrings(identity.notThis, 10)
        .map((value) => stripChineseFromRussianField(value))
        .filter(Boolean),
      audience: safeRu(identity.audience, "неизвестно"),
      season: safeRu(identity.season, "неизвестно"),
      gender: safeRu(identity.gender, "неизвестно"),
    },
    titles: {
      titleCn: safeString(titles.titleCn, raw.titleCn),
      cleanRu,
      shortRu,
      wbTitleDraft,
    },
    facts: normalizeFacts(result.facts),
    sku: mergeSku(raw, result.sku),
    price: mergePrice(raw, result.price),
    conflicts: normalizeConflicts(result.conflicts),
    missingCritical: uniqueStrings(result.missingCritical, 15)
      .map((value) => stripChineseFromRussianField(value))
      .filter(Boolean),
    wbSearch: {
      coreQuery: safeRu(wbSearch.coreQuery, shortRu).slice(0, 80),
      queryLadder: uniqueStrings(wbSearch.queryLadder, 8)
        .map((value) => stripChineseFromRussianField(value))
        .filter(Boolean),
      mustInclude: uniqueStrings(wbSearch.mustInclude, 8)
        .map((value) => stripChineseFromRussianField(value))
        .filter(Boolean),
      mustExclude: uniqueStrings(wbSearch.mustExclude, 12)
        .map((value) => stripChineseFromRussianField(value))
        .filter(Boolean),
      directMatchRules: uniqueStrings(wbSearch.directMatchRules, 10)
        .map((value) => stripChineseFromRussianField(value))
        .filter(Boolean),
      rejectRules: uniqueStrings(wbSearch.rejectRules, 12)
        .map((value) => stripChineseFromRussianField(value))
        .filter(Boolean),
    },
    seoPolicy: {
      allowedClaims: uniqueStrings(seoPolicy.allowedClaims, 12)
        .map((value) => stripChineseFromRussianField(value))
        .filter(Boolean),
      forbiddenClaims: uniqueStrings(seoPolicy.forbiddenClaims, 20)
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

  const profileDraft = result.procurementProfile ?? result.productProcurementProfile;
  if (profileDraft && typeof profileDraft === "object") ctx.procurementProfileDraft = profileDraft;
  if (result.productKindClassifier && typeof result.productKindClassifier === "object") ctx.productKindClassifier = result.productKindClassifier;

  return ctx as ProductContext;
}

function hasUsableContext(ctx: ProductContext): boolean {
  return Boolean(
    ctx.identity.productType &&
    ctx.identity.coreObject &&
    ctx.titles.cleanRu &&
    ctx.wbSearch.coreQuery,
  );
}

async function runMultimodalCanonicalizer(
  prompt: string,
  imageUrls: string[],
  apiKey: string,
): Promise<CanonicalizerModelResult | null> {
  const mode = (process.env.PRODUCT_CANONICALIZER_IMAGE_MODE ?? "remote").toLowerCase();

  for (const model of MULTIMODAL_MODELS) {
    console.log(`[canonicalizer] Trying multimodal ${model}...`);
    let modelImageUrls = imageUrls.slice(0, 4);

    // Some OpenRouter vision routes reject base64 data URLs. Default is remote URLs so
    // qwen/stepfun are tried for real instead of silently falling through to Gemini.
    if (mode === "data_url") {
      const dataUrls: string[] = [];
      for (const url of modelImageUrls) {
        const imageDataUrl = await fetchImageAsDataUrl(url);
        if (imageDataUrl) dataUrls.push(imageDataUrl);
      }
      modelImageUrls = dataUrls;
    }

    if (!modelImageUrls.length) continue;

    const result = await callOpenRouter(
      model,
      [
        { role: "system", content: SYSTEM_MSG },
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            ...modelImageUrls.map((url) => ({ type: "image_url" as const, image_url: { url } })),
          ],
        },
      ],
      apiKey,
    );

    if (result?.identity) {
      console.log(`[canonicalizer] Multimodal success with ${model}`);
      return result;
    }
  }

  return null;
}

async function runTextCanonicalizer(
  prompt: string,
  apiKey: string,
): Promise<CanonicalizerModelResult | null> {
  for (const model of TEXT_MODELS) {
    console.log(`[canonicalizer] Trying text ${model}...`);
    const result = await callOpenRouter(
      model,
      [
        { role: "system", content: SYSTEM_MSG },
        { role: "user", content: prompt },
      ],
      apiKey,
    );

    if (result?.identity) {
      console.log(`[canonicalizer] Text success with ${model}`);
      return result;
    }
  }

  return null;
}

export async function canonicalizeProduct(
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

  const prompt = buildPrompt(raw);
  let result: CanonicalizerModelResult | null = null;

  const imageSources = [
    ...(raw.imageUrls ?? []).map((img) => img.url).filter(Boolean),
    raw.selectedSkuImage,
    raw.mainImageUrl,
  ].filter(Boolean) as string[];
  const uniqueImageUrls = Array.from(new Set(imageSources)).slice(0, 4);
  if (uniqueImageUrls.length) {
    result = await runMultimodalCanonicalizer(prompt, uniqueImageUrls, apiKey);
  }

  if (!result?.identity) {
    result = await runTextCanonicalizer(prompt, apiKey);
  }

  if (!result?.identity) {
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

  const ctx = normalizeContext(raw, result);

  if (!hasUsableContext(ctx)) {
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

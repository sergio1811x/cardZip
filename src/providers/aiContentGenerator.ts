import { z } from "zod";
import type {
  AiContentGenerator,
  AiContentRequest,
  AiContentResult,
} from "../types";
import {
  getCategoryRules,
  detectCategoryFromAttributes,
  type ProductCategoryType,
} from "../core/categoryRules";
import { validateSeoContent } from "../core/reportValidator";
import { normalizeMixedProductText } from "../core/cnNormalize";

/**
 * Safe SEO generator for WB/Ozon drafts.
 *
 * Key principles:
 * - numbers are not invented by LLM;
 * - missing/zero values are rendered as "—" / "уточняется", never as 0;
 * - all public text is sanitized after the model response;
 * - model list is configurable through AI_TEXT_MODELS to avoid hard-coded stale OpenRouter slugs;
 * - fallback output is safe enough to show to a user.
 */

const DEFAULT_OPENROUTER_MODELS = [
  // Keep these cheap/fast by default. Override via AI_TEXT_MODELS in production.
  process.env.AI_TEXT_PRIMARY_MODEL ?? "deepseek/deepseek-chat-v3.1",
  process.env.AI_TEXT_FALLBACK_MODEL_1 ?? "qwen/qwen3-32b",
  process.env.AI_TEXT_FALLBACK_MODEL_2 ?? "google/gemini-2.5-flash-lite",
  process.env.AI_TEXT_FALLBACK_MODEL_3 ?? "z-ai/glm-4.5-air",
].filter(Boolean);

function getModelChain(): string[] {
  const fromEnv = process.env.AI_TEXT_MODELS?.split(",")
    .map((m) => m.trim())
    .filter(Boolean);

  return fromEnv?.length ? fromEnv : DEFAULT_OPENROUTER_MODELS;
}

const JsonStringArray = z.preprocess(
  (value) => {
    if (Array.isArray(value)) return value;
    if (typeof value === "string" && value.trim()) return [value.trim()];
    return [];
  },
  z.array(z.string().trim().min(1)).max(20),
);

const AiResponseSchema = z.object({
  titleRu: z.string().trim().min(8).max(150),
  titleRuBranded: z.string().trim().max(150).optional(),
  description: z.string().trim().min(30).max(3000),
  bullets: JsonStringArray,
  keywords: JsonStringArray,
  characteristics: z
    .record(z.union([z.string(), z.number(), z.boolean()]).transform(String))
    .default({}),
  filterKeywords: z
    .object({
      required: JsonStringArray,
      optional: JsonStringArray,
      exclude: JsonStringArray,
    })
    .optional(),
  searchQueries: JsonStringArray.optional(),
  warnings: JsonStringArray.optional(),
  supplierQuestions: z
    .object({
      ru: JsonStringArray,
      cn: JsonStringArray,
    })
    .optional(),
});

const BANNED_CLAIMS = [
  "тихий",
  "бесшумный",
  "безопасный",
  "антибактериальный",
  "гипоаллергенный",
  "сертифицированный",
  "лечебный",
  "экологичный",
  "премиальный",
  "для детей",
  "гарантия качества",
  "долговечный",
  "безвредный",
  "натуральный",
  "органический",
  "идеальный",
  "трендовый",
  "лучший",
];

const RAW_DEBUG_TOKENS = ["undefined", "null", "NaN"];
const CJK_RE = /[\u3400-\u9FFF]/;
const MULTISPACE_RE = /\s{2,}/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function formatCny(value: unknown): string {
  if (!isFinitePositiveNumber(value)) return "—";
  const rounded = Math.round(value * 100) / 100;
  return `${rounded.toLocaleString("ru-RU")} ¥`;
}

function formatMoq(value: unknown): string {
  if (!isFinitePositiveNumber(value)) return "уточняется";
  return `${Math.round(value).toLocaleString("ru-RU")} шт.`;
}

function formatWeightKg(value: unknown): string {
  if (!isFinitePositiveNumber(value)) return "уточняется";
  return `${value.toFixed(2)} кг`;
}

function cleanText(text: string): string {
  let cleaned = text;
  for (const token of RAW_DEBUG_TOKENS) {
    cleaned = cleaned.replace(new RegExp(escapeRegExp(token), "gi"), "—");
  }

  return cleaned
    .replace(/0\s*¥/gi, "—")
    .replace(/0\s*кг/gi, "—")
    .replace(/\s+([,.!?:;])/g, "$1")
    .replace(MULTISPACE_RE, " ")
    .trim();
}

function softenBannedClaims(
  text: string,
  confirmed: string[],
  allowCautious = false,
): string {
  let result = cleanText(text);
  const confirmedLower = confirmed.map((c) => c.toLowerCase());

  const replacements: Array<[RegExp, string]> = [
    [
      /антибактериальн\w*/giu,
      "заявленное антибактериальное свойство — подтвердить",
    ],
    [/гипоаллергенн\w*/giu, "гипоаллергенность — подтвердить документами"],
    [
      /сертифицированн\w*|сертификат\s+есть/giu,
      "сертификацию нужно подтвердить",
    ],
    [
      /безопасн\w*|безвредн\w*/giu,
      "безопасность нужно подтвердить документами/составом",
    ],
    [
      /лечебн\w*|ортопедическ\w*/giu,
      "лечебные/ортопедические свойства — только при документах",
    ],
    [
      /экологичн\w*|органическ\w*|натуральн\w*/giu,
      "состав/экологичность нужно подтвердить",
    ],
    [
      /премиальн\w*|лучший|идеальн\w*|топовый|гарантия\s+качества/giu,
      "класс качества без подтверждения",
    ],
  ];

  for (const [pattern, replacement] of replacements) {
    pattern.lastIndex = 0;
    if (!pattern.test(result)) continue;
    const source = pattern.source.toLowerCase();
    if (confirmedLower.some((c) => new RegExp(pattern.source, "iu").test(c)))
      continue;
    result = result.replace(pattern, allowCautious ? replacement : "");
  }

  // Keep a generic fallback for any remaining high-risk advertising words.
  for (const claim of BANNED_CLAIMS) {
    if (confirmedLower.some((c) => c.includes(claim))) continue;
    const re = new RegExp(
      `(^|[^а-яёa-z0-9])${escapeRegExp(claim)}(?:ая|ый|ое|ие|ой|ого|ому|ым|ыми|ых)?(?=$|[^а-яёa-z0-9])`,
      "giu",
    );
    if (!allowCautious) result = result.replace(re, "$1");
  }

  return cleanText(result);
}

function removeChinesePublicText(text: string): string {
  if (!CJK_RE.test(text)) return text;
  return text
    .replace(/[\u3400-\u9FFF]+/g, "")
    .replace(MULTISPACE_RE, " ")
    .trim();
}

function uniqClean(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const value of values) {
    const cleaned = removeChinesePublicText(cleanText(value));
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= limit) break;
  }

  return out;
}

function getCategoryType(req: AiContentRequest): ProductCategoryType {
  return (
    (req.categoryType as ProductCategoryType) ??
    detectCategoryFromAttributes(
      req.categoryName,
      req.attributes ?? [],
      req.titleCn,
    )
  );
}

function buildDefaultSupplierQuestions(
  req: AiContentRequest,
): NonNullable<AiContentResult["supplierQuestions"]> {
  const ru: string[] = ["1. Можно ли заказать образец этого товара?"];
  const cn: string[] = [
    "您好，我想采购这个产品，请问：",
    "1. 可以先订样品吗？",
  ];

  if (
    !isFinitePositiveNumber(req.priceYuan) ||
    req.missingFields?.some((f) => /цена|sku/i.test(f))
  ) {
    ru.push(
      "2. Подтвердите цену выбранного SKU и цену партии на 20/50/100 шт.",
    );
    cn.push("2. 请确认所选SKU的价格，以及20/50/100件的批发价。");
  } else if (req.platform === "1688") {
    ru.push("2. Какая цена при заказе 20/50/100 шт.?");
    cn.push("2. 订购20/50/100件分别是什么价格？");
  }

  if (
    !isFinitePositiveNumber(req.weightKg) ||
    req.missingFields?.some((f) => /вес|упаков/i.test(f))
  ) {
    ru.push("3. Какой вес и размер одной единицы с упаковкой?");
    cn.push("3. 单个产品含包装的重量和包装尺寸是多少？");
  }

  ru.push(
    "4. Можно получить реальные фото/видео товара и упаковки перед отправкой?",
  );
  cn.push("4. 发货前可以提供产品和包装的实拍图片/视频吗？");

  if (req.riskFlags?.isElectrical) {
    ru.push(
      "5. Входит ли батарейка/адаптер в комплект и есть ли сертификаты для экспорта?",
    );
    cn.push("5. 产品是否包含电池/电源适配器？是否有出口所需的认证文件？");
  }

  return { ru: ru.slice(0, 7), cn: cn.slice(0, 8) };
}

function buildFallback(req: AiContentRequest): AiContentResult {
  const title =
    removeChinesePublicText(
      req.titleEn || req.categoryName || req.titleCn || "Товар с 1688",
    ) || "Товар с 1688";
  const questions = buildDefaultSupplierQuestions(req);

  return {
    titleRu: title.slice(0, 120),
    description: [
      "Черновая карточка товара с китайской площадки.",
      `Цена поставщика: ${formatCny(req.priceYuan)}.`,
      `Минимальный заказ: ${formatMoq(req.moq)}.`,
      `Вес: ${formatWeightKg(req.weightKg)}.`,
      "Перед публикацией уточните характеристики выбранного SKU, комплектацию, вес с упаковкой и требования к сертификации.",
    ].join(" "),
    bullets: [
      "Черновое описание по данным поставщика",
      "Характеристики требуют проверки перед публикацией",
      "SKU и комплектацию нужно подтвердить",
      "Вес с упаковкой нужно уточнить",
      "Перед закупкой запросите фото товара",
    ],
    keywords: uniqClean(
      [title, req.categoryName ?? "", "товар для маркетплейса"],
      8,
    ),
    characteristics: {
      "Цена поставщика": formatCny(req.priceYuan),
      "Минимальный заказ": formatMoq(req.moq),
      Вес: formatWeightKg(req.weightKg),
    },
    filterKeywords: {
      required: uniqClean([req.categoryName ?? title], 2),
      optional: [],
      exclude: [],
    },
    searchQueries: uniqClean([title, req.categoryName ?? ""], 3),
    warnings: [
      "Fallback-описание: данные нужно проверить вручную перед публикацией.",
    ],
    supplierQuestions: questions,
    isFallback: true,
  };
}

function buildProductInfo(req: AiContentRequest): string {
  const lines: string[] = [`- Название (кит.): ${req.titleCn || "—"}`];
  if (req.titleEn) lines.push(`- Название (англ.): ${req.titleEn}`);
  if (req.categoryName) lines.push(`- Категория: ${req.categoryName}`);
  lines.push(`- Цена: ${formatCny(req.priceYuan)}`);
  lines.push(`- Минимальный заказ: ${formatMoq(req.moq)}`);
  lines.push(`- Вес: ${formatWeightKg(req.weightKg)}`);
  if (req.supplierName)
    lines.push(
      `- Поставщик: ${req.supplierName}${req.supplierRating ? ` (рейтинг: ${req.supplierRating})` : ""}`,
    );
  if (req.brand) lines.push(`- Бренд поставщика: ${req.brand}`);
  if (req.model) lines.push(`- Модель: ${req.model}`);

  if (req.confirmedFeatures?.length) {
    lines.push("", "Подтверждённые свойства товара:");
    req.confirmedFeatures
      .slice(0, 30)
      .forEach((feature) => lines.push(`- ${feature}`));
  }

  if (req.missingFields?.length) {
    lines.push("", "Отсутствующие данные (нельзя упоминать как факт):");
    req.missingFields.slice(0, 30).forEach((field) => lines.push(`- ${field}`));
  }

  if (req.attributes?.length) {
    lines.push("", "Характеристики от поставщика:");
    req.attributes.slice(0, 25).forEach((attribute) => {
      lines.push(`- ${attribute.name}: ${attribute.value}`);
    });
  }

  if (req.description) {
    lines.push("", `Описание от поставщика:\n${req.description.slice(0, 700)}`);
  }

  return lines.join("\n");
}

function buildPrompt(req: AiContentRequest): string {
  const catType = getCategoryType(req);
  const catRules = getCategoryRules(catType);
  const productInfo = buildProductInfo(req);

  const brandBlock = req.brand
    ? `\nБРЕНД:\n- В titleRu НЕ включай бренд "${req.brand}".\n- В titleRuBranded можно указать справочное обозначение поставщика: "${req.brand}${req.model ? ` ${req.model}` : ""}".`
    : "";

  const categoryForbidden = [
    ...catRules.forbiddenFields,
    ...catRules.seoHints.forbiddenInSeo,
  ];

  const categoryBlock = `\nКАТЕГОРИЯ ТОВАРА: ${catType}\n${categoryForbidden.length ? `ЗАПРЕЩЁННЫЕ ТЕМЫ ДЛЯ ЭТОЙ КАТЕГОРИИ:\n${categoryForbidden.map((f) => `- ${f}`).join("\n")}` : "- Нет специальных запретов категории, кроме общих safe-listing правил."}\n- НЕ используй китайские слова и транслитерацию в SEO-тексте.\n- НЕ используй складские/технические поля поставщика как преимущества.`;

  const riskBlock = req.riskFlags
    ? `\nРИСКИ:\n${req.riskFlags.isElectrical ? '- Электротовар: не писать "безопасный", не утверждать сертификаты, спросить комплектацию/питание/сертификаты.\n' : ""}${req.riskFlags.isChildren ? '- Детский товар: не писать "для детей" без подтверждения, спросить сертификацию.\n' : ""}${req.riskFlags.isCosmetic ? "- Косметика: не писать про состав/эффект без документов.\n" : ""}${req.riskFlags.isFood ? "- Пищевой товар: не писать про полезные свойства без документов.\n" : ""}${req.riskFlags.isMedical ? "- Медицинский товар: не писать про лечебные свойства.\n" : ""}`
    : "";

  const wbKeywordsBlock = req.wbTopKeywords?.length
    ? `\nОПЦИОНАЛЬНЫЕ КЛЮЧЕВЫЕ СЛОВА МАРКЕТПЛЕЙСА, если релевантны товару:\n${req.wbTopKeywords
        .slice(0, 10)
        .map((keyword) => `- ${keyword}`)
        .join("\n")}`
    : "";

  const platformContext =
    req.platform === "taobao"
      ? "Товар с Taobao. Это розничный источник, поэтому цена/партия требуют отдельного подтверждения."
      : req.platform === "tmall"
        ? "Товар с Tmall. Не использовать бренд в публичном названии без права на бренд."
        : "Товар с 1688. Это закупочная гипотеза; не обещать продажи, прибыльность или рыночный спрос.";

  const intelligence = req.intelligence;
  const intelligenceParts: string[] = [];
  if (intelligence) {
    if (intelligence.reportRules.seoAllowedClaims?.length) {
      intelligenceParts.push(
        `РАЗРЕШЁННЫЕ УТВЕРЖДЕНИЯ:\n${intelligence.reportRules.seoAllowedClaims.map((c) => `- ${c}`).join("\n")}`,
      );
    }
    if (intelligence.reportRules.seoForbiddenClaims?.length) {
      intelligenceParts.push(
        `ЗАПРЕЩЁННЫЕ УТВЕРЖДЕНИЯ:\n${intelligence.reportRules.seoForbiddenClaims.map((c) => `- ${c}`).join("\n")}`,
      );
    }
    if (intelligence.reportRules.importantAttributesToShow?.length) {
      intelligenceParts.push(
        `ВАЖНЫЕ ХАРАКТЕРИСТИКИ ДЛЯ ПОКАЗА:\n${intelligence.reportRules.importantAttributesToShow.map((c) => `- ${c}`).join("\n")}`,
      );
    }
    if (intelligence.reportRules.attributesToHide?.length) {
      intelligenceParts.push(
        `СКРЫТЬ ИЗ ПУБЛИЧНОГО ТЕКСТА:\n${intelligence.reportRules.attributesToHide.map((c) => `- ${c}`).join("\n")}`,
      );
    }
    if (intelligence.productIdentity.notConfirmedFeatures?.length) {
      intelligenceParts.push(
        `НЕПОДТВЕРЖДЁННЫЕ СВОЙСТВА:\n${intelligence.productIdentity.notConfirmedFeatures.map((c) => `- ${c}`).join("\n")}`,
      );
    }
  }

  const categoryEnding =
    catType === "clothes" || catType === "shoes"
      ? "Перед публикацией уточните размерную сетку выбранного SKU в сантиметрах и состав."
      : catType === "electronics"
        ? "Перед публикацией уточните комплектацию, питание, инструкцию и документы для продажи в РФ."
        : "Перед публикацией уточните характеристики выбранного SKU, комплектацию и документы для продажи в РФ.";

  return `${intelligenceParts.length ? `${intelligenceParts.join("\n\n")}\n\n` : ""}Ты — редактор CardZip 2.0. Сделай продающий, но безопасный SEO-черновик карточки маркетплейса: сохранить полезные факты, перевести их на русский и пометить спорное как “подтвердить”.

КОНТЕКСТ:
${platformContext}

ДАННЫЕ ТОВАРА:
${productInfo}
${brandBlock}
${riskBlock}
${wbKeywordsBlock}
${categoryBlock}

УРОВНИ ДОСТОВЕРНОСТИ:
- supplier_confirmed: можно писать как факт.
- title_inferred: можно использовать только осторожно в описании, но не как точное свойство.
- unknown: только в warnings/supplierQuestions, не в SEO.

ПРАВИЛА:
- Сохраняй полезные данные поставщика: переводи характеристики, SKU, особенности и ограничения.
- Если свойство заявлено поставщиком, но не доказано документами, НЕ удаляй его: пиши осторожно как “заявлено поставщиком / подтвердить”.
- Не придумывай назначение, материал, водонепроницаемость, сертификаты, качество, безопасность, размер, комплектацию.
- Не используй бренд поставщика в titleRu, keywords и characteristics.
- Не пиши OEM/фабрика/производитель, если это не подтверждено.
- Не используй китайские слова, транслитерацию и raw-значения в публичном SEO.
- Не используй рекламные слова: лучший, идеальный, трендовый, премиальный.
- Если данных нет, добавь это в warnings или supplierQuestions.

ЗАДАЧИ:
1. titleRu — название карточки до 120 символов. Только категория + подтверждённые важные свойства. Без бренда, OEM и рекламных слов.
${req.brand ? "2. titleRuBranded — справочное обозначение поставщика, не для публичной карточки." : ""}
3. description — описание 350-700 символов: что это, подтверждённые характеристики, комплектация/назначение если известно. Последняя фраза: "${categoryEnding}"
4. bullets — ровно 5 тезисов по 5-10 слов, без эмодзи, только подтверждённые свойства.
5. keywords — 8-15 релевантных поисковых запросов без бренда и без смены типа товара.
6. characteristics — только переведённые характеристики поставщика. Не оставляй китайские ключи/значения.
7. filterKeywords — required 1-2 слова, optional 3-5 слов, exclude 3-8 слов.
8. searchQueries — 3 запроса для ручной проверки конкурентов на маркетплейсе.
9. warnings — 1-3 конкретных предупреждения. Только релевантные этому товару.
10. supplierQuestions — ru/cn, максимум 7 вопросов. Не спрашивай то, что уже известно.

Верни ТОЛЬКО валидный JSON без markdown:
{
  "titleRu": "...",${req.brand ? '\n  "titleRuBranded": "...",' : ""}
  "description": "...",
  "bullets": ["...", "...", "...", "...", "..."],
  "keywords": ["..."],
  "characteristics": {"ключ": "значение"},
  "filterKeywords": {"required": ["..."], "optional": ["..."], "exclude": ["..."]},
  "searchQueries": ["...", "...", "..."],
  "warnings": ["..."],
  "supplierQuestions": {
    "ru": ["1. ..."],
    "cn": ["您好，我想采购这个产品，请问：", "1. ..."]
  }
}`;
}

function cleanJsonResponse(raw: string): string {
  const trimmed = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);

  return trimmed;
}

const SYSTEM_MSG = [
  "Ты safe-listing редактор CardZip 2.0 для карточек маркетплейса.",
  "Отвечай только валидным JSON-объектом.",
  "Не используй Markdown, пояснения или текст вне JSON.",
  "Улучшай данные: переводи, структурируй, помечай сомнительное. Не придумывай свойства.",
].join(" ");

async function callProvider(
  baseUrl: string,
  model: string,
  prompt: string,
  apiKey: string,
  extraHeaders?: Record<string, string>,
): Promise<AiContentResult | null> {
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...extraHeaders,
      },
      body: JSON.stringify({
        model,
        max_tokens: Number(process.env.AI_TEXT_MAX_TOKENS ?? 6000),
        temperature: Number(process.env.AI_TEXT_TEMPERATURE ?? 0.25),
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_MSG },
          { role: "user", content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(
        Number(process.env.AI_TEXT_TIMEOUT_MS ?? 70_000),
      ),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[ai] ${model} HTTP ${res.status}: ${body.slice(0, 300)}`);
      return null;
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const raw = data.choices?.[0]?.message?.content ?? "";
    if (!raw.trim()) return null;

    const parsed = JSON.parse(cleanJsonResponse(raw));
    const validated = AiResponseSchema.parse(parsed);
    return validated as AiContentResult;
  } catch (e) {
    console.error(`[ai] ${model} failed:`, e instanceof Error ? e.message : e);
    return null;
  }
}

function callOpenRouter(
  model: string,
  prompt: string,
  apiKey: string,
): Promise<AiContentResult | null> {
  return callProvider("https://openrouter.ai/api/v1", model, prompt, apiKey, {
    "HTTP-Referer":
      process.env.OPENROUTER_REFERER ??
      "https://github.com/sergio1811x/cardZip",
    "X-Title": process.env.OPENROUTER_TITLE ?? "cardZip",
  });
}

const FIREWORKS_MODEL =
  process.env.FIREWORKS_TEXT_MODEL ?? "accounts/fireworks/models/deepseek-v3";

function callFireworks(prompt: string): Promise<AiContentResult | null> {
  const fwKey = process.env.FIREWORKS_API_KEY;
  if (!fwKey) return Promise.resolve(null);
  console.log("[ai] Fireworks fallback...");
  return callProvider(
    "https://api.fireworks.ai/inference/v1",
    FIREWORKS_MODEL,
    prompt,
    fwKey,
  );
}

function normalizeBullets(result: AiContentResult): void {
  const bullets = uniqClean(result.bullets ?? [], 5);
  const fallback = [
    "Подтвердите характеристики выбранного SKU",
    "Уточните комплектацию перед закупкой",
    "Проверьте вес товара с упаковкой",
    "Запросите реальные фото у поставщика",
    "Проверьте документы для продажи",
  ];

  for (const item of fallback) {
    if (bullets.length >= 5) break;
    bullets.push(item);
  }

  result.bullets = bullets.slice(0, 5);
}

function sanitizeCharacteristics(result: AiContentResult): void {
  const cleaned: Record<string, string> = {};

  for (const [key, value] of Object.entries(result.characteristics ?? {})) {
    const safeKey = removeChinesePublicText(cleanText(key));
    const safeValue = removeChinesePublicText(cleanText(String(value)));
    if (!safeKey || !safeValue) continue;
    if (CJK_RE.test(safeKey) || CJK_RE.test(safeValue)) continue;
    cleaned[safeKey] = safeValue;
  }

  result.characteristics = cleaned;
}

function removeBrandFromPublicFields(
  result: AiContentResult,
  req: AiContentRequest,
): void {
  const brand = req.brand?.trim();
  if (!brand) return;

  const re = new RegExp(escapeRegExp(brand), "gi");
  result.titleRu = cleanText(result.titleRu.replace(re, ""));
  result.keywords = (result.keywords ?? [])
    .map((keyword) => cleanText(keyword.replace(re, "")))
    .filter(Boolean);

  for (const key of Object.keys(result.characteristics ?? {})) {
    if (re.test(key)) delete result.characteristics[key];
  }
}

function postProcess(
  result: AiContentResult,
  req: AiContentRequest,
): AiContentResult {
  const confirmed = req.confirmedFeatures ?? [];

  result.titleRu = removeChinesePublicText(
    softenBannedClaims(result.titleRu, confirmed, false),
  ).slice(0, 120);
  if (result.titleRuBranded)
    result.titleRuBranded = cleanText(result.titleRuBranded).slice(0, 150);
  result.description = removeChinesePublicText(
    softenBannedClaims(result.description, confirmed, true),
  );
  result.bullets = (result.bullets ?? []).map((bullet) =>
    removeChinesePublicText(softenBannedClaims(bullet, confirmed, true)),
  );
  result.keywords = uniqClean(
    (result.keywords ?? []).map((keyword) =>
      softenBannedClaims(keyword, confirmed, false),
    ),
    15,
  );
  result.searchQueries = uniqClean(result.searchQueries ?? [], 3);
  result.warnings = uniqClean(result.warnings ?? [], 3);

  if (result.filterKeywords) {
    result.filterKeywords = {
      required: uniqClean(result.filterKeywords.required ?? [], 2),
      optional: uniqClean(result.filterKeywords.optional ?? [], 5),
      exclude: uniqClean(result.filterKeywords.exclude ?? [], 8),
    };
  }

  if (
    !result.supplierQuestions?.ru?.length ||
    !result.supplierQuestions?.cn?.length
  ) {
    result.supplierQuestions = buildDefaultSupplierQuestions(req);
  } else {
    result.supplierQuestions = {
      ru: uniqClean(result.supplierQuestions.ru, 7),
      cn: result.supplierQuestions.cn
        .slice(0, 8)
        .map(cleanText)
        .filter(Boolean),
    };
    if (!result.supplierQuestions.cn[0]?.startsWith("您好")) {
      result.supplierQuestions.cn.unshift("您好，我想采购这个产品，请问：");
    }
  }

  normalizeBullets(result);
  sanitizeCharacteristics(result);
  removeBrandFromPublicFields(result, req);

  const categoryType = getCategoryType(req);
  const seoValidation = validateSeoContent(
    result,
    categoryType,
    req.intelligence ?? null,
  );
  if (!seoValidation.ok) {
    console.warn(`[seo] Validator: ${seoValidation.errors.join(", ")}`);
    Object.assign(result, seoValidation.fixed);
  }

  return result;
}

async function generate(req: AiContentRequest): Promise<AiContentResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY не задан");

  const prompt = buildPrompt(req);
  const models = getModelChain();

  for (const model of models) {
    console.log(`[ai] Trying ${model}...`);
    const result = await callOpenRouter(model, prompt, apiKey);
    if (result) {
      console.log(`[ai] Success with ${model}`);
      return postProcess(result, req);
    }
  }

  const fwResult = await callFireworks(prompt);
  if (fwResult) {
    console.log("[ai] Success with Fireworks");
    return postProcess(fwResult, req);
  }

  console.error("[ai] All providers failed, using safe fallback");
  return postProcess(buildFallback(req), req);
}

export const aiContentGenerator: AiContentGenerator = { generate };

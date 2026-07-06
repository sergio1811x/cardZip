// Focused, independently-failing generator for the WB/Ozon SEO card.
//
// One of three small LLM generators that replace the monolithic canonicalizer
// for product-specific content. Returns null on total failure so the caller can
// keep its honest-generic floor.

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODELS = [
  "google/gemini-2.5-flash-lite",
  "google/gemini-2.5-flash",
  "deepseek/deepseek-v4-flash",
];
const DEFAULT_TIMEOUT_MS = 40_000;
const DEFAULT_MAX_TOKENS = 2000;
const DEFAULT_TEMPERATURE = 0.2;

export interface GeneratorInput {
  titleRu?: string;
  titleCn?: string;
  priceYuan?: number | null;
  attributes?: Array<{ name?: string; value?: string }>;
  skuNames?: string[];
  coreObject?: string;
  categoryType?: string;
  useCases?: string[];
  materials?: string[];
}

export interface SeoCardResult {
  title: string;
  description: string;
  bullets: string[];
  keywords: string[];
  characteristics: Array<{ name: string; value: string; status: string }>;
}

function getEnvList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  return parsed.length ? parsed : fallback;
}

function getNumberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const MODELS = getEnvList("SEO_CARD_MODELS", DEFAULT_MODELS);

function cleanJson(raw: string): string {
  return raw
    .replace(/^﻿/, "")
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
    if (depth === 0) return cleaned.slice(firstBrace, i + 1);
  }

  return null;
}

function parseObject(raw: string): Record<string, unknown> | null {
  const json = extractJsonObject(raw);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function cleanLine(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/^[-•*\d.)\s]+/, "")
    .trim();
}

function dedupCap(values: unknown, cap: number): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of values) {
    const value = cleanLine(item);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= cap) break;
  }
  return out;
}

// Enforce exactly 5 bullets: trim overflow, pad from generic-but-honest fillers
// only if the model under-delivered (kept honest — no invented specs).
function enforceFiveBullets(bullets: string[], coreObject: string): string[] {
  const out = bullets.slice(0, 5);
  const obj = coreObject.trim() || "товар";
  const fillers = [
    `Продуманный дизайн и аккуратное исполнение`,
    `Практичное решение для повседневного использования`,
    `Компактный формат — удобно хранить и брать с собой`,
    `Универсальный вариант в подарок и для себя`,
    `Несколько вариантов на выбор в карточке`,
  ];
  let i = 0;
  while (out.length < 5 && i < fillers.length) {
    const candidate = fillers[i++];
    if (!out.some((b) => b.toLowerCase() === candidate.toLowerCase())) {
      out.push(candidate);
    }
  }
  // Absolute guarantee of length 5 even if fillers collided.
  while (out.length < 5) out.push(`Практичный ${obj}`);
  return out.slice(0, 5);
}

function normalizeCharacteristics(
  value: unknown,
): Array<{ name: string; value: string; status: string }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ name: string; value: string; status: string }> = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const name = cleanLine(obj.name);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const rawValue = cleanLine(obj.value);
    const value = rawValue || "уточнить";
    const rawStatus = cleanLine(obj.status);
    const status = rawStatus || "подтвердить";
    out.push({ name, value, status });
    if (out.length >= 8) break;
  }
  return out;
}

function buildProductInfo(input: GeneratorInput): string {
  const lines: string[] = [];
  if (input.titleRu) lines.push(`Название (RU): ${input.titleRu}`);
  if (input.titleCn) lines.push(`Название (CN): ${input.titleCn}`);
  if (input.coreObject) lines.push(`Тип товара: ${input.coreObject}`);
  if (input.categoryType) lines.push(`Категория: ${input.categoryType}`);
  if (input.materials?.length)
    lines.push(`Возможные материалы (не подтверждены): ${input.materials.join(", ")}`);
  if (input.useCases?.length)
    lines.push(`Сценарии применения: ${input.useCases.join(", ")}`);
  if (input.skuNames?.length)
    lines.push(`Варианты SKU: ${input.skuNames.slice(0, 20).join(" | ")}`);
  if (input.attributes?.length) {
    lines.push("Атрибуты карточки:");
    input.attributes.slice(0, 24).forEach((a) => {
      const name = String(a?.name ?? "").trim();
      const value = String(a?.value ?? "").trim();
      if (name || value) lines.push(`- ${name}: ${value}`);
    });
  }
  return lines.join("\n") || "Данные карточки минимальны.";
}

const SYSTEM_MSG =
  "Ты SEO Card Generator. Отвечай только валидным JSON-объектом. Без markdown. Без пояснений.";

function buildPrompt(input: GeneratorInput): string {
  return `Ты SEO-редактор карточек WB/Ozon. Сначала пойми, ЧТО ИМЕННО это за товар по названию/атрибутам, и для ЭТОГО товара напиши:
- продающее название title (60–90 символов, без брендов и непроверенных claims);
- описание description: 2–4 предложения (польза + применение + материал), грамотный русский, правильные падежи, без штампа «подходит для повседневного использования» дословно;
- ровно 5 продающих буллетов bullets: выгоды/применение для ПОКУПАТЕЛЯ, НЕ «уточните у поставщика», НЕ «SKU в карточке», НЕ внутренние советы по закупке;
- 8–15 релевантных ключевых слов keywords (без дублей, без гигантского заголовка-строки);
- 4–8 характеристик characteristics как {name, value, status}: где значение неизвестно — value = "уточнить", status = "подтвердить"; где известно из данных — реальное значение и status = "из карточки".

Правила:
- Не выдумывай факты (состав в %, напряжение, нагрузку, сертификаты). Неизвестное = "уточнить".
- Не пиши как факт опасные claims: медицинский, ортопедический, антибактериальный, сертифицированный, гипоаллергенный, водонепроницаемый, UPF50+ и т.п.
- Без китайского, без placeholder «товар».

Верни строго JSON:
{"title":"...","description":"...","bullets":["..."],"keywords":["..."],"characteristics":[{"name":"...","value":"...","status":"..."}]}

ДАННЫЕ ТОВАРА:
${buildProductInfo(input)}`;
}

async function callModel(
  model: string,
  prompt: string,
  input: GeneratorInput,
  apiKey: string,
): Promise<SeoCardResult | null> {
  const timeoutMs = getNumberEnv("SEO_CARD_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const maxTokens = getNumberEnv("SEO_CARD_MAX_TOKENS", DEFAULT_MAX_TOKENS);
  const temperatureRaw = Number(process.env.SEO_CARD_TEMPERATURE);
  const temperature = Number.isFinite(temperatureRaw)
    ? temperatureRaw
    : DEFAULT_TEMPERATURE;

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
      messages: [
        { role: "system", content: SYSTEM_MSG },
        { role: "user", content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    console.warn(`[seoCard] ${model} HTTP ${res.status}`);
    return null;
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  const obj = parseObject(content);
  if (!obj) {
    console.warn(`[seoCard] ${model} returned invalid JSON`);
    return null;
  }

  const title = cleanLine(obj.title);
  const description = cleanLine(obj.description);
  const bullets = dedupCap(obj.bullets, 8);
  const keywords = dedupCap(obj.keywords, 15);
  const characteristics = normalizeCharacteristics(obj.characteristics);

  if (!title || !description || bullets.length === 0) {
    console.warn(`[seoCard] ${model} returned incomplete card`);
    return null;
  }

  return {
    title,
    description,
    bullets: enforceFiveBullets(bullets, input.coreObject ?? input.titleRu ?? ""),
    keywords,
    characteristics,
  };
}

export async function generateSeoCard(
  input: GeneratorInput,
): Promise<SeoCardResult | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.warn("[seoCard] OPENROUTER_API_KEY is not set");
    return null;
  }

  const prompt = buildPrompt(input);

  for (const model of MODELS) {
    try {
      const result = await callModel(model, prompt, input, apiKey);
      if (result) return result;
    } catch (error) {
      console.warn(
        `[seoCard] ${model} failed:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  console.warn("[seoCard] all models failed");
  return null;
}

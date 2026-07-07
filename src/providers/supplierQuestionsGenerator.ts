// Focused, independently-failing generator for supplier questions (RU).
//
// One of three small LLM generators that replace the monolithic canonicalizer
// for product-specific content. If this call times out / truncates / returns
// invalid JSON, it returns null and the caller keeps its honest-generic floor.

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODELS = [
  "google/gemini-3.1-flash-lite",
  "google/gemini-2.5-flash",
  "deepseek/deepseek-v4-pro",
];
const DEFAULT_TIMEOUT_MS = 50_000;
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

export interface SupplierQuestionsResult {
  ru: string[];
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

const MODELS = getEnvList("SUPPLIER_QUESTIONS_MODELS", DEFAULT_MODELS);

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

function cleanQuestion(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/^\d+[.)]\s*/, "")
    .trim();
}

function dedupCap(values: unknown, cap: number): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of values) {
    const value = cleanQuestion(item);
    if (!value) continue;
    const key = value.toLowerCase().replace(/[?.!]+$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= cap) break;
  }
  return out;
}

function buildProductInfo(input: GeneratorInput): string {
  const lines: string[] = [];
  if (input.titleRu) lines.push(`Название (RU): ${input.titleRu}`);
  if (input.titleCn) lines.push(`Название (CN): ${input.titleCn}`);
  if (input.coreObject) lines.push(`Тип товара: ${input.coreObject}`);
  if (input.categoryType) lines.push(`Категория: ${input.categoryType}`);
  if (typeof input.priceYuan === "number" && input.priceYuan > 0)
    lines.push(`Видимая цена: ${input.priceYuan} ¥`);
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
  "Ты Supplier Questions Generator. Отвечай только валидным JSON-объектом. Без markdown. Без пояснений.";

function buildPrompt(input: GeneratorInput): string {
  return `Ты старший закупщик 1688. Составь 8–10 конкретных вопросов поставщику под ИМЕННО этот товар — то, что профессиональный байер обязан уточнить перед закупкой (размеры/материалы/конструкция/безопасность/совместимость/комплектация), плюс цена выбранного SKU, вес с упаковкой, реальные фото.

Правила:
- Сначала пойми, ЧТО ИМЕННО это за товар по названию/атрибутам/SKU, и спрашивай про параметры, важные профессиональному закупщику именно ЭТОГО объекта.
- Не выдумывай характеристики (марку стали, HRC, напряжение, состав в %, сертификаты) — СПРАШИВАЙ их у поставщика.
- Базовые пункты (цена / вес / фото) допустимы, но не более 2–3 из списка; остальное — про суть товара.
- Грамотный русский, правильные падежи, без placeholder «товар», каждый вопрос отдельный и уникальный (без дублей).
- Никакого китайского в вопросах.
- ФОРМАТ каждого вопроса: одно грамотное предложение с корректной пунктуацией. Если перечисляешь варианты — ставь двоеточие и союз «или»; примеры давай в скобках со словом «например». НЕ склеивай варианты без знаков препинания. Один вопрос — одна тема (не объединяй несвязанные параметры в один вопрос).
  Плохо: «Какой тип заточки лезвия односторонняя/двусторонняя, угол?»
  Хорошо: «Какой тип заточки лезвия: односторонняя или двусторонняя? Под каким углом?»
  Плохо: «Каковы точные габариты ножа длина лезвия, длина рукояти, ширина лезвия?»
  Хорошо: «Укажите точные габариты: длину лезвия, длину рукояти и ширину лезвия в самой широкой части.»

Верни строго JSON {"ru": ["...", "..."]}.

ДАННЫЕ ТОВАРА:
${buildProductInfo(input)}`;
}

async function callModel(
  model: string,
  prompt: string,
  apiKey: string,
): Promise<SupplierQuestionsResult | null> {
  const timeoutMs = getNumberEnv(
    "SUPPLIER_QUESTIONS_TIMEOUT_MS",
    DEFAULT_TIMEOUT_MS,
  );
  const maxTokens = getNumberEnv(
    "SUPPLIER_QUESTIONS_MAX_TOKENS",
    DEFAULT_MAX_TOKENS,
  );
  const temperatureRaw = Number(process.env.SUPPLIER_QUESTIONS_TEMPERATURE);
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
    console.warn(`[supplierQuestions] ${model} HTTP ${res.status}`);
    return null;
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  const obj = parseObject(content);
  if (!obj) {
    console.warn(`[supplierQuestions] ${model} returned invalid JSON`);
    return null;
  }

  const ru = dedupCap(obj.ru, 10);
  if (ru.length < 4) {
    console.warn(`[supplierQuestions] ${model} returned too few questions`);
    return null;
  }

  return { ru };
}

export async function generateSupplierQuestions(
  input: GeneratorInput,
): Promise<SupplierQuestionsResult | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.warn("[supplierQuestions] OPENROUTER_API_KEY is not set");
    return null;
  }

  const prompt = buildPrompt(input);

  for (const model of MODELS) {
    try {
      const result = await callModel(model, prompt, apiKey);
      if (result) return result;
    } catch (error) {
      console.warn(
        `[supplierQuestions] ${model} failed:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  console.warn("[supplierQuestions] all models failed");
  return null;
}

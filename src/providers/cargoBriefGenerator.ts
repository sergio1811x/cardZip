// Focused, independently-failing generator for the cargo (logistics) brief.
//
// One of three small LLM generators that replace the monolithic canonicalizer
// for product-specific content. Returns null on total failure so the caller can
// keep its honest-generic floor.

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
// Для карго даём приоритет Grok, ниже — быстрые фолбэки. Override via
// CARGO_BRIEF_MODELS.
const DEFAULT_MODELS = [
  "x-ai/grok-4.3",
  "qwen/qwen3.7-plus",
  "google/gemini-2.5-flash",
  "google/gemini-3.1-flash-lite",
];
const DEFAULT_TIMEOUT_MS = 50_000;
const DEFAULT_MAX_TOKENS = 4000; // headroom so a reasoning model can't truncate JSON
const DEFAULT_TEMPERATURE = 0.2;

const CARGO_NATURES = [
  "inflatable",
  "liquid",
  "aerosol",
  "battery",
  "powder",
  "fragile",
  "oversized",
  "bladed",
  "textile",
  "food_contact",
  "none",
] as const;

type CargoNature = (typeof CARGO_NATURES)[number];

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

export interface CargoBriefResult {
  cargoNature: string;
  considerations: string[];
  whatToRequest: string[];
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

const MODELS = getEnvList("CARGO_BRIEF_MODELS", DEFAULT_MODELS);

function cleanJson(raw: string): string {
  return raw
    .replace(/^﻿/, "")
    // Reasoning models (DeepSeek) emit <think>…</think> before the JSON — strip
    // closed and truncated-unclosed blocks so parsing doesn't choke on it.
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "")
    .replace(/<think(?:ing)?>[\s\S]*$/i, "")
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
    // Repair trailing commas (`,}` / `,]`) — a common reasoning-model JSON slip.
    if (depth === 0)
      return cleaned.slice(firstBrace, i + 1).replace(/,(\s*[}\]])/g, "$1");
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

function normalizeCargoNature(value: unknown): CargoNature {
  const raw = String(value ?? "").trim().toLowerCase();
  return (CARGO_NATURES as readonly string[]).includes(raw)
    ? (raw as CargoNature)
    : "none";
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
  "Ты Cargo Brief Generator. Отвечай только валидным JSON-объектом. Без markdown. Без пояснений.";

function buildPrompt(input: GeneratorInput): string {
  return `Ты логист карго из Китая. Сначала пойми, ЧТО ИМЕННО это за товар по названию/атрибутам, затем для ЭТОГО товара:
- определи характер груза cargoNature — одно значение из списка: inflatable | liquid | aerosol | battery | powder | fragile | oversized | bladed | textile | food_contact | none;
- перечисли concrete considerations: 2–6 конкретных карго-рисков/особенностей именно для этого товара;
- перечисли whatToRequest: 4–8 дополнительных запросов к поставщику/карго именно для логистики и растаможки, сверх базовых веса и габаритов.

Правила:
- Если товар острый/режущий (bladed), с аккумулятором/батареей (battery), с жидкостью (liquid), аэрозолем (aerosol), порошком (powder), хрупкий (fragile), крупногабаритный (oversized), надувной (inflatable) или контактирует с пищей (food_contact) — скажи это прямо в cargoNature и дай соответствующие требования к упаковке/перевозке.
- Не выдумывай ограничения и сертификаты без основания. Если товар обычный — cargoNature = "none".
- considerations и whatToRequest должны быть именно ПРО ПЕРЕВОЗКУ: упаковка, защита в пути, мастер-короб, маркировка, ограничения по маршруту, таможня, подтверждение состава груза. Не пиши вопросы про потребительское качество товара.
- Не пиши банальности вроде «электроприбор с мотором», «обычный товар», «есть нагрев». Каждый пункт должен объяснять РИСК или НУЖНОЕ ДАННОЕ для логистики.
- Не дублируй одно и то же разными словами. Один пункт = одна мысль.
- Если SKU/комплектация не подтверждены, не утверждай спорную комплектацию как факт. Формулируй через риск/условие: «если кейс входит в SKU, нужны его размеры и защита от деформации».
- Грамотный русский, без китайского, без дублей, без placeholder «товар».

Верни строго JSON:
{"cargoNature":"...","considerations":["..."],"whatToRequest":["..."]}

ДАННЫЕ ТОВАРА:
${buildProductInfo(input)}`;
}

async function callModel(
  model: string,
  prompt: string,
  apiKey: string,
): Promise<CargoBriefResult | null> {
  const timeoutMs = getNumberEnv("CARGO_BRIEF_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const maxTokens = getNumberEnv("CARGO_BRIEF_MAX_TOKENS", DEFAULT_MAX_TOKENS);
  const temperatureRaw = Number(process.env.CARGO_BRIEF_TEMPERATURE);
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
      // Strict JSON + reasoning OFF: deepseek-v4-pro truncated JSON by spending the
      // budget on internal reasoning. Structured extraction, not a CoT task.
      response_format: { type: "json_object" },
      reasoning: { enabled: false },
      messages: [
        { role: "system", content: SYSTEM_MSG },
        { role: "user", content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    console.warn(`[cargoBrief] ${model} HTTP ${res.status}`);
    return null;
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  const obj = parseObject(content);
  if (!obj) {
    console.warn(`[cargoBrief] ${model} returned invalid JSON`);
    return null;
  }

  const cargoNature = normalizeCargoNature(obj.cargoNature);
  const considerations = dedupCap(obj.considerations, 10);
  const whatToRequest = dedupCap(obj.whatToRequest, 10);

  if (considerations.length === 0 && whatToRequest.length === 0) {
    console.warn(`[cargoBrief] ${model} returned empty brief`);
    return null;
  }

  return { cargoNature, considerations, whatToRequest };
}

export async function generateCargoBrief(
  input: GeneratorInput,
): Promise<CargoBriefResult | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.warn("[cargoBrief] OPENROUTER_API_KEY is not set");
    return null;
  }

  const prompt = buildPrompt(input);

  for (const model of MODELS) {
    try {
      const result = await callModel(model, prompt, apiKey);
      if (result) return result;
    } catch (error) {
      console.warn(
        `[cargoBrief] ${model} failed:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  console.warn("[cargoBrief] all models failed");
  return null;
}

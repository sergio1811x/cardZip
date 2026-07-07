// LLM document writer — turns the deterministic template draft + profile facts
// into a POLISHED, prioritized, well-grouped procurement document in живой
// русский. The deterministic builder stays as the validated fallback: if the
// writer fails, times out, or produces an invalid document, the caller keeps
// the template output. The writer may only REORGANIZE and REWRITE the facts it
// is given — it must not invent numbers, specs, certificates or categories.

import { textHasDangerousClaim } from "../core/procurementProfile";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
// Content writing is a nuance-heavy task. gemini-2.5-flash is the quality/latency
// sweet spot that actually completes on Railway (pro often times out, deepseek /
// gpt-5-mini time out entirely). Overridable via env for tuning.
const DEFAULT_MODELS = [
  "google/gemini-2.5-flash",
  "google/gemini-2.5-flash",
];
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TOKENS = 3000;
const DEFAULT_TEMPERATURE = 0.3;

export type DocType = "cargo" | "checklist";

export interface DocWriterInput {
  docType: DocType;
  titleRu: string;
  coreObject: string;
  categoryType?: string;
  productKind?: string;
  useCases: string[];
  materials: string[];
  selectedSku?: string | null;
  priceText?: string;
  sourceUrl?: string;
  supplierType?: string;
  cargoNature?: string;
  weightKnown: boolean;
  dimsKnown: boolean;
  // Raw material lists the writer must reorganize (never extend with invented facts).
  mustAskSupplier: string[];
  mustCheckBeforeSample: string[];
  mustCheckOnSample: string[];
  redFlags: string[];
  cargoWhatToRequest: string[];
  cargoConsiderations: string[];
  // The deterministic template output — the guaranteed-safe reference draft.
  draftMd: string;
}

const REQUIRED_SECTIONS: Record<DocType, string[]> = {
  cargo: [
    "## Товар",
    "## Что нужно запросить для доставки",
    "## Дополнительно по этому товару",
    "## Текущий статус",
    "## Важно",
  ],
  checklist: [
    "## До заказа образца",
    "## Какой SKU взять",
    "## Что проверить на образце",
    "## Что измерить",
    "## Какие фото сделать",
    "## Красные флаги",
    "## Решение после образца",
  ],
};

function getEnvList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = raw.split(",").map((v) => v.trim()).filter(Boolean);
  return parsed.length ? parsed : fallback;
}

function getNumberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const MODELS = getEnvList("DOC_WRITER_MODELS", DEFAULT_MODELS);

function bullets(list: string[], cap = 20): string {
  return list
    .filter(Boolean)
    .slice(0, cap)
    .map((l) => `- ${l}`)
    .join("\n");
}

function factSheet(input: DocWriterInput): string {
  const lines: string[] = [
    `Товар: ${input.titleRu}`,
    `Тип: ${input.coreObject}${input.productKind ? ` (${input.productKind})` : ""}`,
  ];
  if (input.categoryType) lines.push(`Категория: ${input.categoryType}`);
  if (input.useCases.length) lines.push(`Применение: ${input.useCases.join(", ")}`);
  if (input.materials.length)
    lines.push(`Материалы (заявленные, не подтверждены): ${input.materials.join(", ")}`);
  if (input.selectedSku) lines.push(`SKU: ${input.selectedSku}`);
  if (input.priceText) lines.push(`Цена: ${input.priceText}`);
  if (input.supplierType) lines.push(`Поставщик: ${input.supplierType}`);
  if (input.cargoNature && input.cargoNature !== "none")
    lines.push(`Характер груза: ${input.cargoNature}`);
  lines.push(`Вес известен: ${input.weightKnown ? "да" : "нет"}`);
  lines.push(`Габариты известны: ${input.dimsKnown ? "да" : "нет"}`);
  return lines.join("\n");
}

function materialLists(input: DocWriterInput): string {
  if (input.docType === "cargo") {
    return [
      "Что запросить у поставщика/карго (сырьё, переработай и приоритизируй):",
      bullets([...input.cargoWhatToRequest, ...input.mustAskSupplier], 20),
      "",
      "Особенности груза (сырьё):",
      bullets(input.cargoConsiderations, 12) || "- (нет)",
    ].join("\n");
  }
  return [
    "До заказа образца (сырьё):",
    bullets(input.mustCheckBeforeSample, 12) || "- (нет)",
    "",
    "Что проверить на образце (сырьё):",
    bullets(input.mustCheckOnSample, 16) || "- (нет)",
    "",
    "Красные флаги (сырьё):",
    bullets(input.redFlags, 12) || "- (нет)",
    "",
    `Выбранный SKU: ${input.selectedSku || "не определён"}`,
  ].join("\n");
}

const SYSTEM_MSG =
  "Ты — редактор закупочных документов CardZip. Пишешь чистый, структурированный, приоритизированный документ на грамотном русском. Отвечаешь ТОЛЬКО готовым markdown, без пояснений и без ```.";

function buildPrompt(input: DocWriterInput): string {
  const structure = REQUIRED_SECTIONS[input.docType]
    .map((s) => `${s}`)
    .join("\n");

  const docGoal =
    input.docType === "cargo"
      ? `Это ТЗ для карго-агента (доставка из Китая). Задача — что уточнить/запросить и на что обратить внимание при перевозке ИМЕННО этого товара.`
      : `Это чек-лист для проверки образца перед закупкой партии. Задача — что подтвердить до заказа, что проверить и измерить на образце, какие фото сделать, красные флаги.`;

  return `${docGoal}

Собери из «сырья» ниже ЧИСТЫЙ документ. Тебе даны факты и черновые списки; их надо ПЕРЕПИСАТЬ и СГРУППИРОВАТЬ, а не копировать.

ЖЁСТКИЕ ПРАВИЛА:
- Только факты из «сырья». НЕ придумывай числа, размеры, мощность, сертификаты, материалы, страны.
- Убери дубли и близкие повторы (оставь одну, самую полную формулировку).
- Приоритизируй: сверху самое важное для этого товара.
- Каждый пункт — законченная короткая фраза в одном стиле (не смешивай обрывки и предложения).
- Пиши по-русски, без китайского, без «товар»/«изделие» как заглушки.
- НЕ пиши как факт непроверенные/опасные свойства (медицинский, антибактериальный, сертифицированный, острый, прочный, профессиональный и т.п.) — только как «уточнить/проверить/заявлено».
- НЕ добавляй характеристики чужой категории (обуви — мощность; технике — стелька и т.п.).
- 5–10 пунктов на секцию, не раздувай.

СТРУКТУРА (используй ровно эти заголовки, начни с «# ${input.docType === "cargo" ? "ТЗ карго" : "Чек-лист образца"}»):
${structure}

ФАКТЫ ТОВАРА:
${factSheet(input)}

СЫРЬЁ:
${materialLists(input)}

ГОТОВЫЙ ЧЕРНОВИК-ШАБЛОН (референс структуры и допустимых фактов — улучши его, не выходя за факты):
${input.draftMd.slice(0, 2600)}

Верни ТОЛЬКО готовый markdown документ.`;
}

function stripFences(raw: string): string {
  return raw
    .replace(/^﻿/, "")
    .replace(/^```(?:markdown|md)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

// Validate the writer's markdown against the safety floor. Any failure → null so
// the caller keeps the deterministic template.
export function validateWrittenDoc(
  md: string,
  docType: DocType,
  forbidden: string[] = [],
): boolean {
  const text = stripFences(md);
  if (text.length < 200 || text.length > 6000) return false;
  if (!/^#\s/.test(text)) return false;
  // No Chinese/CJK leaking into a Russian doc.
  if (/[㐀-鿿぀-ヿ]/.test(text)) return false;
  // Every required section header must be present.
  for (const header of REQUIRED_SECTIONS[docType]) {
    if (!text.includes(header)) return false;
  }
  // No dangerous claim asserted as fact.
  if (textHasDangerousClaim(text)) return false;
  // Any explicitly-forbidden claim phrase must not appear.
  for (const f of forbidden) {
    if (f && text.toLowerCase().includes(f.toLowerCase())) return false;
  }
  // No obvious debug/placeholder junk.
  if (/undefined|null\b|NaN|file:\/\/|\bseller\b|\bfactory\b/i.test(text))
    return false;
  return true;
}

async function callModel(
  model: string,
  prompt: string,
  apiKey: string,
): Promise<string | null> {
  const timeoutMs = getNumberEnv("DOC_WRITER_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const maxTokens = getNumberEnv("DOC_WRITER_MAX_TOKENS", DEFAULT_MAX_TOKENS);
  const temperatureRaw = Number(process.env.DOC_WRITER_TEMPERATURE);
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
    console.warn(`[docWriter] ${model} HTTP ${res.status}`);
    return null;
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  const md = stripFences(content);
  return md || null;
}

// Write one document. Returns the polished markdown ONLY if it passes the safety
// validator; otherwise null (caller keeps the deterministic template).
export async function writeDocument(
  input: DocWriterInput,
  forbidden: string[] = [],
): Promise<string | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  const prompt = buildPrompt(input);
  for (const model of MODELS) {
    try {
      const md = await callModel(model, prompt, apiKey);
      if (md && validateWrittenDoc(md, input.docType, forbidden)) {
        console.log(`[docWriter] ${input.docType}: ok via ${model}`);
        return md;
      }
      if (md) console.warn(`[docWriter] ${input.docType}: ${model} failed validation`);
    } catch (error) {
      console.warn(
        `[docWriter] ${input.docType} ${model} failed:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  console.warn(`[docWriter] ${input.docType}: all models failed → template floor`);
  return null;
}

// LLM document writer — turns the deterministic template draft + profile facts
// into a POLISHED, prioritized, well-grouped procurement document in живой
// русский. The deterministic builder stays as the validated fallback: if the
// writer fails, times out, or produces an invalid document, the caller keeps
// the template output. The writer may only REORGANIZE and REWRITE the facts it
// is given — it must not invent numbers, specs, certificates or categories.

import {
  assertsClaimedFeatureWord,
  textHasDangerousClaim,
} from "../core/procurementProfile";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
// Базовая цепочка писателя документов: байер/чек-лист остаются на ней.
const DEFAULT_MODELS = [
  "qwen/qwen3.7-plus",
  "google/gemini-2.5-flash",
  "google/gemini-3.1-flash-lite",
];
// Для карго держим отдельную цепочку: Grok первым, ниже — стабильные фолбэки.
const CARGO_DOC_DEFAULT_MODELS = [
  "x-ai/grok-4.3",
  "qwen/qwen3.7-plus",
  "google/gemini-2.5-flash",
  "google/gemini-3.1-flash-lite",
];
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 3000;
const DEFAULT_TEMPERATURE = 0.3;
// Для SEO держим отдельную цепочку: Grok первым, затем фолбэки.
const SEO_PROSE_DEFAULT_MODELS = [
  "x-ai/grok-4.3",
  "qwen/qwen3.7-plus",
  "google/gemini-2.5-flash",
  "google/gemini-3.1-flash-lite",
];

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
  criticalConfirmations?: string[];
  // Cargo material is LOGISTICS-only (weight/packaging/shipping) — NOT the product
  // supplier questions (HRC, blade angle, mount type), which do not belong in a
  // cargo brief.
  cargoMustAsk: string[];
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
const CARGO_DOC_MODELS = getEnvList(
  "DOC_WRITER_CARGO_MODELS",
  CARGO_DOC_DEFAULT_MODELS,
);

function getWriterModels(docType: DocType): string[] {
  return docType === "cargo" ? CARGO_DOC_MODELS : MODELS;
}

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
  lines.push(`Вес известен: ${input.weightKnown ? "да" : "нет"}`);
  lines.push(`Габариты известны: ${input.dimsKnown ? "да" : "нет"}`);
  return lines.join("\n");
}

function materialLists(input: DocWriterInput): string {
  if (input.docType === "cargo") {
    return [
      "Что запросить для ДОСТАВКИ (только логистика: вес/габариты/упаковка/перевозка/таможня — сырьё, переработай и приоритизируй):",
      bullets([...input.cargoWhatToRequest, ...input.cargoMustAsk], 16),
      "",
      "Особенности груза (сырьё):",
      bullets(input.cargoConsiderations, 12) || "- (нет)",
      "",
      "Обязательные подтверждения для логистики и ввоза (нельзя потерять при переписывании):",
      bullets(input.criticalConfirmations ?? [], 12) || "- (нет)",
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
      ? `Это ТЗ для карго-агента (доставка из Китая). Задача — логистика и ПЕРЕВОЗОЧНЫЙ комплаенс: вес, габариты, упаковка, защита при перевозке, ограничения, таможенные и разрешительные требования. НЕ включай вопросы о КАЧЕСТВЕ/потребительских свойствах товара (твёрдость стали, угол заточки, марка материала, тип монтажа рукояти) — это к поставщику. НО ОБЯЗАТЕЛЬНО сохрани пункты, важные именно для ПЕРЕВОЗКИ и растаможки, если они есть в сырье: наличие/отсутствие аккумулятора или батареи (это опасный груз и определяет способ доставки), разрешительная документация для ввоза (CE/RoHS/EAC и т.п.), маркировка питания/соответствия на товаре и упаковке, тип вилки и напряжение/частота (влияют на соответствие рынку и растаможку), а также ОТДЕЛЬНО вес, количество и габариты мастер-короба. Их НЕЛЬЗЯ выбрасывать как «характеристики». Строго курируй остальное: оставь 7–9 самых важных пунктов, объедини повторы. Все пункты в ОДНОМ стиле — короткое требование с заглавной буквы. Не выводи английские коды характера груза — пиши по-русски.`
      : `Это чек-лист для проверки образца перед закупкой партии. Задача — что подтвердить до заказа, что проверить и измерить на образце, какие фото сделать, красные флаги.`;

  return `${docGoal}

Собери из «сырья» ниже ЧИСТЫЙ документ. Тебе даны факты и черновые списки; их надо ПЕРЕПИСАТЬ и СГРУППИРОВАТЬ, а не копировать.

ЖЁСТКИЕ ПРАВИЛА:
- Только факты из «сырья». НЕ придумывай числа, размеры, мощность, сертификаты, материалы, страны.
- НЕ ДОМЫСЛИВАЙ и НЕ РАСШИРЯЙ. Если в сырье вопрос-ПОДТВЕРЖДЕНИЕ («подтвердить отсутствие аккумулятора», «есть ли сертификаты») — оставь его КАК ВОПРОС/ПРОВЕРКУ, НЕ превращай в утверждение о наличии. Пример запрещённого: сырьё «подтвердить отсутствие аккумулятора» → нельзя писать «встроенный литий-ионный аккумулятор, сертификат UN38.3, декларация DGR». Не выдумывай конкретные стандарты, коды (UN38.3, UN3481, DGR, MSDS), химию, типы батарей, если их НЕТ в сырье.
- Убери дубли и СМЫСЛОВЫЕ повторы: если два пункта про ОДНО И ТО ЖЕ (даже разными словами) — оставь один, самый полный. Например «нет информации о твёрдости стали» и «твёрдость стали не подтверждена» — это ОДИН пункт; «риск коррозии дешёвой стали» и «проверить устойчивость к коррозии» — объедини.
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
    // Reasoning models (DeepSeek etc.) emit <think>…</think> before the answer —
    // strip closed blocks AND an unclosed one left by truncation, so reasoning never
    // leaks into JSON extraction or a markdown doc (it broke JSON parsing before).
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "")
    .replace(/<think(?:ing)?>[\s\S]*$/i, "")
    .replace(/^```(?:markdown|md|json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function isListLine(line: string): boolean {
  return /^(\d+[.)]|[•\-*])\s+\S/.test(line.trim());
}

function countSectionListItems(md: string, header: string): number {
  const lines = stripFences(md).split("\n");
  let inSection = false;
  let count = 0;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === header) {
      inSection = true;
      continue;
    }
    if (inSection && /^#{1,6}\s/.test(line)) break;
    if (inSection && isListLine(line)) count += 1;
  }
  return count;
}

function isOverloadedDisclosureBullet(text: string): boolean {
  const line = cleanProseLine(text);
  if (!line) return false;
  const low = line.toLowerCase();
  const clauses = line.split(/[;,]\s*/).filter(Boolean).length;
  const separators = (line.match(/[;,]/g) ?? []).length;
  const hedgeHeavy = /по\s+заявлен|уточнит|подтверд/i.test(low);
  return (hedgeHeavy && clauses >= 4) || (line.length > 190 && clauses >= 3) || separators >= 6;
}

const SEO_PACKAGING_RE =
  /(?:кейс[а-яё]*|футляр[а-яё]*|чехл[а-яё]*|подарочн[а-яё]*|набор[а-яё]*|бокс[а-яё]*|(?:с|в)\s+коробк[а-яё]*|(?:с|в)\s+упаковк[а-яё]*)/i;
const SEO_CONTEXT_RE =
  /\b(?:салон[а-яё]*|профессионал[а-яё]*|коммерческ[а-яё]*|студи[а-яё]*|мастер(?:а|ов)?|специалист(?:а|ов)?)\b/i;

function featureAuthorityWords(features: string[] = []): string[] {
  return Array.from(
    new Set(
      features
        .flatMap((f) =>
          String(f ?? "")
            .toLowerCase()
            .replace(/ё/g, "е")
            .split(/[^а-яёa-z0-9]+/i),
        )
        .filter((w) => w.length >= 4),
    ),
  );
}

function mentionsForeignPackaging(text: string, coreObject: string): boolean {
  return SEO_PACKAGING_RE.test(text) && !SEO_PACKAGING_RE.test(coreObject);
}

function hasUnsupportedSeoContext(text: string, input: SeoProseInput): boolean {
  const m = text.toLowerCase().replace(/ё/g, "е").match(SEO_CONTEXT_RE);
  if (!m) return false;
  const authority = `${input.coreObject} ${input.useCases.join(" ")}`
    .toLowerCase()
    .replace(/ё/g, "е");
  return !authority.includes(m[0]);
}

const REQUIRED_CONCEPT_STOPWORDS = new Set([
  "и",
  "или",
  "в",
  "во",
  "на",
  "по",
  "с",
  "со",
  "для",
  "у",
  "под",
  "над",
  "как",
  "какой",
  "какие",
  "какая",
  "каково",
  "какова",
  "ли",
  "есть",
  "нужно",
  "нужны",
  "нужен",
  "уточните",
  "подтвердите",
  "пришлите",
  "покажите",
  "укажите",
  "точный",
  "точная",
  "точные",
  "выбранного",
  "выбранный",
  "выбранной",
  "этого",
  "этой",
  "этот",
  "товара",
  "товар",
  "изделия",
  "именно",
  "наличие",
  "отсутствие",
  "подтверждают",
  "подтверждает",
]);

function normalizedConceptWords(text: string): string[] {
  return String(text ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^а-яёa-z0-9]+/i)
    .filter((w) => w.length >= 2 && !REQUIRED_CONCEPT_STOPWORDS.has(w))
    .map((w) => (w.length >= 6 ? w.slice(0, 6) : w));
}

function coversRequiredConcept(doc: string, required: string): boolean {
  const req = normalizedConceptWords(required);
  if (!req.length) return true;
  const docWords = normalizedConceptWords(doc);
  return req.some((token) =>
    docWords.some((word) => {
      if (word === token) return true;
      const a = token.slice(0, 4);
      const b = word.slice(0, 4);
      return a.length >= 4 && b.length >= 4 && (word.startsWith(a) || token.startsWith(b));
    }),
  );
}

function sanitizeSeoTitleCandidate(raw: unknown, input: SeoProseInput): string {
  const title = cleanProseLine(raw);
  if (!title) return "";
  if (title.length < 25 || title.length > 140) return "";
  if (/[㐀-鿿぀-ヿ]/.test(title)) return "";
  if (textHasDangerousClaim(title)) return "";
  if (input.forbidden.some((f) => f && title.toLowerCase().includes(f.toLowerCase())))
    return "";
  if (MEASUREMENT_RE.test(title)) return "";
  if (/черновик|1688|заявлен|подтверд|уточнит|\bwb\b|\bozon\b/i.test(title))
    return "";
  const dashParts = title.split(/\s+[—-]\s+/).filter(Boolean);
  if (dashParts.length > 1 && dashParts[1].split(/\s+/).filter(Boolean).length <= 5)
    return "";
  if (hasUnsupportedSeoContext(title, input)) return "";
  const featureWords = featureAuthorityWords(input.claimedFeatures ?? []);
  if (featureWords.length && assertsClaimedFeatureWord(title, featureWords)) return "";
  if (mentionsForeignPackaging(title, input.coreObject)) return "";
  return title;
}

function sanitizeSeoKeywords(
  raw: unknown,
  input: SeoProseInput,
  title: string,
): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const featureWords = featureAuthorityWords(input.claimedFeatures ?? []);
  const titleKey = title.trim().toLowerCase();
  const out: string[] = [];
  for (const item of raw) {
    const keyword = cleanProseLine(item);
    if (!keyword) continue;
    const low = keyword.toLowerCase();
    if (keyword.length < 3 || keyword.length > 60) continue;
    if (/[㐀-鿿぀-ヿ]/.test(keyword)) continue;
    if (titleKey && low === titleKey) continue;
    if (/черновик|1688|выбранн(?:ый|ого)?\s+sku|цена\s+sku|\bwb\b|\bozon\b/i.test(low))
      continue;
    if (textHasDangerousClaim(keyword)) continue;
    if (input.forbidden.some((f) => f && low.includes(f.toLowerCase()))) continue;
    if (MEASUREMENT_RE.test(keyword)) continue;
    if (hasUnsupportedSeoContext(keyword, input)) continue;
    if (mentionsForeignPackaging(keyword, input.coreObject)) continue;
    if (featureWords.length && assertsClaimedFeatureWord(keyword, featureWords))
      continue;
    const key = low.replace(/ё/g, "е");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(keyword);
    if (out.length >= 18) break;
  }
  return out;
}

// Validate the writer's markdown against the safety floor. Any failure → null so
// the caller keeps the deterministic template.
export function validateWrittenDoc(
  md: string,
  docType: DocType,
  forbidden: string[] = [],
  requiredConcepts: string[] = [],
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
  if (docType === "cargo") {
    const requestItems = countSectionListItems(text, "## Что нужно запросить для доставки");
    const extraItems = countSectionListItems(text, "## Дополнительно по этому товару");
    if (requestItems < 5 || extraItems < 1) return false;
    if (
      requiredConcepts.length &&
      requiredConcepts.some((item) => !coversRequiredConcept(text, item))
    )
      return false;
  }
  return true;
}

// ─── SEO prose writer ───────────────────────────────────────────────────────
// Writes ONLY the prose parts of the SEO card (description + 5 bullets). The
// characteristics table and keywords stay deterministic (they must never carry
// invented numbers). This is the "SEO через писатель" path — stronger anti-water
// / anti-invented-number control than the generic seoCard generator.

export interface SeoProseInput {
  titleRu: string;
  coreObject: string;
  categoryType?: string;
  useCases: string[];
  materials: string[]; // declared (unconfirmed) materials — the ONLY material source
  // Seller-claimed features (motor type, overheat protection, ionization, …) that
  // must be framed as declared, never asserted as fact.
  claimedFeatures?: string[];
  // When the exact variant isn't confirmed, the pack contents (case/set/nozzle)
  // are ambiguous — the copy must not assert them (esp. in the title).
  skuReliable?: boolean;
  // Only values we can actually back as facts (attribute name→value the card had).
  confirmedAttributes: Array<{ name: string; value: string }>;
  forbidden: string[];
}

export interface SeoProseResult {
  title: string;
  description: string;
  bullets: string[];
  keywords: string[];
  characteristics: Array<{ name: string; value: string; status: string }>;
}

// Numeric-measurement pattern: a number followed by a physical unit. SEO bullets
// must not assert these unless the exact value is a confirmed attribute — on 1688
// dimensions/angles/hardness are almost never reliable, and they belong in the
// characteristics table, not in marketing bullets.
const MEASUREMENT_RE =
  /\d+(?:[.,]\d+)?\s*(?:см|мм|м\b|кг|г\b|мл|л\b|°|градус|hrc|вт|ватт|в\b|вольт|дюйм|")/i;

function bulletHasUnbackedNumber(
  bullet: string,
  confirmed: Array<{ name: string; value: string }>,
): boolean {
  if (!MEASUREMENT_RE.test(bullet)) return false;
  // Keep the bullet only if every number in it appears in a confirmed attribute.
  const nums = bullet.match(/\d+(?:[.,]\d+)?/g) ?? [];
  const confirmedText = confirmed.map((a) => a.value).join(" ").toLowerCase();
  return !nums.every((n) => confirmedText.includes(n.toLowerCase()));
}

const SEO_PROSE_SYSTEM =
  "Ты — SEO-редактор карточек WB/Ozon. Отвечаешь ТОЛЬКО валидным JSON-объектом, без markdown и пояснений.";

function buildSeoProsePrompt(input: SeoProseInput): string {
  const facts = [
    `Товар: ${input.titleRu}`,
    `Тип: ${input.coreObject}`,
    input.categoryType ? `Категория: ${input.categoryType}` : "",
    input.useCases.length ? `Применение: ${input.useCases.join(", ")}` : "",
    input.materials.length
      ? `Материалы (ЕДИНСТВЕННЫЙ разрешённый список, только как заявленные): ${input.materials.join(", ")}`
      : "Материал не подтверждён — не указывай состав.",
    input.claimedFeatures?.length
      ? `Заявленные продавцом фичи (упоминать ТОЛЬКО как «заявленные», не как факт): ${input.claimedFeatures.join(", ")}`
      : "",
    input.skuReliable === false
      ? `ВНИМАНИЕ: конкретный SKU/вариант НЕ подтверждён (варианты могут отличаться, вплоть до «только упаковка»). ПРАВИЛО ДЛЯ ЗАГОЛОВКА: он должен состоять ТОЛЬКО из типа товара + синонимов + реального применения (из «Применение»). В ЗАГОЛОВКЕ ЗАПРЕЩЕНО: состав комплекта (кейс/футляр/набор/насадка/«в подарок»), заявленные фичи как факт (мотор, ионизация, «мощный», «быстрая сушка», режимы воздуха), апгрейд площадки («для салона», «профессиональный»). Всё это — только в описании и ТОЛЬКО как «по заявлению продавца, уточните». Заголовок и буллеты не должны утверждать ничего, что не подтверждено.`
      : "",
    input.confirmedAttributes.length
      ? `Подтверждённые атрибуты: ${input.confirmedAttributes
          .map((a) => `${a.name}: ${a.value}`)
          .join(" | ")}`
      : "Подтверждённых числовых характеристик нет.",
  ]
    .filter(Boolean)
    .join("\n");

  return `Ты — сильный SEO-копирайтер карточек Wildberries и Ozon. По ЭТОМУ товару напиши карточку, которая ХОРОШО ИЩЕТСЯ и ПРОДАЁТ. Пиши живым русским, как топовые карточки, а не как робот-шаблон.

ЭТАЛОН КАЧЕСТВА — ориентируйся на этот УРОВЕНЬ (пример по ДРУГОМУ товару, термос; НЕ копируй слова — повтори стиль, живость и поисковую плотность для СВОЕГО товара):
{"title":"Термос для чая и кофе вакуумный стальной с колбой из нержавейки термокружка для напитков в дорогу и офис","description":"Вакуумный термос помогает надолго сохранить температуру напитка — в поездке, на прогулке или за рабочим столом. Двойные стенки из нержавеющей стали удерживают тепло чая и кофе, а в жару сохраняют прохладу воды. Компактный корпус помещается в подстаканник автомобиля и в боковой карман рюкзака, а завинчивающаяся крышка уменьшает риск протечки в сумке. Заявленный материал корпуса — нержавеющая сталь. Термос подойдёт и на каждый день, и в подарок.","bullets":["Двойные стенки из нержавеющей стали дольше держат напиток горячим или холодным","Компактный корпус помещается в подстаканник и карман рюкзака — удобно брать с собой","Завинчивающаяся крышка уменьшает риск протечки в сумке и рюкзаке","Гладкий корпус легко протирать, а форма удобно ложится в руку","Лаконичный дизайн подойдёт и на каждый день, и в подарок"],"keywords":["термос","термокружка","термос для чая","термос для кофе","термос стальной","термос вакуумный","термос в дорогу","термос нержавейка","бутылка термос","термос для напитков","термос в офис","термос подарок","термос дорожный"],"characteristics":[{"name":"Тип","value":"вакуумный термос","status":"заявлено, уточнить"},{"name":"Материал корпуса","value":"нержавеющая сталь","status":"заявлено, уточнить"},{"name":"Объём","value":"уточнить","status":"подтвердить"}]}

ПОЧЕМУ ЭТОТ ПРИМЕР ХОРОШИЙ (повтори это):
- Заголовок ДЛИННЫЙ и набит поисковыми словами: тип + синонимы (термос, термокружка) + назначение (для чая, кофе, напитков) + для кого/где (в дорогу, в офис) + материал. Так товар находят.
- Описание ЖИВОЕ и про ВЫГОДУ: что фича ДАЁТ покупателю («помещается в подстаканник», «уменьшает риск протечки»), а не сухой перечень «оснащён… предусмотрено…».
- Буллеты — РАЗНЫЕ углы продажи, каждый про своё, с выгодой; ни одного пустого («практичный инструмент»).
- При этом НИ ОДНОГО непроверенного числа или свойства как факта; материал — «заявленный».

ТЕПЕРЬ так же качественно для СВОЕГО товара, СТРОГО соблюдая честность:
- Материал бери ТОЛЬКО из списка «Материалы» в фактах — НЕ добавляй других (если в списке «PC, ABS», то нейлона/PA и прочего быть не должно). Пиши «заявленный материал — …»; НЕ «материал изделия/товара — …», не называй марку голым фактом.
- Фичи из «Заявленные фичи» (двигатель, защита от перегрева, ионизация, режимы) не утверждай как факт — но НЕ начинай каждый буллет со слова «Заявленный/Заявленная», это читается оборонительно и однообразно. Сделай так: сгруппируй заявленные характеристики в ОДНОМ буллете или предложении под общей оговоркой (например: «По заявлению продавца — бесщёточный мотор, ионизация и защита от перегрева; уточните перед заказом»), а остальные буллеты пиши про выгоду и применение живо, БЕЗ повтора «заявлено».
- Если спорных фич много, НЕ сваливай их все в одну строку. Нельзя делать буллет-«простыню» с длинным перечнем мощности, температуры, шума, вилки, сертификатов, режимов и других неподтверждённых параметров через запятую или точку с запятой. Максимум одна короткая оговорка на 2–3 спорные фичи; остальное опусти.
- ЛЮБОЕ свойство/стойкость (качество, острота, прочность, мощность, «устойчив/защищает/не боится» влаги, коррозии, износа, нагрева и пр.) — не как факт: либо не пиши, либо «заявлено». Требовательные способности (рубить кости, замороженное, твёрдое, тяжёлое) — не утверждай, если нет в фактах.
- НЕ придумывай числа (длину, ширину, толщину, угол, HRC, вес, мощность): нет числа в «Подтверждённых атрибутах» — не пиши его. Числа-размеры в заголовок НЕ ставь.
- Сценарии/аудиторию/место применения бери ТОЛЬКО из строки «Применение». Не расширяй бытовой товар до профессионального/коммерческого, если этого нет в фактах.
- Не вставляй в title и keywords неподтверждённые техпараметры с единицами измерения (Вт, В, мм, см, кг и т.п.).
- БЕЗ оценочной воды: «высококачественный», «эффективный», «идеальный», «прочный», «долговечный», «надёжный», «профессиональный», «обеспечивает», «гарантирует».
- НЕ вставляй служебных заметок для продавца («подтвердите у поставщика», «выбранный SKU», «реальные фото», «перед публикацией») — покупатель их видеть не должен.

ФОРМАТ (как в примере):
- title: 70–120 символов, поисковый и продающий, начни с типа и синонимов. Это должна быть поисковая фраза, а не объяснение процесса через тире.
- description: 4–6 живых предложений про выгоду и применение, с поисковыми словами.
- bullets: РОВНО 5, каждый про РАЗНОЕ, с выгодой; без дублей и пустых фраз. Один буллет = одна мысль, 8–18 слов, максимум одно предложение, без длинных перечислений через 5+ запятых.
- keywords: 12–18 реальных запросов покупателя (частотные + длинный хвост), без дублей.
- characteristics: 5–8 {name, value, status}. value ТОЛЬКО из «Подтверждённых атрибутов» (status="заявлено, уточнить"); иначе value="уточнить", status="подтвердить". Коды/марки целиком (3Cr13, не Cr13). Китайское — переводи.

ФАКТЫ О ТВОЁМ ТОВАРЕ:
${facts}

Верни строго JSON:
{"title":"...","description":"...","bullets":["...","...","...","...","..."],"keywords":["...","..."],"characteristics":[{"name":"...","value":"...","status":"..."}]}`;
}

function cleanProseLine(v: unknown): string {
  return String(v ?? "")
    .replace(/\s+/g, " ")
    .replace(/^[-•*\d.)\s]+/, "")
    .trim();
}

export async function writeSeoProse(
  input: SeoProseInput,
): Promise<SeoProseResult | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  const prompt = buildSeoProsePrompt(input);
  // Strong model → longer timeout (deepseek is slow); still falls back to the fast
  // models if it doesn't complete in time.
  const timeoutMs = getNumberEnv("SEO_PROSE_TIMEOUT_MS", 150_000);
  const maxTokens = getNumberEnv("SEO_PROSE_MAX_TOKENS", 4000);
  // Copy needs some life — 0.25 pushed the model into flat, "safe" spec-list
  // phrasing. The grounding verifier + deterministic guards catch any drift, so a
  // higher temperature is safe here and reads far less robotic.
  const temperatureRaw = Number(process.env.SEO_PROSE_TEMPERATURE);
  const temperature = Number.isFinite(temperatureRaw) ? temperatureRaw : 0.45;
  const models = getEnvList("SEO_PROSE_MODELS", SEO_PROSE_DEFAULT_MODELS);

  for (const model of models) {
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
          // Strict JSON + reasoning OFF: deepseek-v4-pro truncated JSON by spending
          // the token budget on internal reasoning. OpenRouter-unified params;
          // unsupported models ignore them.
          response_format: { type: "json_object" },
          reasoning: { enabled: false },
          messages: [
            { role: "system", content: SEO_PROSE_SYSTEM },
            { role: "user", content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        console.warn(`[seoProse] ${model} HTTP ${res.status}`);
        continue;
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const raw = data.choices?.[0]?.message?.content ?? "";
      const jsonStr = extractJsonObject(raw);
      if (!jsonStr) {
        console.warn(`[seoProse] ${model} invalid JSON`);
        continue;
      }
      const obj = JSON.parse(jsonStr) as Record<string, unknown>;
      const description = cleanProseLine(obj.description);
      // Title/keywords are optional upstream, but if the model produced strong,
      // grounded search assets we preserve them for the final SEO draft.
      const title = sanitizeSeoTitleCandidate(obj.title, input);
      const keywords = sanitizeSeoKeywords(obj.keywords, input, title);
      let bullets = Array.isArray(obj.bullets)
        ? obj.bullets.map(cleanProseLine).filter(Boolean)
        : [];
      // Drop any bullet asserting an unbacked measurement number.
      bullets = bullets.filter(
        (b) => !bulletHasUnbackedNumber(b, input.confirmedAttributes),
      );
      bullets = bullets.filter((b) => !isOverloadedDisclosureBullet(b));
      const characteristics = Array.isArray(obj.characteristics)
        ? obj.characteristics
            .map((c) => {
              const o = (c ?? {}) as Record<string, unknown>;
              return {
                name: cleanProseLine(o.name),
                value: cleanProseLine(o.value),
                status: cleanProseLine(o.status) || "подтвердить",
              };
            })
            .filter((c) => c.name && c.value)
            .slice(0, 8)
        : [];
      // Validate: real description, no CJK, no dangerous/forbidden/puffery.
      const joined = `${description} ${bullets.join(" ")}`;
      const forbiddenHit = input.forbidden.some(
        (f) => f && joined.toLowerCase().includes(f.toLowerCase()),
      );
      if (
        description.length < 40 ||
        description.length > 800 ||
        bullets.length < 3 ||
        /[㐀-鿿぀-ヿ]/.test(joined) ||
        textHasDangerousClaim(joined) ||
        forbiddenHit
      ) {
        console.warn(`[seoProse] ${model} failed validation`);
        continue;
      }
      console.log(
        `[seoProse] ok via ${model} (title:${title ? "y" : "n"} ${bullets.length} bullets, ${keywords.length} kw, ${characteristics.length} chars)`,
      );
      const prose = {
        title,
        description,
        bullets: bullets.slice(0, 5),
        keywords,
        characteristics,
      };
      // Second LLM pass: rewrite the prose into vivid, benefit-driven copy while
      // keeping it grounded (no invented scenarios/properties/numbers). On any
      // failure it returns the writer's already-validated prose unchanged.
      if (shouldVerifyGrounding()) {
        const grounded = await verifySeoGrounding(input, {
          title: prose.title,
          description: prose.description,
          bullets: prose.bullets,
          keywords: prose.keywords,
        });
        return { ...prose, ...grounded };
      }
      return prose;
    } catch (error) {
      console.warn(
        `[seoProse] ${model} failed:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return null;
}

// ─── SEO editor pass (second LLM call) ───────────────────────────────────────
// Small fast models write technically-correct but LIFELESS, bureaucratic 1688
// copy ("оснащён…", "предусмотрено…", "функционал включает…", "устройство
// предназначено…"). This pass REWRITES the description + bullets into vivid,
// benefit-driven marketplace copy AND keeps it grounded: it may rephrase only the
// given facts, never add scenarios/properties/numbers, and it strips anything not
// supported. Category-agnostic, zero hardcoded product terms. Every result re-runs
// the writer's safety gates; on any failure it falls back to the input prose, so
// the pass can only improve, never degrade, the output.

const SEO_VERIFY_SYSTEM =
  "Ты — сильный редактор продающих карточек WB/Ozon. Отвечаешь ТОЛЬКО валидным JSON-объектом, без markdown и пояснений.";

// Default ON; disable with SEO_GROUNDING_VERIFY=0 (also false/off/no).
export function shouldVerifyGrounding(): boolean {
  const v = String(process.env.SEO_GROUNDING_VERIFY ?? "1").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "off" && v !== "no";
}

function buildGroundingVerifyPrompt(
  input: SeoProseInput,
  draft: {
    title: string;
    description: string;
    bullets: string[];
    keywords: string[];
  },
): string {
  const facts = [
    `Тип товара: ${input.coreObject}`,
    input.categoryType ? `Категория: ${input.categoryType}` : "",
    input.useCases.length
      ? `Применение (полный список, ничего сверх него): ${input.useCases.join(", ")}`
      : "Применение: в данных не указано",
    input.materials.length
      ? `Материалы (ЕДИНСТВЕННЫЙ разрешённый список, только как заявленные): ${input.materials.join(", ")}`
      : "Материал не подтверждён — состав не указывай.",
    input.claimedFeatures?.length
      ? `Заявленные продавцом фичи (только как «заявленные», не факт): ${input.claimedFeatures.join(", ")}`
      : "",
    input.confirmedAttributes.length
      ? `Подтверждённые атрибуты: ${input.confirmedAttributes
          .map((a) => `${a.name}: ${a.value}`)
          .join(" | ")}`
      : "Подтверждённых числовых характеристик нет.",
  ]
    .filter(Boolean)
    .join("\n");
  return `Ты — сильный редактор карточек WB/Ozon. ПЕРЕПИШИ заголовок, описание, буллеты и ключевые слова так, чтобы они ПРОДАВАЛИ и читались как топовая карточка, — используя ТОЛЬКО факты о товаре ниже. Ничего не выдумывай.

СНАЧАЛА ОЖИВИ (это главное — сейчас текст сухой и канцелярский):
- УБЕРИ канцелярит и штампы: «оснащён», «предусмотрено», «предусмотрена система», «функционал включает», «устройство», «изделие», «предназначено для», «характеризуется», «представляет собой», «данный товар». Начинай буллеты по-разному, не «Оснащён… Предусмотрено… Функционал…».
- Пиши про ВЫГОДУ покупателя: что деталь ДАЁТ на практике («насадка-концентратор направляет поток — удобно укладывать пряди», а не «оснащён насадкой-концентратором»). Разговорный, но грамотный русский, как у людей.
- Каждый буллет — про РАЗНОЕ и живо; описание — 3–5 предложений, не рубленых.

ОСТАВЬ ЧЕСТНЫМ (не выходя за факты):
- Материал только из списка «Материалы» и только как «заявленный материал — …»; НЕ добавляй других материалов (нет в списке — не пиши), НЕ «материал изделия/товара — …», не марку голым фактом.
- Фичи из «Заявленные фичи» — не как факт, но НЕ префикси каждый буллет «Заявленный/Заявленная». Сгруппируй заявленные характеристики в одном месте под общей оговоркой («по заявлению продавца — …; уточните перед заказом»); остальные буллеты — живо, без повтора «заявлено».
- Любой сценарий/аудиторию/место применения, которых НЕТ в списке «Применение», — УБЕРИ полностью (не «смягчи»): нет «в салоне», «для профессионалов», «в путешествия», если этого нет в применении.
- Эффект на пользователя/результат/косметическое или медицинское действие (напр. «меньше пушится», «защищает волосы», «бережно сушит», «меньше вреда», «здоровье волос») — УДАЛИ ЦЕЛИКОМ. Такое нельзя писать даже с «по заявлению» — нужны тесты/документы, которых нет.
- Сравнения и заявления о скорости/силе/качестве без числа из фактов («быстро сушит», «быстрее обычных», «мощный поток») — убери или переведи в нейтральное описание функции без оценки.
- Заявленные фичи (мотор, ионизация, режимы, защита от перегрева) — не как факт; сгруппируй под общей оговоркой «по заявлению продавца — …; уточните перед заказом».
- Не оставляй буллет-«простыню» с длинным перечнем спорных фич через запятые/точки с запятой. Если спорных фич слишком много, сократи до 1 короткой оговорки или убери из буллетов совсем.
- Заголовок должен быть ПОИСКОВЫМ: тип товара + реальные поисковые уточнения. Не делай заголовок формата «тип товара — что с ним делают». Никаких неподтверждённых фич, упаковки или чужих сценариев.
- Ключевые слова должны быть реальными запросами покупателя: 10–18 штук, смесь частотных и длинного хвоста, без дублей, без повторения полного заголовка, без упаковки/комплекта/чужих мест использования, если это не подтверждено фактами.
- Не вставляй в title и keywords неподтверждённые техпараметры с единицами измерения (Вт, В, мм, см, кг и т.п.).
- НЕ добавляй воду («мощный», «профессиональный», «эффективный», «высококачественный», «надёжный», «идеальный») и непроверенные числа/свойства.

ФАКТЫ О ТОВАРЕ:
${facts}

ТЕКУЩИЙ ТЕКСТ (перепиши живее, оставаясь строго в рамках фактов):
заголовок: ${draft.title}
ключевые слова: ${draft.keywords.join(", ")}
описание: ${draft.description}
буллеты:
${draft.bullets.map((b, i) => `${i + 1}. ${b}`).join("\n")}

Верни строго JSON (3–5 буллетов, 10–18 keywords):
{"title":"...","description":"...","bullets":["...","...","..."],"keywords":["...","..."]}`;
}

/**
 * Applies a verifier model's raw JSON verdict to the draft, re-running the SAME
 * safety gates as the writer (unbacked numbers, CJK, dangerous/forbidden claims,
 * length, min-3 bullets). Pure/testable. If the verdict is missing, unparseable,
 * or fails a gate, returns the untouched `fallback` — the verifier can only
 * improve, never degrade, the already-validated prose.
 */
export function parseGroundingVerdict(
  raw: string,
  input: SeoProseInput,
  fallback: {
    title: string;
    description: string;
    bullets: string[];
    keywords: string[];
  },
): {
  title: string;
  description: string;
  bullets: string[];
  keywords: string[];
} {
  const jsonStr = extractJsonObject(raw);
  if (!jsonStr) return fallback;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(jsonStr) as Record<string, unknown>;
  } catch {
    return fallback;
  }
  const title = sanitizeSeoTitleCandidate(obj.title, input) || fallback.title;
  const description = cleanProseLine(obj.description);
  let bullets = Array.isArray(obj.bullets)
    ? obj.bullets.map(cleanProseLine).filter(Boolean)
    : [];
  bullets = bullets.filter(
    (b) => !bulletHasUnbackedNumber(b, input.confirmedAttributes),
  );
  bullets = bullets.filter((b) => !isOverloadedDisclosureBullet(b));
  const keywordsRaw = sanitizeSeoKeywords(obj.keywords, input, title);
  const keywords = keywordsRaw.length >= 5 ? keywordsRaw : fallback.keywords;
  const joined = `${description} ${bullets.join(" ")}`;
  const forbiddenHit = input.forbidden.some(
    (f) => f && joined.toLowerCase().includes(f.toLowerCase()),
  );
  if (
    description.length < 40 ||
    description.length > 800 ||
    bullets.length < 3 ||
    /[㐀-鿿぀-ヿ]/.test(joined) ||
    textHasDangerousClaim(joined) ||
    forbiddenHit
  ) {
    return fallback;
  }
  return { title, description, bullets: bullets.slice(0, 5), keywords };
}

export async function verifySeoGrounding(
  input: SeoProseInput,
  draft: {
    title: string;
    description: string;
    bullets: string[];
    keywords: string[];
  },
): Promise<{
  title: string;
  description: string;
  bullets: string[];
  keywords: string[];
}> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return draft;
  const prompt = buildGroundingVerifyPrompt(input, draft);
  const timeoutMs = getNumberEnv("SEO_VERIFY_TIMEOUT_MS", 45_000);
  const maxTokens = getNumberEnv("SEO_VERIFY_MAX_TOKENS", 1200);
  const models = getEnvList("SEO_VERIFY_MODELS", MODELS);
  for (const model of models) {
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
          temperature: 0.1,
          response_format: { type: "json_object" },
          reasoning: { enabled: false },
          messages: [
            { role: "system", content: SEO_VERIFY_SYSTEM },
            { role: "user", content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        console.warn(`[seoVerify] ${model} HTTP ${res.status}`);
        continue;
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const rawContent = data.choices?.[0]?.message?.content ?? "";
      const grounded = parseGroundingVerdict(rawContent, input, draft);
      const changed =
        grounded.description !== draft.description ||
        grounded.bullets.join("") !== draft.bullets.join("");
      console.log(`[seoVerify] ok via ${model} (${changed ? "adjusted" : "no change"})`);
      return grounded;
    } catch (error) {
      console.warn(
        `[seoVerify] ${model} failed:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return draft;
}

// Reuse the object extractor for the SEO prose parser.
function extractJsonObject(raw: string): string | null {
  const cleaned = stripFences(raw);
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
      // Reasoning OFF (this writer returns markdown, not JSON): deepseek-v4-pro's
      // <think> otherwise ate the budget and truncated the doc. No response_format —
      // the output is a markdown document, not a JSON object.
      reasoning: { enabled: false },
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

// Default ON; disable with DOC_GROUNDING_VERIFY=0.
function shouldVerifyDocs(): boolean {
  const v = String(process.env.DOC_GROUNDING_VERIFY ?? "1").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "off" && v !== "no";
}

// Second-pass grounding audit for a written doc. The generative pass can invent
// facts (e.g. flip "confirm ABSENCE of battery" into a full lithium-battery
// shipping section with UN38.3/DGR). This focused DISCRIMINATION pass re-reads the
// doc against the source facts and strips anything not supported — a task LLMs do
// far more reliably than open generation. Model-agnostic, zero hardcoded product
// terms; on any failure the caller keeps the original/template.
function buildDocVerifyPrompt(md: string, input: DocWriterInput): string {
  return `Ты — придирчивый аудитор закупочных документов. Ниже ИСХОДНЫЕ данные и СГЕНЕРИРОВАННЫЙ документ. Верни ИСПРАВЛЕННЫЙ документ, убрав/исправив ЛЮБОЕ утверждение-факт, которого НЕТ в исходных данных или которое им ПРОТИВОРЕЧИТ.

ГЛАВНОЕ:
- Если источник просит ПОДТВЕРДИТЬ ОТСУТСТВИЕ чего-то (аккумулятор, сертификат) — документ НЕ должен утверждать его наличие; верни это как вопрос/проверку, а не как факт.
- Убери выдуманные стандарты и коды (UN38.3, UN3481, DGR, MSDS), типы/химию батарей, числа, сертификаты, страны и материалы, которых НЕТ в источнике.
- Ничего не добавляй от себя. Сохрани те же markdown-заголовки и структуру, грамотный русский, без китайского.

ИСХОДНЫЕ ДАННЫЕ (единственный источник фактов):
${factSheet(input)}
${materialLists(input)}

СГЕНЕРИРОВАННЫЙ ДОКУМЕНТ:
${md}

Верни ТОЛЬКО исправленный markdown, без пояснений и без \`\`\`.`;
}

async function verifyDocGrounding(
  md: string,
  input: DocWriterInput,
  apiKey: string,
): Promise<string | null> {
  const prompt = buildDocVerifyPrompt(md, input);
  for (const model of MODELS) {
    try {
      const out = await callModel(model, prompt, apiKey);
      if (out) return out;
    } catch {
      /* try next model */
    }
  }
  return null;
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
  const models = getWriterModels(input.docType);
  for (const model of models) {
    try {
      const md = await callModel(model, prompt, apiKey);
      const concepts =
        input.docType === "cargo" ? (input.criticalConfirmations ?? []) : [];
      if (md && validateWrittenDoc(md, input.docType, forbidden, concepts)) {
        // Grounding audit: strip any invented facts the generative pass added. Only
        // adopt the audited version if it still passes the safety validator; on any
        // failure keep the original (audit can only improve, never degrade).
        if (shouldVerifyDocs()) {
          const grounded = await verifyDocGrounding(md, input, apiKey);
          if (
            grounded &&
            grounded !== md &&
            validateWrittenDoc(grounded, input.docType, forbidden, concepts)
          ) {
            console.log(`[docWriter] ${input.docType}: ok via ${model} (grounded)`);
            return grounded;
          }
        }
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

// LLM document writer — turns the deterministic template draft + profile facts
// into a POLISHED, prioritized, well-grouped procurement document in живой
// русский. The deterministic builder stays as the validated fallback: if the
// writer fails, times out, or produces an invalid document, the caller keeps
// the template output. The writer may only REORGANIZE and REWRITE the facts it
// is given — it must not invent numbers, specs, certificates or categories.

import { textHasDangerousClaim } from "../core/procurementProfile";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
// Content writing is a nuance-heavy task. Try a stronger model first for copy
// quality, then fall back to gemini-2.5-flash which reliably completes on Railway
// so we ALWAYS get output. Fully overridable via DOC_WRITER_MODELS. NOTE: verify
// exact slugs on the OpenRouter models page — a wrong slug just falls through.
const DEFAULT_MODELS = [
  "google/gemini-3.1-flash-lite",
  "google/gemini-2.5-flash",
  "deepseek/deepseek-v4-pro",
];
const DEFAULT_TIMEOUT_MS = 120_000;
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
      ? `Это ТЗ для карго-агента (доставка из Китая). Задача — ТОЛЬКО логистика: вес, габариты, упаковка, защита при перевозке, ограничения и таможенные требования. В карго-документе НЕ должно быть вопросов о характеристиках товара (твёрдость стали, угол/тип заточки, марка материала, тип монтажа рукояти, мощность), НЕ должно быть сертификатов КАЧЕСТВА товара/материала — это к поставщику, не к карго (допустимы только документы/маркировка для ПЕРЕВОЗКИ). Строго курируй: оставь 6–8 самых важных пунктов, объедини повторы (напр. про защиту лезвия — один пункт), выброси второстепенное. Все пункты в ОДНОМ стиле — короткое требование с заглавной буквы. Не выводи английские коды характера груза — пиши по-русски («острый/режущий предмет»).`
      : `Это чек-лист для проверки образца перед закупкой партии. Задача — что подтвердить до заказа, что проверить и измерить на образце, какие фото сделать, красные флаги.`;

  return `${docGoal}

Собери из «сырья» ниже ЧИСТЫЙ документ. Тебе даны факты и черновые списки; их надо ПЕРЕПИСАТЬ и СГРУППИРОВАТЬ, а не копировать.

ЖЁСТКИЕ ПРАВИЛА:
- Только факты из «сырья». НЕ придумывай числа, размеры, мощность, сертификаты, материалы, страны.
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
- Фичи из «Заявленные фичи» (двигатель, защита от перегрева, ионизация, режимы и т.п.) упоминай ТОЛЬКО как заявленные («заявленная защита от перегрева», «по заявлению — бесщёточный двигатель»), НЕ как подтверждённый факт.
- ЛЮБОЕ свойство/стойкость (качество, острота, прочность, мощность, «устойчив/защищает/не боится» влаги, коррозии, износа, нагрева и пр.) — не как факт: либо не пиши, либо «заявлено». Требовательные способности (рубить кости, замороженное, твёрдое, тяжёлое) — не утверждай, если нет в фактах.
- НЕ придумывай числа (длину, ширину, толщину, угол, HRC, вес, мощность): нет числа в «Подтверждённых атрибутах» — не пиши его. Числа-размеры в заголовок НЕ ставь.
- Сценарии/аудиторию/место применения бери ТОЛЬКО из строки «Применение». Не расширяй бытовой товар до профессионального/коммерческого, если этого нет в фактах.
- БЕЗ оценочной воды: «высококачественный», «эффективный», «идеальный», «прочный», «долговечный», «надёжный», «профессиональный», «обеспечивает», «гарантирует».
- НЕ вставляй служебных заметок для продавца («подтвердите у поставщика», «выбранный SKU», «реальные фото», «перед публикацией») — покупатель их видеть не должен.

ФОРМАТ (как в примере):
- title: 70–120 символов, поисковый и продающий, начни с типа и синонимов.
- description: 4–6 живых предложений про выгоду и применение, с поисковыми словами.
- bullets: РОВНО 5, каждый про РАЗНОЕ, с выгодой; без дублей и пустых фраз.
- keywords: 15–25 реальных запросов покупателя (частотные + длинный хвост), без дублей.
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
  const timeoutMs = getNumberEnv("DOC_WRITER_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const maxTokens = getNumberEnv("SEO_PROSE_MAX_TOKENS", 2200);
  // Copy needs some life — 0.25 pushed the model into flat, "safe" spec-list
  // phrasing. The grounding verifier + deterministic guards catch any drift, so a
  // higher temperature is safe here and reads far less robotic.
  const temperatureRaw = Number(process.env.SEO_PROSE_TEMPERATURE);
  const temperature = Number.isFinite(temperatureRaw) ? temperatureRaw : 0.45;
  // SEO copy quality can be traded for a bit of latency by pointing this at a
  // stronger model (e.g. SEO_PROSE_MODELS=google/gemini-2.5-flash,...). Default
  // keeps the fast primary to honour the speed preference.
  const models = getEnvList("SEO_PROSE_MODELS", MODELS);

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
      // Title is a bonus: the deterministic safeSeoTitle guard is the real gate,
      // so an empty/weak title here just defers to the identity title downstream.
      const rawTitle = cleanProseLine(obj.title);
      const title =
        rawTitle.length >= 15 &&
        rawTitle.length <= 120 &&
        !/[㐀-鿿぀-ヿ]/.test(rawTitle)
          ? rawTitle
          : "";
      const keywords = Array.isArray(obj.keywords)
        ? Array.from(
            new Set(
              obj.keywords
                .map(cleanProseLine)
                .filter((k) => k && k.length <= 60 && !/[㐀-鿿぀-ヿ]/.test(k)),
            ),
          ).slice(0, 25)
        : [];
      let bullets = Array.isArray(obj.bullets)
        ? obj.bullets.map(cleanProseLine).filter(Boolean)
        : [];
      // Drop any bullet asserting an unbacked measurement number.
      bullets = bullets.filter(
        (b) => !bulletHasUnbackedNumber(b, input.confirmedAttributes),
      );
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
          description: prose.description,
          bullets: prose.bullets,
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
  draft: { description: string; bullets: string[] },
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
  return `Ты — сильный редактор карточек WB/Ozon. ПЕРЕПИШИ описание и буллеты так, чтобы они ПРОДАВАЛИ и читались как топовая карточка, — используя ТОЛЬКО факты о товаре ниже. Ничего не выдумывай.

СНАЧАЛА ОЖИВИ (это главное — сейчас текст сухой и канцелярский):
- УБЕРИ канцелярит и штампы: «оснащён», «предусмотрено», «предусмотрена система», «функционал включает», «устройство», «изделие», «предназначено для», «характеризуется», «представляет собой», «данный товар». Начинай буллеты по-разному, не «Оснащён… Предусмотрено… Функционал…».
- Пиши про ВЫГОДУ покупателя: что деталь ДАЁТ на практике («насадка-концентратор направляет поток — удобно укладывать пряди», а не «оснащён насадкой-концентратором»). Разговорный, но грамотный русский, как у людей.
- Каждый буллет — про РАЗНОЕ и живо; описание — 3–5 предложений, не рубленых.

ОСТАВЬ ЧЕСТНЫМ (не выходя за факты):
- Материал только из списка «Материалы» и только как «заявленный материал — …»; НЕ добавляй других материалов (нет в списке — не пиши), НЕ «материал изделия/товара — …», не марку голым фактом.
- Фичи из «Заявленные фичи» (двигатель, защита от перегрева, ионизация, режимы) — только как заявленные, НЕ как факт.
- Любой сценарий/аудиторию/место/свойство/способность, которых НЕТ в фактах, — убери или смягчи до заявленного. Не расширяй бытовой товар до профессионального/коммерческого.
- НЕ добавляй воду («мощный», «профессиональный», «эффективный», «высококачественный», «надёжный», «идеальный») и непроверенные числа/свойства.

ФАКТЫ О ТОВАРЕ:
${facts}

ТЕКУЩИЙ ТЕКСТ (перепиши живее, оставаясь строго в рамках фактов):
описание: ${draft.description}
буллеты:
${draft.bullets.map((b, i) => `${i + 1}. ${b}`).join("\n")}

Верни строго JSON (5 буллетов):
{"description":"...","bullets":["...","...","...","...","..."]}`;
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
  fallback: { description: string; bullets: string[] },
): { description: string; bullets: string[] } {
  const jsonStr = extractJsonObject(raw);
  if (!jsonStr) return fallback;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(jsonStr) as Record<string, unknown>;
  } catch {
    return fallback;
  }
  const description = cleanProseLine(obj.description);
  let bullets = Array.isArray(obj.bullets)
    ? obj.bullets.map(cleanProseLine).filter(Boolean)
    : [];
  bullets = bullets.filter(
    (b) => !bulletHasUnbackedNumber(b, input.confirmedAttributes),
  );
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
  return { description, bullets: bullets.slice(0, 5) };
}

export async function verifySeoGrounding(
  input: SeoProseInput,
  draft: { description: string; bullets: string[] },
): Promise<{ description: string; bullets: string[] }> {
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
    if (depth === 0) return cleaned.slice(firstBrace, i + 1);
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

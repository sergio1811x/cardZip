/**
 * Universal procurement Gap Engine — category-agnostic.
 *
 * Problem it solves: previously the supplier questions shown in the main report
 * were a merge of LLM output + hardcoded per-category KIND_RULES, ranked by a
 * brittle regex list. When the LLM produced only niche questions (e.g. for a
 * knife: HRC hardness, spine thickness), the *universal procurement basics*
 * (packed weight, package/carton dimensions, exact material grade, sharp-object
 * transport protection) were pushed out of the top-N and never reached the user.
 *
 * The engine encodes what EVERY physical 1688 import needs confirmed as a small
 * set of universal "slots". It does NOT know product categories — transport and
 * compliance needs are detected from keyword signals in the raw product text, so
 * it generalizes to any product. The LLM still supplies category-specific detail;
 * the engine only *guarantees coverage + priority* of the universal basics.
 */

export type GapSlotId =
  | "price"
  | "selected_variant"
  | "kit_contents"
  | "product_photos"
  | "material"
  | "dimensions"
  | "electrical_specs"
  | "battery_status"
  | "unit_weight_packed"
  | "package_dims"
  | "carton"
  | "transport_constraint"
  | "compliance";

/** Orders ONLY the universal basics that get appended when the LLM omitted them
 * (lower number → appended earlier). It no longer reorders the LLM's own
 * questions. Physical, verify-on-sample basics (material grade, dimensions, packed
 * weight, packaging) come before the price ask; compliance is last. */
const SLOT_PRIORITY: Record<GapSlotId, number> = {
  selected_variant: 0,
  kit_contents: 1,
  product_photos: 2,
  material: 3,
  dimensions: 4,
  electrical_specs: 5,
  battery_status: 6,
  unit_weight_packed: 7,
  package_dims: 8,
  carton: 9,
  transport_constraint: 10,
  price: 11,
  compliance: 12,
};

export interface GapEngineContext {
  /** All product text (titles, category, materials, features) lowercased for
   * signal detection. */
  productText: string;
  materials: string[];
  weightKgKnown: boolean;
  packageDimsKnown: boolean;
  priceReliable: boolean;
  selectedSkuReliable: boolean;
}

/** Detects whether an existing question already covers a universal slot, so the
 * engine does not add a duplicate ask. Keyed by slot. */
const SLOT_COVERAGE: Record<GapSlotId, RegExp> = {
  price: /цен[ауы9е]|стоимост|оптов/i,
  selected_variant: /как(ой|ому)\s+(именно\s+)?(вариант|sku|цвет|модел)|уточните\s+выбранн|какой\s+sku/i,
  kit_contents:
    /комплект|что\s+входит|входит\s+в\s+комплект|полная\s+комплектац|насадк|кабел|шнур|инструкц|кейс|футляр|чехол/i,
  product_photos:
    /реальн[а-яё]*\s+фото|фото\s+(?:выбранного\s+sku|комплект|упаковк|шильдик|маркировк|товара)/i,
  material:
    /состав(?!\s|$)|состав\s+(ткани|материал)|марк[аиуе]\s*(стали|металл|материал|пластик)|из\s+какого\s+материал|материал\s+(лезви|корпус|издели|товара|ручк|верх|подошв)/i,
  // The dimensions slot is only "covered" by a question asking for the full
  // dimensional picture (2+ axes) or an explicit size grid — a single-axis ask
  // (e.g. only spine thickness) does not close it.
  dimensions:
    /размерн(ая|ую|ой)\s+сетк|(длин[ауы]).*(ширин|высот|диаметр)|(ширин[ауы]).*(длин|высот|диаметр)|габаритн[а-яё]+\s+размер/i,
  electrical_specs:
    /тип\s+вилки|стандарт\s+вилки|напряжени|частот[аы]|маркировк[аи]\s+питания|шильдик/i,
  battery_status:
    /аккумулятор|батаре|полностью\s+проводн|встроенн[а-яё]*\s+батар/i,
  unit_weight_packed: /вес.*(с\s+упаковк|с\s+индивидуальн|брутто|в\s+упаковк)/i,
  package_dims:
    /габарит[а-яё]*\s*(индивидуальн|упаковк)|размер[а-яё]*\s*(индивидуальн|упаковк)/i,
  carton:
    /короб|карт[оа]н|транспортн[а-яё]*\s*(упаковк|коробк|короб)|шт[а-яё.]*\s*в\s*короб|в\s+коробке\s+штук/i,
  transport_constraint:
    /перевозк|защищен[оа].*(лезви|остри|стекл)|блистер|обрешёт|обрешет|герметичн|защит[аы].*(от\s+боя|при\s+транспорт)/i,
  compliance:
    /сертификат|деклараци|соответстви[ея]|регламент|\beac\b|росс[а-яё]*\s+стандарт|маркировк[аи]\s+соответств/i,
};

/**
 * Transport constraints detected from raw text (not a category enum). Returns an
 * extra question tailored to the physical hazard, or null if none apply.
 */
function detectTransportConstraint(text: string): string | null {
  if (/нож|лезви|клинок|ножниц|резак|топор|секатор|тесак|бритв|шило|\bигл[аоы]/i.test(text))
    return "Острый предмет: как защищено лезвие/остриё в индивидуальной упаковке (чехол, блистер) и подходит ли упаковка для перевозки острых предметов сборным грузом?";
  if (/стекл|керамик|фарфор|хрупк|зеркал|лампочк|стеклянн/i.test(text))
    return "Хрупкий товар: как защищён от боя при транспортировке, есть ли усиленная/противоударная упаковка?";
  if (/аккумулятор|батаре|литиев|powerbank|power\s*bank|18650|li-?ion|литий/i.test(text))
    return "Литиевые батареи в товаре: какие документы и ограничения для перевозки (MSDS, отдельная маркировка, авиа/сборный груз)?";
  if (/жидкост|\bмасл[оаяу]|крем|\bгель|спрей|шампун|лосьон|духи|парфюм|аэрозол|баллончик/i.test(text))
    return "Жидкость/паста/аэрозоль: герметичность упаковки и ограничения на перевозку (в т.ч. для авиа и сборных грузов)?";
  if (/порошок|порошков|пудр[аеы]|сыпуч/i.test(text))
    return "Сыпучий/порошковый товар: как упакован и есть ли ограничения на перевозку?";
  return null;
}

/**
 * Compliance hint detected from raw text. Returns a short parenthetical hint
 * (e.g. "контакт с пищей") or null when the product does not obviously imply a
 * regulatory need — avoids over-asking certificates for неutral goods.
 */
function detectComplianceHint(text: string): string | null {
  if (/220\s*в|электр|напряжени|мощност|зарядк|\busb\b|адаптер|розетк|вилк|электромотор|нагрев/i.test(text))
    return "электробезопасность, декларация соответствия";
  if (/детск|игрушк|для\s+детей|ребён|ребен|малыш/i.test(text))
    return "детская продукция";
  if (/кухн|посуд|для\s+еды|пищев|\bнож|тарелк|столов|разделочн|контейнер\s+для\s+(еды|продукт)|термос|бутыл[ко]/i.test(text))
    return "контакт с пищей";
  if (/космет|\bкрем|сыворотк|маск[аи]\s+для\s+лиц|уход\s+за\s+кож|парфюм/i.test(text))
    return "косметика/контакт с кожей";
  return null;
}

function isElectricalLikeText(text: string): boolean {
  return /220\s*в|электр|напряжени|мощност|зарядк|\busb\b|адаптер|розетк|вилк|электромотор|нагрев/i.test(
    text,
  );
}

export type GapSlotState = "in_card" | "must_confirm" | "not_applicable";

export interface GapSlotStatus {
  id: GapSlotId;
  /** Short human label for a checklist (NOT a full supplier question). */
  label: string;
  state: GapSlotState;
}

/**
 * Evaluates the universal procurement slots into a "known vs must-confirm"
 * checklist for briefs (e.g. buyer brief) — so a document can show WHAT still
 * needs confirming without re-dumping the full supplier-questions list. Same
 * category-agnostic signals as {@link applyUniversalGaps}.
 */
export function evaluateGapSlots(ctx: GapEngineContext): GapSlotStatus[] {
  const text = ctx.productText.toLowerCase();
  const transport = detectTransportConstraint(text);
  const compliance = detectComplianceHint(text);
  const electrical = isElectricalLikeText(text);
  return [
    {
      id: "price",
      label: "актуальную цену выбранного SKU и цену при опте",
      state: ctx.priceReliable ? "in_card" : "must_confirm",
    },
    {
      id: "selected_variant",
      label: "какой именно вариант/SKU соответствует этой цене и фото",
      state: ctx.selectedSkuReliable ? "in_card" : "must_confirm",
    },
    {
      id: "kit_contents",
      label: "точную комплектацию выбранного SKU: что входит в комплект",
      state: ctx.selectedSkuReliable ? "not_applicable" : "must_confirm",
    },
    {
      id: "product_photos",
      label: "реальные фото выбранного SKU, полной комплектации и упаковки",
      state: "must_confirm",
    },
    {
      id: "material",
      label: "точный материал и его марку/состав (не маркетинговое название)",
      state: "must_confirm",
    },
    {
      id: "dimensions",
      label: "точные габаритные размеры: длина, ширина, высота или диаметр",
      state: "must_confirm",
    },
    {
      id: "electrical_specs",
      label: electrical
        ? "тип вилки, рабочее напряжение и частоту питания по выбранному SKU"
        : "",
      state: electrical ? "must_confirm" : "not_applicable",
    },
    {
      id: "battery_status",
      label: electrical
        ? "есть ли внутри аккумулятор/батарея или устройство полностью проводное"
        : "",
      state: electrical ? "must_confirm" : "not_applicable",
    },
    {
      id: "unit_weight_packed",
      // Packed weight is never in the 1688 card (card weight = bare product) → always confirm.
      label: "вес одной единицы с индивидуальной упаковкой (брутто)",
      state: "must_confirm",
    },
    {
      id: "package_dims",
      label: "габариты индивидуальной упаковки (длина × ширина × высота)",
      state: "must_confirm",
    },
    {
      id: "carton",
      label: "количество в транспортном коробе, вес и габариты короба",
      state: "must_confirm",
    },
    {
      id: "transport_constraint",
      label: transport ?? "",
      state: transport ? "must_confirm" : "not_applicable",
    },
    {
      id: "compliance",
      label: compliance ? `сертификаты/декларации соответствия (${compliance})` : "",
      state: compliance ? "must_confirm" : "not_applicable",
    },
  ];
}

interface RankedQuestion {
  text: string;
  priority: number;
}

/** Returns the universal slot a question belongs to (for ranking), or null if it
 * is category-specific. */
function slotOf(question: string): GapSlotId | null {
  for (const [slot, rx] of Object.entries(SLOT_COVERAGE) as [GapSlotId, RegExp][]) {
    if (rx.test(question)) return slot;
  }
  return null;
}

function normKey(q: string): string {
  return q
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Guarantees the universal procurement basics are PRESENT, without reordering the
 * caller's questions.
 *
 * The LLM understands THIS product better than a fixed slot table does — for a
 * knife it rightly ranks hardness/edge geometry above the carton spec; for a
 * heater it ranks voltage/plug first. So we keep the LLM's own priority order as
 * the backbone and only APPEND the universal basics it omitted (in slot order),
 * after its questions. (An earlier version force-sorted every basic above all
 * category-specific questions, which pushed a knife's HRC/edge questions past the
 * final cap — the exact regression this avoids.)
 *
 * @param existing questions already produced downstream (already RU-cleaned), in
 *                 the LLM's intended priority order.
 * @param ctx      signals about what is known from the 1688 data.
 * @returns the existing questions in order, plus appended missing basics,
 *          de-duplicated (caller applies the final cap).
 */
export function applyUniversalGaps(
  existing: string[],
  ctx: GapEngineContext,
): string[] {
  const text = ctx.productText.toLowerCase();
  const electrical = isElectricalLikeText(text);
  const covered = new Set<GapSlotId>();
  for (const q of existing) {
    const s = slotOf(q);
    if (s) covered.add(s);
  }

  const added: RankedQuestion[] = [];
  const addIfUncovered = (slot: GapSlotId, build: () => string) => {
    if (!covered.has(slot)) {
      added.push({ text: build(), priority: SLOT_PRIORITY[slot] });
      covered.add(slot);
    }
  };

  if (!ctx.priceReliable)
    addIfUncovered("price", () => "Подтвердите актуальную цену выбранного SKU и цену при оптовом заказе.");
  if (!ctx.selectedSkuReliable)
    addIfUncovered("selected_variant", () => "Подтвердите, какой именно вариант/SKU соответствует этой цене и фото.");
  if (!ctx.selectedSkuReliable)
    addIfUncovered(
      "kit_contents",
      () => "Подтвердите точную комплектацию выбранного SKU: что входит в комплект, есть ли аксессуары, кабель, инструкция и упаковка.",
    );
  addIfUncovered(
    "product_photos",
    () => "Пришлите реальные фото выбранного SKU, полной комплектации и упаковки.",
  );
  addIfUncovered(
    "material",
    () => "Подтвердите точный материал и его марку (например, марку стали/пластика или состав ткани — не маркетинговое название).",
  );
  addIfUncovered(
    "dimensions",
    () => "Уточните точные габаритные размеры товара: длина, ширина, высота или диаметр (в мм/см).",
  );
  if (electrical)
    addIfUncovered(
      "electrical_specs",
      () => "Подтвердите тип вилки, рабочее напряжение и частоту питания по выбранному SKU, а также пришлите фото шильдика/маркировки питания.",
    );
  if (electrical)
    addIfUncovered(
      "battery_status",
      () => "Подтвердите, есть ли внутри аккумулятор/батарея или устройство полностью проводное без батареи.",
    );
  // Packed/individual weight, individual-package dims and carton are NEVER in the
  // 1688 card (the card's weight is the bare product weight), yet they're required
  // for any cargo quote — so always ask them, regardless of what bare figures the
  // card happened to list.
  addIfUncovered("unit_weight_packed", () => "Укажите вес одной единицы с индивидуальной упаковкой (брутто).");
  addIfUncovered("package_dims", () => "Укажите габариты индивидуальной упаковки (длина × ширина × высота).");
  addIfUncovered("carton", () => "Сколько штук в транспортном коробе, какой вес и габариты короба?");

  const transport = detectTransportConstraint(text);
  if (transport) addIfUncovered("transport_constraint", () => transport);

  const compliance = detectComplianceHint(text);
  if (compliance)
    addIfUncovered("compliance", () => `Есть ли сертификаты/декларации соответствия (${compliance})?`);

  // Appended basics are ordered among THEMSELVES by slot priority; the LLM's own
  // questions keep their original order and always come first.
  const appended = added
    .sort((a, b) => a.priority - b.priority)
    .map((q) => q.text);

  const seen = new Set<string>();
  return [...existing, ...appended].filter((q) => {
    const k = normKey(q);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

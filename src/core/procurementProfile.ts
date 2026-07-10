import type { ProductIntelligence } from "../types";
import {
  normalizeMixedProductText,
  extractPlugStandard,
  extractDisplayType,
  extractModelCode,
  extractColor,
  stripStockLabels,
} from "./cnNormalize";
import { normalizePrice } from "./priceNormalizer";
import {
  cleanRawAttributes,
  isMaterialLikeSupplierName,
  stripRawSourceLabels,
  containsRawPollution,
} from "./rawAttributeCleaner";
import { selectBestProductTitle, isBadTitleCandidate } from "./titleSelection";
import { sanitizeUserFacingText } from "./userFacingSanitizer";
import { isPlaceholderValue, safeTitle } from "./placeholderGuard";
import {
  applyUniversalGaps,
  evaluateGapSlots,
  type GapEngineContext,
} from "./gapEngine";

export type ProductKind =
  | "footwear"
  | "clothing"
  | "towel_kilt"
  | "umbrella"
  | "sleep_mask"
  | "mini_washer"
  | "dish_rack"
  | "kitchen_storage_rack"
  | "passive_insect_trap"
  | "usb_device"
  | "small_appliance"
  | "heating_food_mat"
  | "kitchen_tool"
  | "knife"
  | "bag_accessory"
  | "fake_security_camera"
  | "generic_product";

export type SelectedSkuDecision = {
  selectedSkuText: string | null;
  selectedPriceYuan: number | null;
  selectedPlugStandard: string | null;
  reliable: boolean;
  reason: string;
};

export type ProductProcurementProfile = {
  identity: {
    productKind: ProductKind;
    categoryType: string;
    subCategoryType: string;
    titleForReport: string;
    titleForSeo: string;
    shortTitle: string;
    coreObject: string;
    formFactor: string;
    audience: string;
    gender: string;
    season: string;
    useCases: string[];
    materials: string[];
    visibleFeatures: string[];
    claimedFeatures: string[];
    unconfirmedFeatures: string[];
  };
  sku: {
    skuSummary: string;
    selectedSkuText: string | null;
    selectedSkuReliable: boolean;
    selectedSkuDecision: SelectedSkuDecision;
    dimensions: string[];
    colors: string[];
    sizes: string[];
    models: string[];
    packageTypes: string[];
    packCounts: string[];
    plugStandards: string[];
    selectedPlugStandard: string | null;
    skuRisk: string;
    skuWarnings: string[];
    normalizedExamples: string[];
    ambiguousParams: string[];
    /** LLM-labeled SKU dimension summary, e.g. "ёмкость: 26800 мА·ч". */
    labeledParams: string[];
  };
  pricing: {
    displayPriceText: string;
    selectedPriceYuan: number | null;
    minPriceYuan: number | null;
    maxPriceYuan: number | null;
    priceSource: string;
    priceReliable: boolean;
    priceWarnings: string[];
  };
  supplier: {
    displayType: string;
    rating: string;
    orders: string;
    name: string;
    reliability: {
      level: "high" | "medium" | "low" | "unknown";
      badge: "🟢" | "🟡" | "🔴" | "⚪";
      score: number | null;
      reasons: string[];
    };
  };
  logistics: {
    weightKg: number | null;
    dimensionsCm: string | null;
    volumetricWeightKg: number | null;
  };
  procurement: {
    status: string;
    verdict: string;
    nextAction: string;
    // Deterministic hard-gate questions every document must lead with (e.g. "which
    // SKU / what's included" when the variant is unconfirmed). Already prepended to
    // mustAskSupplier; surfaced separately so briefs can lead with them too.
    leadQuestions: string[];
    // Cross-cutting critical confirmations the LLM emits ONCE per product (e.g. the
    // full electrical/compliance set for a powered device). Fanned deterministically
    // into supplier questions, cargo, sample checks AND the buyer brief so the same
    // domain block can't appear on one surface and vanish from another.
    criticalConfirmations: string[];
    mustAskSupplier: string[];
    mustCheckBeforeSample: string[];
    mustCheckOnSample: string[];
    redFlags: string[];
  };
  cargo: {
    mustAsk: string[];
    likelySensitiveCargoIssues: string[];
    whatToRequest?: string[];
    cargoNature?: string;
    packagingNotes?: string;
  };
  content: {
    seoAllowedClaims: string[];
    seoForbiddenClaims: string[];
    titleWarnings: string[];
    infographicIdeas: string[];
    seoDescription?: string;
    seoBullets?: string[];
    seoKeywords?: string[];
    seoTitle?: string;
    seoCharacteristics?: Array<{ name: string; value: string; status: string }>;
  };
  dataQuality: {
    missingCriticalFields: string[];
    contradictions: string[];
    confidence: "high" | "medium" | "low";
    reason: string;
  };
  classifier?: ProductKindDecision;
  intelligenceImages?: ProductIntelligenceImage[];
  supplierQuestionsCn?: string[];
  supplierQuestionsCnValid?: boolean;
};

export type ProductKindDecision = {
  productKind: ProductKind;
  confidence: number;
  confidenceLabel: "high" | "medium" | "low";
  visionKind: ProductKind | null;
  textKind: ProductKind | null;
  rulesKind: ProductKind;
  evidence: string[];
  disagreement: boolean;
};

export type ProductIntelligenceImage = {
  url: string;
  role:
    | "selected_sku_image"
    | "main_product_image"
    | "detail_image"
    | "package_image";
  note: string;
};

export type SupplierQuestionsProfileResult = {
  ru: string[];
  cn: string[];
  cnValid: boolean;
  text: string;
  label: string;
  errors: string[];
};

const YUAN_TO_RUB = 11.8;
const BANK_MARKUP = 0.03;
const FULFILLMENT_RUB = 80;

const DANGEROUS_CLAIMS = [
  "медицинский",
  "ортопедический",
  "лечебный",
  "антибактериальный",
  "сертифицированный",
  "гипоаллергенный",
  "безопасный для детей",
  "профессиональный",
  "оригинальный бренд",
  "100% водонепроницаемый",
  "UPF50+",
  "дезинфекция",
  "стерилизация",
];

const DISH_RACK_RULES = {
  mustAskSupplier: [
    "Подтвердите цену выбранного SKU.",
    "Укажите количество ярусов и размеры товара в собранном виде: длина, ширина, высота.",
    "Уточните, что означает размер 43/53 см: длина, ширина или другой параметр?",
    "Подтвердите материал каркаса и тип покрытия.",
    "Что входит в “полный комплект”: поддон, держатели, крючки, полки?",
    "Есть ли съёмный поддон для воды?",
    "Укажите вес одной единицы с индивидуальной упаковкой.",
    "Укажите габариты индивидуальной упаковки.",
    "Пришлите реальные фото выбранного SKU, комплектации и упаковки.",
    "Можно ли заказать 1–2 образца?",
  ],
  beforeSample: [
    "подтвердить размеры в собранном виде",
    "уточнить, что означает размер 43/53 см",
    "подтвердить материал каркаса и тип покрытия",
    "подтвердить состав полного комплекта",
    "получить фото сборки, комплектации и упаковки",
    "получить вес и габариты индивидуальной упаковки",
  ],
  onSample: [
    "фактическое количество ярусов",
    "размеры в собранном виде",
    "устойчивость на столешнице",
    "не шатается ли конструкция",
    "качество сварки и соединений",
    "качество покрытия",
    "нет ли сколов, ржавчины и острых кромок",
    "помещаются ли тарелки, чашки, стаканы и приборы",
    "есть ли поддон и как он снимается",
    "простота сборки",
    "комплектация",
    "упаковка после доставки",
  ],
  cargo: [
    "вес одной единицы с упаковкой",
    "габариты индивидуальной упаковки",
    "разборная или цельная конструкция",
    "количество в транспортной коробке",
    "вес транспортной коробки",
    "габариты транспортной коробки",
    "фото индивидуальной упаковки",
    "фото транспортной коробки",
    "нужна ли защита от деформации металлических деталей",
    "как упакованы поддоны, держатели и крючки",
  ],
  redFlags: [
    "не подтверждён материал каркаса",
    "не подтверждено покрытие",
    "неизвестен вес и габариты упаковки",
    "непонятно, что входит в полный комплект",
    "риск деформации при доставке",
    "риск сколов или ржавчины",
    "неизвестна устойчивость конструкции",
    "размеры 43/53 см требуют уточнения",
  ],
  seoAllowed: [
    "настольная сушилка для посуды",
    "стеллаж для посуды",
    "кухонный органайзер",
    "для тарелок, чашек, стаканов и столовых приборов",
    "многоярусная конструкция",
  ],
  seoForbidden: [
    "нержавеющая сталь без подтверждения",
    "антикоррозийная без подтверждения",
    "не ржавеет без теста",
    "усиленная без подтверждения",
    "выдерживает большой вес без теста",
    "премиальная без подтверждения",
    "безопасная без документов",
    "экологичная без документов",
    "100% влагостойкая без теста",
    "профессиональная без подтверждения",
  ],
  infographic: [
    "Размеры и количество ярусов",
    "Что входит в полный комплект",
    "Для тарелок, чашек и столовых приборов",
    "Съёмный поддон и уход, если подтверждено",
    "Что проверить перед покупкой: материал, покрытие, устойчивость",
  ],
  forbiddenCategoryWords: [
    "напряжение",
    "мощность",
    "тип вилки",
    "батарея",
    "аккумулятор",
    "медицинский",
    "ортопедический",
    "UPF",
    "cross-border",
    "для cross-border торговли функции",
    "тип товара: home",
  ],
};

const KIND_RULES: Record<
  ProductKind,
  {
    mustAskSupplier: string[];
    beforeSample: string[];
    onSample: string[];
    cargo: string[];
    redFlags: string[];
    seoAllowed: string[];
    seoForbidden: string[];
    infographic: string[];
    forbiddenCategoryWords: string[];
  }
> = {
  dish_rack: DISH_RACK_RULES,
  kitchen_storage_rack: DISH_RACK_RULES,
  umbrella: {
    mustAskSupplier: [
      "Подтвердите цену выбранного SKU.",
      "Укажите вес с упаковкой выбранного SKU.",
      "Укажите габариты индивидуальной упаковки.",
      "Укажите длину зонта в сложенном виде.",
      "Укажите диаметр купола в раскрытом виде.",
      "Сколько спиц у выбранного SKU?",
      "Какой материал купола и спиц?",
      "Есть ли чехол в комплекте? Пришлите фото открытого/закрытого зонта и упаковки.",
    ],
    beforeSample: [
      "подтвердить цену SKU",
      "получить вес и габариты",
      "уточнить параметры SKU",
      "запросить фото открытого и закрытого зонта",
      "уточнить наличие чехла",
    ],
    onSample: [
      "работу механизма",
      "не заедает ли кнопка",
      "прочность спиц",
      "люфт ручки",
      "качество ткани купола",
      "швы",
      "водоотталкивание",
      "размер в раскрытом виде",
      "длину в сложенном виде",
      "чехол и упаковку",
    ],
    cargo: [
      "длина в сложенном виде",
      "упаковка, чтобы не погнулись спицы",
      "вес с упаковкой выбранного SKU",
      "габариты индивидуальной упаковки",
    ],
    redFlags: [
      "не подтверждён материал спиц/купола",
      "нет веса с упаковкой",
      "механизм заедает",
      "UPF50+ заявлен без подтверждения",
      "нет фото упаковки",
    ],
    seoAllowed: [
      "складной формат",
      "автоматический механизм, если подтверждён",
      "чехол, если в комплекте",
      "цвета и сценарии использования",
    ],
    seoForbidden: [
      "UPF50+ без документов",
      "ветроустойчивый без теста",
      "100% защита от дождя",
      "премиальный без подтверждения",
    ],
    infographic: [
      "Зонт складной автоматический",
      "Крючок и ручка крупно",
      "Размер в сложенном и раскрытом виде",
      "Цвета и купол",
      "Чехол и упаковка",
    ],
    forbiddenCategoryWords: [
      "подошва",
      "стелька",
      "размерная сетка",
      "срок годности",
      "консистенция",
      "мощность",
      "напряжение",
      "тип вилки",
    ],
  },
  footwear: {
    mustAskSupplier: [
      "Подтвердите цену выбранного SKU.",
      "Укажите вес пары с упаковкой.",
      "Пришлите размерную сетку и длину стельки.",
      "Подтвердите материал верха и подошвы.",
      "Укажите размеры коробки одной пары.",
      "Есть ли запах EVA/PU после распаковки?",
      "Пришлите реальные фото пары и упаковки.",
      "Можно ли заказать 1–2 образца?",
    ],
    beforeSample: [
      "подтвердить размер и цену SKU",
      "получить размерную сетку",
      "получить вес пары и габариты коробки",
      "запросить фото пары и упаковки",
    ],
    onSample: [
      "соответствие размеру",
      "длину стельки",
      "материал верха",
      "материал подошвы",
      "запах EVA/PU",
      "качество декора",
      "склейку/литьё",
      "вес пары с упаковкой",
      "упаковку",
    ],
    cargo: ["вес пары с упаковкой", "размеры коробки одной пары"],
    redFlags: [
      "нет размерной сетки",
      "сильный запах",
      "скользкая подошва",
      "плохая склейка/литьё",
      "нет реальных фото",
    ],
    seoAllowed: [
      "EVA, если подтверждено",
      "несколько цветов/размеров",
      "для дома/пляжа/дачи, если подходит по товару",
    ],
    seoForbidden: [
      "ортопедический без документов",
      "медицинский без документов",
      "антибактериальный без документов",
    ],
    infographic: [
      "Сабо/обувь крупно",
      "Материал и подошва",
      "Размерная сетка",
      "Цвета",
      "Упаковка",
    ],
    forbiddenCategoryWords: [
      "мощность",
      "напряжение",
      "тип вилки",
      "аккумулятор",
      "рукав",
      "усадка после стирки",
    ],
  },
  sleep_mask: {
    mustAskSupplier: [
      "Подтвердите цену выбранного SKU.",
      "Укажите вес с упаковкой.",
      "Укажите размер маски.",
      "Подтвердите материал лицевой и внутренней части.",
      "Какой тип упаковки: OPP или коробка?",
      "Регулируется ли ремешок?",
      "Подтвердите 3D-форму и затемнение.",
      "Пришлите реальные фото выбранного цвета и упаковки.",
    ],
    beforeSample: [
      "подтвердить материал",
      "получить вес и упаковку",
      "уточнить ремешок",
      "запросить фото выбранного цвета",
    ],
    onSample: [
      "мягкость материала",
      "форму 3D-углублений",
      "не давит ли на глаза",
      "не давит ли на нос",
      "качество резинки/ремешка",
      "затемнение на свету",
      "запах после распаковки",
      "швы и края",
      "комфорт 10–15 минут",
      "упаковку OPP/коробка",
    ],
    cargo: [
      "вес с упаковкой",
      "габариты индивидуальной упаковки",
      "тип упаковки",
    ],
    redFlags: [
      "давит на глаза/нос",
      "резкий запах",
      "слабое затемнение",
      "плохие швы",
      "не подтверждён материал",
    ],
    seoAllowed: [
      "мягкая маска",
      "3D-форма, если подтверждена",
      "регулируемый ремешок, если подтверждён",
    ],
    seoForbidden: [
      "лечебный сон",
      "гипоаллергенный без документов",
      "100% затемнение без теста",
    ],
    infographic: [
      "Маска для сна",
      "3D-углубления",
      "Ремешок",
      "Затемнение",
      "Упаковка",
    ],
    forbiddenCategoryWords: [
      "срок годности",
      "консистенция",
      "подошва",
      "тип вилки",
      "мощность",
      "напряжение",
    ],
  },
  mini_washer: {
    mustAskSupplier: [
      "Подтвердите цену выбранного SKU.",
      "Укажите мощность и напряжение.",
      "Какой тип вилки?",
      "Укажите длину кабеля.",
      "Какой реальный объём?",
      "Какие режимы работы?",
      "Есть ли слив?",
      "Пришлите видео работы, инструкцию и фото упаковки.",
    ],
    beforeSample: [
      "подтвердить вилку/напряжение",
      "получить видео работы",
      "уточнить слив",
      "получить вес и габариты",
      "запросить инструкцию",
    ],
    onSample: [
      "включается ли от нужного напряжения",
      "не течёт ли корпус",
      "как работает слив",
      "шум и вибрацию",
      "качество пластика",
      "фактический объём",
      "режимы работы",
      "длину кабеля",
      "комплектацию",
      "инструкцию",
      "упаковку после доставки",
    ],
    cargo: [
      "вес с упаковкой",
      "габариты упаковки",
      "есть ли батарейка/аккумулятор",
      "тип вилки",
      "напряжение",
      "сертификаты",
    ],
    redFlags: [
      "нет данных по напряжению/вилке",
      "нет видео работы",
      "протечки",
      "сильный шум/вибрация",
      "нет инструкции",
    ],
    seoAllowed: [
      "портативная стиральная машина",
      "режимы работы, если подтверждены",
      "объём, если подтверждён",
    ],
    seoForbidden: [
      "дезинфекция без документов",
      "стерилизация без документов",
      "безопасна для детей без документов",
      "профессиональная без подтверждения",
    ],
    infographic: [
      "Мини-стиральная машина",
      "Панель/режимы",
      "Слив",
      "Комплектация",
      "Упаковка",
    ],
    forbiddenCategoryWords: [
      "подошва",
      "стелька",
      "рукав",
      "состав ткани в процентах",
      "срок годности",
      "консистенция",
    ],
  },
  clothing: {
    mustAskSupplier: [
      "Подтвердите цену выбранного SKU.",
      "Укажите состав ткани.",
      "Пришлите размерную сетку.",
      "Укажите замеры изделия.",
      "Есть ли усадка после стирки?",
      "Укажите вес с упаковкой.",
      "Пришлите реальные фото ткани, бирки и упаковки.",
      "Можно ли заказать 1–2 образца?",
    ],
    beforeSample: [
      "подтвердить состав",
      "получить размерную сетку",
      "получить замеры",
      "запросить фото ткани/бирки",
    ],
    onSample: [
      "состав и плотность ткани",
      "посадку",
      "швы",
      "цветопередачу",
      "усадку после стирки",
      "бирки",
      "упаковку",
    ],
    cargo: ["вес с упаковкой", "габариты упаковки", "количество в коробке"],
    redFlags: [
      "нет состава",
      "нет размерной сетки",
      "сильная усадка",
      "плохие швы",
    ],
    seoAllowed: ["состав, если подтверждён", "сезонность", "сценарии носки"],
    seoForbidden: ["лечебный", "сертифицированный без документов"],
    infographic: [
      "Одежда общий вид",
      "Ткань крупно",
      "Размеры",
      "Детали",
      "Упаковка",
    ],
    forbiddenCategoryWords: [
      "мощность",
      "напряжение",
      "тип вилки",
      "аккумулятор",
      "подошва",
    ],
  },
  towel_kilt: {
    mustAskSupplier: [
      "Подтвердите цену выбранного SKU.",
      "Укажите состав ткани.",
      "Укажите плотность/вес изделия.",
      "Укажите размеры.",
      "Как фиксируется изделие?",
      "Пришлите реальные фото ткани и упаковки.",
      "Укажите вес с упаковкой.",
      "Можно ли заказать образец?",
    ],
    beforeSample: [
      "подтвердить состав",
      "получить размеры",
      "получить вес",
      "запросить фото ткани",
    ],
    onSample: [
      "мягкость ткани",
      "впитываемость",
      "качество фиксации",
      "швы",
      "размер",
      "упаковку",
    ],
    cargo: ["вес с упаковкой", "габариты упаковки", "количество в коробке"],
    redFlags: ["нет состава ткани", "плохая фиксация", "тонкая ткань"],
    seoAllowed: ["полотенце-килт", "для душа/бани, если подходит"],
    seoForbidden: [
      "мужская юбка-полотенце",
      "антибактериальный без документов",
    ],
    infographic: [
      "Полотенце-килт",
      "Материал",
      "Фиксация",
      "Размер",
      "Упаковка",
    ],
    forbiddenCategoryWords: [
      "мужская юбка-полотенце",
      "подошва",
      "тип вилки",
      "мощность",
    ],
  },
  passive_insect_trap: {
    mustAskSupplier: [
      "Подтвердите цену выбранного SKU.",
      "Укажите количество штук в комплекте.",
      "Укажите размер одной ловушки.",
      "Подтвердите материал.",
      "Есть ли приманка в комплекте?",
      "Как крепится или размещается товар?",
      "Укажите вес и габариты упаковки.",
      "Пришлите реальные фото товара и упаковки.",
    ],
    beforeSample: [
      "подтвердить комплектацию",
      "получить размер",
      "получить вес",
      "запросить фото упаковки",
    ],
    onSample: [
      "размер и материал",
      "комплектацию",
      "крепление/размещение",
      "поверхность/липкость, если применимо",
      "упаковку",
    ],
    cargo: [
      "вес выбранной комплектации",
      "габариты упаковки",
      "количество штук в комплекте",
      "количество комплектов в коробке",
      "фото упаковки",
    ],
    redFlags: [
      "непонятная комплектация",
      "нет размера/материала",
      "появились электрические claims у пассивной ловушки",
    ],
    seoAllowed: ["пассивная ловушка", "комплектация", "способ размещения"],
    seoForbidden: [
      "электрическая без подтверждения",
      "ультразвуковая без подтверждения",
      "100% избавляет от насекомых",
    ],
    infographic: [
      "Пассивная ловушка",
      "Как использовать",
      "Комплектация",
      "Материал",
      "Упаковка",
    ],
    forbiddenCategoryWords: [
      "мощность",
      "напряжение",
      "тип вилки",
      "аккумулятор",
      "лампа",
    ],
  },
  fake_security_camera: {
    mustAskSupplier: [
      "Подтвердите цену выбранного SKU.",
      "Как реализовано питание светодиода: батарейки, аккумулятор или без питания?",
      "Входят ли батарейки в комплект?",
      "Как работает светодиод: мигает, горит постоянно, реагирует на движение или включается вручную?",
      "Можно ли отключить светодиод?",
      "Укажите размеры: диаметр и высоту.",
      "Укажите вес единицы с упаковкой.",
      "Укажите габариты индивидуальной упаковки.",
      "Подтвердите материал корпуса.",
      "Что входит в комплектацию: крепёж, наклейки, инструкция?",
      "Пришлите реальные фото товара и упаковки.",
      "Можно ли заказать 1–2 образца?",
    ],
    beforeSample: [
      "подтвердить питание и комплектацию",
      "получить размеры и вес",
      "запросить фото",
    ],
    onSample: [
      "реалистичность внешнего вида",
      "качество пластика",
      "качество купола/линзы",
      "работа светодиода",
      "тип батареек и замена",
      "наличие крепежа",
      "установка на стену/потолок",
      "качество упаковки",
      "соответствие цвета SKU",
    ],
    cargo: [
      "вес единицы с упаковкой",
      "габариты индивидуальной упаковки",
      "количество в транспортной коробке",
      "вес коробки",
      "габариты коробки",
      "есть ли батарейки",
      "фото индивидуальной упаковки",
      "фото коробки",
    ],
    redFlags: [
      "цена SKU не подтверждена",
      "неясно питание светодиода",
      "неясно, входят ли батарейки",
      "работа светодиода не подтверждена",
      "нет веса с упаковкой",
      "нет габаритов упаковки",
      "риск претензий из-за позиционирования как настоящей камеры",
    ],
    seoAllowed: [
      "муляж камеры видеонаблюдения",
      "имитация камеры",
      "декоративная камера",
      "визуальная имитация видеонаблюдения",
      "красный светодиод (после подтверждения)",
      "для дома/офиса/магазина как визуальный декор",
    ],
    seoForbidden: [
      "настоящая камера",
      "видеонаблюдение",
      "запись видео",
      "обнаружение движения",
      "ночное видение",
      "Wi-Fi",
      "приложение",
      "антивандальная",
      "водонепроницаемая",
      "работает от батареек (без подтверждения)",
      "мигающий светодиод (без подтверждения)",
      ...DANGEROUS_CLAIMS,
    ],
    infographic: [
      "Камера-муляж общий вид",
      "Купол и светодиод",
      "Размеры",
      "Крепёж и комплектация",
      "Упаковка",
    ],
    forbiddenCategoryWords: [
      "подошва",
      "стелька",
      "срок годности",
      "тип вилки",
      "напряжение",
      "мощность",
      "режимы нагрева",
    ],
  },
  heating_food_mat: {
    mustAskSupplier: [
      "Подтвердите цену выбранного SKU.",
      "Уточните модель и её отличие: ламповая индикация или цифровой дисплей.",
      "Подтвердите цвет выбранного SKU.",
      "Уточните стандарт вилки: EU/US/UK/JP.",
      "Укажите напряжение и мощность по маркировке.",
      "Пришлите фото шильдика (таблички с маркировкой).",
      "Укажите температурный диапазон и шаг регулировки.",
      "Есть ли автоотключение?",
      "Есть ли защита от перегрева?",
      "Подтвердите материалы: покрытие, нагревательный элемент, нижняя часть.",
      "Совместима ли с металлической/керамической/стеклянной посудой?",
      "Укажите максимальную нагрузку и размер посуды.",
      "Есть ли запах при первом включении?",
      "Есть ли инструкция?",
      "Есть ли сертификаты CE/RoHS/UKCA/ETL/GS?",
      "Укажите вес единицы с упаковкой.",
      "Укажите габариты упаковки.",
      "Пришлите видео работы.",
      "Можно ли заказать 1–2 образца?",
    ],
    beforeSample: [
      "подтвердить вилку, напряжение и мощность",
      "получить фото шильдика",
      "получить вес и габариты",
      "запросить видео работы",
    ],
    onSample: [
      "соответствие вилки выбранному SKU",
      "напряжение и мощность на шильдике",
      "работу дисплея",
      "скорость нагрева",
      "равномерность нагрева",
      "фактическую температуру пирометром",
      "автоотключение, если заявлено",
      "запах при работе",
      "качество силикона",
      "устойчивость на столе",
      "нагрев нижней части",
      "кабель и вилку",
      "инструкцию и маркировку",
      "упаковку после доставки",
    ],
    cargo: [
      "вес с упаковкой",
      "габариты индивидуальной упаковки",
      "количество в транспортной коробке",
      "вес коробки",
      "габариты коробки",
      "фото индивидуальной упаковки",
      "фото коробки",
      "есть ли аккумулятор или батарея",
      "есть ли магнит",
      "есть ли жидкость",
      "тип вилки",
      "сертификаты",
      "защита от сгиба/деформации силикона",
    ],
    redFlags: [
      "цена SKU не подтверждена",
      "стандарт вилки не подтверждён",
      "напряжение/мощность не подтверждены",
      "нет фото шильдика",
      "нет видео работы",
      "нет сертификатов",
      "поставщик с 0 заказов",
      "неизвестен вес с упаковкой",
      "риск запаха/перегрева/деформации",
    ],
    seoAllowed: [
      "греющая подставка для еды",
      "подставка для подогрева блюд",
      "гибкая подставка",
      "цифровой дисплей (только если модель с дисплеем подтверждена)",
      "поддержание температуры готовых блюд",
      "регулировка температуры (после подтверждения)",
      "автоотключение (после подтверждения)",
    ],
    seoForbidden: [
      "безопасная",
      "сертифицированная",
      "равномерный нагрев",
      "быстрый нагрев",
      "защита от перегрева",
      "автоотключение",
      "пищевой силикон",
      "водонепроницаемая",
      "энергосберегающая",
      "подходит для любой посуды",
      "не пахнет",
      "можно мыть водой",
      ...DANGEROUS_CLAIMS,
    ],
    infographic: [
      "Подставка общий вид",
      "Дисплей и регулировка",
      "Стандарт вилки и маркировка",
      "Материал поверхности",
      "Упаковка",
    ],
    forbiddenCategoryWords: [
      "подошва",
      "стелька",
      "размерная сетка",
      "срок годности",
      "консистенция",
    ],
  },
  knife: {
    mustAskSupplier: [
      "Подтвердите цену выбранного SKU.",
      "Укажите марку и твёрдость стали (например 3CR13/4CR13/5CR15, значение HRC).",
      "Укажите длину и толщину клинка.",
      "Уточните тип и угол заточки, заточен ли нож с завода.",
      "Подтвердите материал рукояти и способ крепления (заклёпки/литьё).",
      "Клинок цельный (сквозной хвостовик) или накладной?",
      "Есть ли антикоррозийная обработка или покрытие клинка?",
      "Укажите вес и баланс ножа.",
      "Что входит в комплектацию: чехол, коробка, заточка?",
      "Укажите вес одной единицы с упаковкой.",
    ],
    beforeSample: [
      "подтвердить марку стали и HRC",
      "подтвердить геометрию клинка (длина, толщина, заточка)",
      "получить вес и габариты с упаковкой",
      "запросить реальные фото клинка, острия и хвостовика",
    ],
    onSample: [
      "фактическую остроту из коробки",
      "удержание кромки после теста реза",
      "ровность и качество спусков",
      "отсутствие люфта рукояти",
      "коррозию после мойки и контакта с влагой",
      "баланс и удобство хвата",
      "качество заклёпок и стыка рукоять–клинок",
      "заусенцы и дефекты режущей кромки",
      "упаковку и защиту лезвия",
    ],
    cargo: [
      "вес и габариты с упаковкой",
      "как защищено лезвие при перевозке (чехол/блистер)",
      "острые/режущие предметы — уточнить у карго ограничения и требования к упаковке",
      "количество и вес транспортной коробки",
      "фото упаковки",
    ],
    redFlags: [
      "не подтверждена марка/твёрдость стали",
      "неизвестна геометрия клинка",
      "риск коррозии дешёвой стали",
      "люфт рукояти",
      "нет реальных фото",
      "острый предмет — требования к перевозке и упаковке не подтверждены",
    ],
    seoAllowed: [
      "кухонный нож",
      "нож для нарезки/шинковки",
      "клинок из нержавеющей стали (марку указывать только подтверждённую)",
      "эргономичная рукоять (после подтверждения)",
    ],
    seoForbidden: [
      "хирургическая сталь",
      "профессиональная заточка без подтверждения",
      "не тупится",
      "вечная острота",
      "дамасская сталь без подтверждения",
      "японская сталь без подтверждения",
      ...DANGEROUS_CLAIMS,
    ],
    infographic: [
      "Нож общий вид",
      "Клинок и марка стали",
      "Рукоять и хвостовик",
      "Размеры",
      "Упаковка и защита лезвия",
    ],
    forbiddenCategoryWords: [
      "напряжение",
      "мощность",
      "тип вилки",
      "подошва",
      "стелька",
      "срок годности",
    ],
  },
  usb_device: genericRules("USB-товар"),
  small_appliance: genericRules("малая техника"),
  kitchen_tool: genericRules("кухонный товар"),
  bag_accessory: genericRules("аксессуар"),
  generic_product: genericRules("товар"),
};

function genericRules(label: string) {
  return {
    mustAskSupplier: [
      `Подтвердите цену выбранного SKU.`,
      `Укажите вес одной единицы с индивидуальной упаковкой.`,
      `Укажите габариты индивидуальной упаковки.`,
      `Подтвердите основной материал и покрытие/отделку.`,
      `Подтвердите комплектацию выбранного SKU: что входит в коробку/пакет.`,
      `Пришлите реальные фото выбранного SKU, комплектации и упаковки.`,
      `Укажите MOQ и срок отгрузки по выбранному SKU.`,
      `Можно ли заказать 1–2 образца перед партией?`,
    ],
    beforeSample: [
      "подтвердить цену SKU",
      "получить вес и габариты",
      "уточнить материал и комплектацию",
      "запросить фото товара и упаковки",
    ],
    onSample: [
      `соответствие выбранному SKU`,
      `фактический материал/покрытие`,
      `полную комплектацию выбранного SKU`,
      `фактические размеры и сборку/форму, если применимо`,
      `вес с упаковкой и состояние упаковки после доставки`,
      `заявленные свойства только через проверку образца`,
    ],
    cargo: [
      "вес одной единицы с упаковкой",
      "габариты индивидуальной упаковки",
      "количество в транспортной коробке",
      "вес транспортной коробки",
      "габариты транспортной коробки",
    ],
    redFlags: [
      "нет веса/габаритов",
      "не подтверждён материал",
      "нет реальных фото",
      "непонятная комплектация",
    ],
    seoAllowed: [label, "материал, если подтверждён", "сценарии применения"],
    seoForbidden: DANGEROUS_CLAIMS,
    infographic: [
      "Главное фото товара",
      "Материал и детали",
      "Размер/формат",
      "Комплектация",
      "Упаковка",
    ],
    forbiddenCategoryWords: [],
  };
}

function isBalaclavaProduct(product: any, intelligence?: any): boolean {
  const raw =
    `${product?.titleRu ?? ""} ${product?.titleEn ?? ""} ${product?.titleCn ?? ""} ${product?.categoryName ?? ""} ${JSON.stringify(product?.attributes ?? [])} ${JSON.stringify(intelligence ?? {})}`.toLowerCase();
  return /балаклав|подшлемник|balaclava|face\s*mask|面罩|头套|防晒面罩/.test(
    raw,
  );
}


// The LLM's single, cross-cutting "critical confirmations" list for this product —
// the domain block (e.g. the electrical/compliance set for a powered device) that
// MUST reach every surface. Emitted once by the canonicalizer so the deterministic
// layer can fan it out consistently instead of hoping each per-surface list repeats
// it. Category-agnostic: the model decides the content from what the product IS.
function aiCriticalConfirmations(product: any): string[] {
  const draft = record(
    product?.productProcurementProfileDraft ??
      product?.procurementProfileDraft ??
      product?.productContext?.procurementProfileDraft ??
      product?.productContext?.profileDraft,
  );
  const rules = record(draft.domainRules ?? product?.productContext?.domainRules);
  return uniq(
    array<string>(rules.criticalConfirmations).map(safeRu).filter(Boolean),
    10,
  );
}

function aiDomainRules(product: any): Partial<(typeof KIND_RULES)[ProductKind]> {
  const draft = record(
    product?.productProcurementProfileDraft ??
      product?.procurementProfileDraft ??
      product?.productContext?.procurementProfileDraft ??
      product?.productContext?.profileDraft,
  );
  const rules = record(draft.domainRules);
  return {
    mustAskSupplier: array<string>(rules.buyerMustCheck).map(safeRu),
    beforeSample: array<string>(rules.mustCheckBeforeSample ?? rules.buyerMustCheck).map(safeRu),
    onSample: array<string>(rules.sampleMustCheck).map(safeRu),
    cargo: array<string>(rules.cargoMustAsk).map(safeRu),
    redFlags: array<string>(rules.redFlags).map(safeRu),
    seoAllowed: array<string>(rules.seoAllowedClaims).map(safeRu),
    seoForbidden: array<string>(rules.seoForbiddenClaims).map(safeRu),
    infographic: array<string>(rules.infographicIdeas).map(safeRu),
    forbiddenCategoryWords: array<string>(rules.forbiddenOtherCategoryTerms).map(safeRu),
  };
}

/**
 * Reads the richer, product-specific SEO + cargo content the LLM canonicalizer
 * emits under `domainRules.seo` / `domainRules.cargo`. Defensive: every field may
 * be missing/empty on older jobs, in which case the deterministic builders fall
 * back to their template output.
 */
function aiDomainContent(product: any): {
  seoDescription: string;
  seoBullets: string[];
  seoKeywords: string[];
  cargoWhatToRequest: string[];
  cargoSensitiveIssues: string[];
  cargoNature: string;
  cargoPackagingNotes: string;
  seoTitle: string;
  seoCharacteristics: Array<{ name: string; value: string; status: string }>;
} {
  const draft = record(
    product?.productProcurementProfileDraft ??
      product?.procurementProfileDraft ??
      product?.productContext?.procurementProfileDraft ??
      product?.productContext?.profileDraft,
  );
  const rules = record(
    draft.domainRules ?? product?.productContext?.domainRules,
  );
  const seo = record(rules.seo);
  const cargo = record(rules.cargo);
  return {
    seoDescription: safeRu(seo.description),
    seoBullets: array<string>(seo.sellingBullets).map(safeRu).filter(Boolean),
    seoKeywords: array<string>(seo.keywords).map(safeRu).filter(Boolean),
    cargoWhatToRequest: array<string>(cargo.whatToRequest)
      .map(safeRu)
      .filter(Boolean),
    cargoSensitiveIssues: array<string>(cargo.sensitiveIssues)
      .map(safeRu)
      .filter(Boolean),
    cargoNature: safeRu(cargo.cargoNature),
    cargoPackagingNotes: safeRu(cargo.packagingNotes),
    seoTitle: safeRu(seo.title),
    seoCharacteristics: array<any>(seo.characteristics)
      .map((c) => ({
        name: safeRu(c?.name),
        value: safeRu(c?.value),
        status: safeRu(c?.status) || "подтвердить у поставщика",
      }))
      .filter((c) => c.name && c.value),
  };
}

function mergeRuleLists(base: (typeof KIND_RULES)[ProductKind], extra: Partial<(typeof KIND_RULES)[ProductKind]>): (typeof KIND_RULES)[ProductKind] {
  return {
    mustAskSupplier: uniq([...(extra.mustAskSupplier ?? []), ...base.mustAskSupplier], 12),
    beforeSample: uniq([...(extra.beforeSample ?? []), ...base.beforeSample], 10),
    onSample: uniq([...(extra.onSample ?? []), ...base.onSample], 14),
    cargo: uniq([...(extra.cargo ?? []), ...base.cargo], 14),
    redFlags: uniq([...(extra.redFlags ?? []), ...base.redFlags], 14),
    seoAllowed: uniq([...(extra.seoAllowed ?? []), ...base.seoAllowed], 14),
    seoForbidden: uniq([...(extra.seoForbidden ?? []), ...base.seoForbidden], 20),
    infographic: uniq([...(extra.infographic ?? []), ...base.infographic], 8),
    forbiddenCategoryWords: uniq([...(extra.forbiddenCategoryWords ?? []), ...base.forbiddenCategoryWords], 20),
  };
}

function productSpecificRules(
  kind: ProductKind,
  product: any,
  intelligence?: any,
): (typeof KIND_RULES)[ProductKind] {
  const base = mergeRuleLists(KIND_RULES[kind] ?? KIND_RULES.generic_product, aiDomainRules(product));
  if (kind === "clothing" && isBalaclavaProduct(product, intelligence)) {
    return {
      ...base,
      mustAskSupplier: [
        "Подтвердите цену выбранного SKU.",
        "Укажите вес одной балаклавы с индивидуальной упаковкой.",
        "Укажите размеры индивидуальной упаковки.",
        "Подтвердите состав ткани в процентах.",
        "Укажите точные размеры балаклавы: длина, ширина, растяжимость.",
        "Подтвердите, есть ли сетчатая зона для дыхания.",
        "Если заявлена УФ-защита, есть ли подтверждение или тест?",
        "Пришлите реальные фото выбранного цвета, фото на модели и фото упаковки.",
        "Можно ли заказать 1–2 образца перед партией?",
      ],
      beforeSample: [
        "подтвердить цену SKU",
        "получить вес и габариты",
        "подтвердить состав ткани в процентах",
        "уточнить размеры и растяжимость",
        "запросить фото на модели, бирки и упаковки",
      ],
      onSample: [
        "комфорт дыхания через сетчатую зону",
        "качество швов",
        "растяжимость ткани",
        "посадку на голове и лице",
        "не давит ли в зоне носа и ушей",
        "состав и плотность ткани",
        "качество бирки/маркировки",
        "упаковку",
      ],
      cargo: [
        "вес одной балаклавы с упаковкой",
        "габариты индивидуальной упаковки",
        "количество штук в транспортной коробке",
        "вес транспортной коробки",
        "габариты транспортной коробки",
        "фото индивидуальной и транспортной упаковки",
      ],
      redFlags: [
        "не подтверждён состав ткани",
        "нет размеров и растяжимости",
        "сетчатая зона мешает дыханию",
        "нет фото на модели",
        "УФ-защита заявлена без подтверждения",
      ],
      seoAllowed: [
        "для велосипеда, туризма и активного отдыха",
        "закрывает голову, лицо и шею",
        "сетчатая зона для дыхания, если подтверждена",
        "несколько цветов",
      ],
      seoForbidden: [
        "UPF50+ без документов",
        "медицинская защита",
        "профессиональная защита без подтверждения",
        "100% защита от солнца/пыли",
      ],
      infographic: [
        "Балаклава для велосипеда и активного отдыха",
        "Сетчатая зона для дыхания",
        "Закрывает лицо и шею",
        "Цвета",
        "Размеры и упаковка",
      ],
      forbiddenCategoryWords: [
        "подошва",
        "стелька",
        "тип вилки",
        "мощность",
        "напряжение",
        "срок годности",
      ],
    };
  }
  return base;
}

function array<T = any>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}
function record(v: unknown): Record<string, any> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, any>)
    : {};
}
function clean(v: unknown): string {
  return String(v ?? "")
    .replace(/\b(?:undefined|null|NaN|Infinity|-Infinity)\b/gi, "—")
    .replace(/\s+/g, " ")
    .trim();
}
function safeRu(v: unknown): string {
  return clean(normalizeMixedProductText(v))
    .replace(/[一-鿿]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = Number(
    String(v ?? "")
      .replace(",", ".")
      .replace(/[^\d.-]/g, ""),
  );
  return Number.isFinite(n) ? n : null;
}
function pos(v: unknown): number | null {
  const n = num(v);
  return n && n > 0 ? Math.round(n * 100) / 100 : null;
}
/**
 * Resolve product weight (kg) from all known locations, in priority order:
 * 1. explicit weightKg / packedWeightKg / normalized1688.weightKg
 * 2. a numeric value parsed from product.attributes whose name matches
 *    重量 / 毛重 / 净重 / вес / weight. Supports "2.65", "2.65kg", "2.65 кг",
 *    and gram values ("2650 г" → 2.65). Absurd values (<=0 or >200kg) ignored.
 */
export function extractWeightKg(product: any): number | null {
  // Highest priority: the LLM canonicalizer already extracted + unit-normalized
  // weight into a structured logistics block (g→kg done upstream).
  const llm = pos(
    product?.productContext?.procurementProfileDraft?.logistics?.weightKg ??
      product?.productContext?.logistics?.weightKg,
  );
  if (llm && llm <= 200) return llm;
  const direct = pos(
    product?.weightKg ??
      product?.packedWeightKg ??
      product?.normalized1688?.weightKg,
  );
  if (direct && direct <= 200) return direct;
  const attrs = array<any>(
    product?.attributes ?? product?.normalized1688?.attributes,
  );
  for (const a of attrs) {
    const name = String(a?.name ?? "");
    if (!/重量|毛重|净重|вес|weight/i.test(name)) continue;
    const raw = String(a?.value ?? "");
    const n = num(raw);
    if (n === null || n <= 0) continue;
    // Detect gram units → convert to kg.
    const isGram = /\b(g|г|克|gram)\b|(?<![a-zа-я])g(?![a-zа-я])/i.test(raw);
    let kg = isGram ? n / 1000 : n;
    // Heuristic: a bare number ≥ 200 in a weight field is almost certainly grams.
    if (!isGram && kg > 200) kg = kg / 1000;
    kg = Math.round(kg * 100) / 100;
    if (kg > 0 && kg <= 200) return kg;
  }
  return null;
}

/**
 * Read the LLM-canonicalized packing dimensions string (e.g. "17×17×23") from
 * either logistics location. Returns a cleaned "L×W×H" string or null.
 */
export function extractDimensionsCm(product: any): string | null {
  const raw =
    product?.productContext?.procurementProfileDraft?.logistics?.dimensionsCm ??
    product?.productContext?.logistics?.dimensionsCm ??
    product?.logistics?.dimensionsCm;
  const parsed = parseDimensionsCm(raw);
  if (!parsed) return null;
  return `${parsed[0]}×${parsed[1]}×${parsed[2]}`;
}

/**
 * Parse an "N×N×N" dimensions string tolerating ×, x, х (Cyrillic), *, and
 * spaces around separators. Returns [L, W, H] in cm, or null if not three
 * positive finite numbers.
 */
export function parseDimensionsCm(value: unknown): [number, number, number] | null {
  const str = String(value ?? "").trim();
  if (!str) return null;
  const parts = str
    .replace(/[×хx*]/gi, "×")
    .split("×")
    .map((s) => num(s));
  if (parts.length !== 3) return null;
  const [l, w, h] = parts;
  if (
    l === null ||
    w === null ||
    h === null ||
    l <= 0 ||
    w <= 0 ||
    h <= 0
  )
    return null;
  const round = (n: number) => Math.round(n * 100) / 100;
  return [round(l), round(w), round(h)];
}

/**
 * Volumetric (dimensional) weight in kg using the standard air/cargo divisor
 * 5000: (L×W×H cm) / 5000. Returns kg rounded to 2 dp, or null when dimensions
 * are unknown. This is an ESTIMATE before the supplier confirms real packing.
 */
export function volumetricWeightKgFromDimensions(value: unknown): number | null {
  const dims = parseDimensionsCm(value);
  if (!dims) return null;
  const kg = (dims[0] * dims[1] * dims[2]) / 5000;
  if (!Number.isFinite(kg) || kg <= 0) return null;
  return Math.round(kg * 100) / 100;
}

/**
 * Render a Russian volumetric-weight estimate line for reports/docs, or null
 * when dimensions are unknown (never invent). Weight formatted with a comma
 * decimal separator, e.g. "~1,4 кг".
 */
export function volumetricWeightLine(
  dimensionsCm: string | null,
  volumetricWeightKg: number | null,
  bullet = "• ",
  actualWeightKg: number | null = null,
): string | null {
  if (!dimensionsCm || !volumetricWeightKg) return null;
  const kg = String(volumetricWeightKg).replace(".", ",");
  // Dimensions often describe the ASSEMBLED/inflated product, not the shipping
  // package. Flag the figure as product dims and add a sanity caveat when the
  // volumetric weight is implausibly larger than the known actual weight — never
  // present the inflated volumetric as the real shipping figure without it.
  const implausible =
    (actualWeightKg != null &&
      actualWeightKg > 0 &&
      volumetricWeightKg > actualWeightKg * 5) ||
    (actualWeightKg != null &&
      actualWeightKg > 0 &&
      actualWeightKg < 5 &&
      volumetricWeightKg > 30);
  const caveat = implausible
    ? " — вероятно это габариты товара, а не упаковки; запросите габариты УПАКОВКИ в сложенном виде"
    : "";
  return `${bullet}Объёмный вес (оценка): ~${kg} кг (по габаритам товара ${dimensionsCm} см, возможно в собранном/надутом виде) — карго считает по большему из фактического и объёмного${caveat}`;
}

/**
 * Normalize a single user-facing red-flag / checklist line. Bare tags coming
 * from KIND_RULES / red-flag lists (e.g. "нет состава", "сильная усадка") are
 * expanded into clean, capitalized phrases. Anything already a full phrase is
 * only capitalized. General: any kind benefits, no per-product hardcoding.
 */
const FRAGMENT_NORMALIZERS: Array<{ rx: RegExp; text: string }> = [
  { rx: /^нет\s+состава(\s+ткани)?$/i, text: "Состав ткани не подтверждён" },
  { rx: /^не\s+подтверждён?\s+состав(\s+ткани)?$/i, text: "Состав ткани не подтверждён" },
  { rx: /^нет\s+состава\s+ткани$/i, text: "Состав ткани не подтверждён" },
  { rx: /^нет\s+размерн[а-яё]*\s+сетк[а-яё]*$/i, text: "Размерная сетка не предоставлена" },
  { rx: /^сильн[а-яё]*\s+усадк[а-яё]*$/i, text: "Риск сильной усадки после стирки" },
  { rx: /^усадка\s+после\s+стирки$/i, text: "Риск усадки после стирки" },
  { rx: /^плох[а-яё]*\s+швы$/i, text: "Риск плохого качества швов" },
  { rx: /^плох[а-яё]*\s+склейк[а-яё]*.*$/i, text: "Риск плохой склейки/литья подошвы" },
  { rx: /^тонк[а-яё]*\s+ткан[а-яё]*$/i, text: "Риск слишком тонкой ткани" },
  { rx: /^сильный\s+запах$/i, text: "Риск сильного запаха" },
  { rx: /^резкий\s+запах$/i, text: "Риск резкого запаха" },
  { rx: /^скользк[а-яё]*\s+подошв[а-яё]*$/i, text: "Риск скользкой подошвы" },
  { rx: /^нет\s+реальных\s+фото$/i, text: "Нет реальных фото товара" },
  { rx: /^нет\s+веса\s+с\s+упаковкой$/i, text: "Вес с упаковкой не указан" },
  { rx: /^нет\s+фото\s+упаковки$/i, text: "Нет фото упаковки" },
  { rx: /^подтвердить\s+состав(\s+ткани)?$/i, text: "Подтвердить состав ткани у поставщика" },
  { rx: /^получить\s+замеры$/i, text: "Получить замеры изделия у поставщика" },
  { rx: /^получить\s+размерн[а-яё]*\s+сетк[а-яё]*$/i, text: "Получить размерную сетку у поставщика" },
];

export function normalizeFragmentLine(value: unknown): string {
  let text = clean(value)
    .replace(/^\s*(?:[-•]|\d+[.)])\s*/, "")
    .replace(/[.]+$/g, "")
    .trim();
  if (!text) return "";
  for (const { rx, text: replacement } of FRAGMENT_NORMALIZERS) {
    if (rx.test(text)) return replacement;
  }
  // Generic fallback: capitalize the first letter so bare fragments don't look
  // like tags next to full sentences.
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function normalizeFragmentLines(items: string[]): string[] {
  return items.map((v) => normalizeFragmentLine(v)).filter(Boolean);
}

/**
 * Deterministic supplier reliability assessment. Uses only signals present on
 * the product — never invents data. Scoring (documented, simple):
 *   start at 50 (neutral).
 *   rating ≥4.6 → +20; 4.0–4.5 → 0; <4.0 → −20.
 *   orders ≥500 → +15; 50–499 → 0; <50 → −15 (thin history).
 *   return rate >20% → −25; >10% → −12.
 *   delivery rate <95% → −12.
 *   positive-review rate ≥95% → +8; <85% → −10.
 * Clamped to 0–100 then mapped to level/badge. Reasons are evidence, not a
 * guarantee — we never assert a supplier is "safe/reliable" as fact.
 */
export function computeSupplierReliability(product: any): {
  level: "high" | "medium" | "low" | "unknown";
  badge: "🟢" | "🟡" | "🔴" | "⚪";
  score: number | null;
  reasons: string[];
} {
  const present = (v: unknown): boolean =>
    v !== undefined && v !== null && String(v).trim() !== "";
  const pick = (...vals: unknown[]): unknown =>
    vals.find((v) => present(v));
  const pct = (v: unknown): number | null => {
    if (!present(v)) return null;
    const n = num(v);
    if (n === null || n < 0) return null;
    return n <= 1 ? n * 100 : n; // accept 0.36 or 36
  };
  const numIf = (v: unknown): number | null => (present(v) ? num(v) : null);
  const rating = numIf(
    pick(product?.supplierRating, product?.rating, product?.supplier?.rating),
  );
  const orders = numIf(
    pick(product?.sold, product?.orders, product?.supplier?.orders),
  );
  const returnRate = pct(
    product?.returnRate ?? product?.supplier?.returnRate,
  );
  const deliveryRate = pct(
    product?.deliveryRate ??
      product?.onTimeRate ??
      product?.supplier?.deliveryRate,
  );
  const positiveRate = pct(
    product?.positiveRate ??
      product?.positiveReviewRate ??
      product?.supplier?.positiveRate,
  );

  const reasons: string[] = [];
  let score = 50;
  let signals = 0;

  if (rating !== null && rating > 0) {
    signals++;
    const r = String(Math.round(rating * 10) / 10).replace(".", ",");
    if (rating >= 4.6) {
      score += 20;
      reasons.push(`рейтинг ${r}/5 — высокий`);
    } else if (rating >= 4.0) {
      reasons.push(`рейтинг ${r}/5`);
    } else {
      score -= 20;
      reasons.push(`рейтинг ${r}/5 — низкий`);
    }
  }
  if (orders !== null && orders >= 0) {
    signals++;
    const o = Math.round(orders);
    if (orders >= 500) {
      score += 15;
      reasons.push(`${o} заказов`);
    } else if (orders >= 50) {
      reasons.push(`${o} заказов (мало статистики)`);
    } else if (orders > 0) {
      score -= 15;
      reasons.push(`${o} заказов — мало статистики`);
    } else {
      // 0 orders is a real signal, not a missing one: no sales track record.
      score -= 20;
      reasons.push(`0 заказов — нет истории продаж`);
    }
  }
  if (returnRate !== null) {
    signals++;
    const rr = Math.round(returnRate);
    if (returnRate > 20) {
      score -= 25;
      reasons.push(`возвраты ${rr}% — высокий`);
    } else if (returnRate > 10) {
      score -= 12;
      reasons.push(`возвраты ${rr}%`);
    } else {
      reasons.push(`возвраты ${rr}%`);
    }
  }
  if (deliveryRate !== null) {
    signals++;
    const dr = Math.round(deliveryRate);
    if (deliveryRate < 95) {
      score -= 12;
      reasons.push(`доставка в срок ${dr}% — ниже нормы`);
    } else {
      reasons.push(`доставка в срок ${dr}%`);
    }
  }
  if (positiveRate !== null) {
    signals++;
    const pr = Math.round(positiveRate);
    if (positiveRate >= 95) {
      score += 8;
      reasons.push(`положительных отзывов ${pr}%`);
    } else if (positiveRate < 85) {
      score -= 10;
      reasons.push(`положительных отзывов ${pr}% — низкий`);
    } else {
      reasons.push(`положительных отзывов ${pr}%`);
    }
  }

  if (signals === 0) {
    return {
      level: "unknown",
      badge: "⚪",
      score: null,
      reasons: ["мало данных о поставщике"],
    };
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  let level: "high" | "medium" | "low";
  let badge: "🟢" | "🟡" | "🔴";
  if (score >= 70) {
    level = "high";
    badge = "🟢";
  } else if (score >= 45) {
    level = "medium";
    badge = "🟡";
  } else {
    level = "low";
    badge = "🔴";
  }
  return { level, badge, score, reasons };
}
const RELIABILITY_LEVEL_RU: Record<string, string> = {
  high: "высокая",
  medium: "средняя",
  low: "низкая",
  unknown: "нет данных",
};
function cny(v: number | null | undefined): string {
  return v && Number.isFinite(v) && v > 0
    ? `${String(Math.round(v * 100) / 100).replace(".", ",")} ¥`
    : "нужно уточнить";
}
function cnyDot(v: number | null | undefined): string {
  return v && Number.isFinite(v) && v > 0
    ? `${String(Math.round(v * 100) / 100)} 元`
    : "需要确认";
}
function rub(v: number | null | undefined): string {
  return v && Number.isFinite(v) && v > 0
    ? `${Math.round(v).toLocaleString("ru-RU")} ₽`
    : "нужно уточнить";
}

function fixMixedRuTypos(text: string): string {
  return String(text ?? "")
    .replace(/поставщpику/g, "поставщику")
    .replace(/поставщpик/g, "поставщик")
    .replace(/p/g, (m, offset, full) => {
      const before = full[offset - 1] || "";
      const after = full[offset + 1] || "";
      return /[А-Яа-яЁё]/.test(before) && /[А-Яа-яЁё]/.test(after) ? "р" : m;
    });
}

function normalizeDedupKey(value: string): string {
  let key = fixMixedRuTypos(value)
    .toLowerCase()
    .replace(/[«»"'`]/g, "")
    .replace(/[?.!,:;]+$/g, "")
    .replace(/^\s*(?:[-•]|\d+[.)])\s*/, "")
    .replace(/ё/g, "е")
    .replace(
      /sku|выбранного sku|одной единицы|товара|изделия|точный|точные|именно/gi,
      "",
    )
    .replace(/индивидуальн(?:ой|ая|ую)\s+упаковк(?:и|а|у)/gi, "упаковка")
    .replace(
      /транспортн(?:ой|ая|ую)\s+коробк(?:и|а|у)/gi,
      "транспортная коробка",
    )
    .replace(/с\s+упаковк(?:ой|и)/gi, "с упаковкой")
    .replace(/габариты|размеры|размер/gi, "габариты")
    .replace(/сертификаты|сертификатов|документы|документов/gi, "сертификаты")
    .replace(/швы|качество швов/gi, "швы")
    .replace(/\s+/g, " ")
    .trim();
  if (/вес.*упаков|упаков.*вес/.test(key)) return "вес с упаковкой";
  if (/габарит.*упаков|упаков.*габарит/.test(key))
    return "габариты индивидуальной упаковки";
  if (/количеств.*транспорт.*короб|штук.*короб/.test(key))
    return "количество в транспортной коробке";
  if (/состав.*ткан|ткан.*состав/.test(key)) return "состав ткани";
  // NB: an earlier replace turns "размер" → "габариты", so match on "сетк".
  if (/сетк/.test(key)) return "размерная сетка";
  if (/(?:замер|обмер)[а-яё]*\s*издели|издели[а-яё]*\s*замер|снять\s*замер/.test(key))
    return "замеры изделия";
  if (/цен[а-яё]*.*sku|sku.*цен|подтверд.*цен|цен[а-яё]*.*подтверд|уточн.*цен|цен[а-яё]*.*уточн/.test(key))
    return "цена выбранного sku";
  if (/усадк/.test(key)) return "усадка после стирки";
  if (/moq|минимальн[а-яё]*\s*заказ/.test(key)) return "moq";
  if (/образц|образец/.test(key)) return "заказ образца";
  if (/реальн.*фото|фото.*модел|фото.*упаков|пришлите.*фото/.test(key))
    return "реальные фото товара и упаковки";
  if (/уф|uv|upf/.test(key)) return "подтверждение уф защиты";
  return key;
}

// Light Russian stemmer: strip the most common inflectional endings so that
// "царапины"/"царапин", "заточки"/"заточка", "долговечностью" collapse to one
// root. Deliberately conservative (keeps >=4-char stems) — enough for dedup,
// not a full morphological analyser. Category-agnostic.
const RU_ENDINGS = [
  "иями", "ями", "ами", "иях", "ях", "ами", "ов", "ев", "ей",
  "ого", "его", "ому", "ему", "ыми", "ими", "ый", "ий", "ой",
  "ая", "яя", "ое", "ее", "ые", "ие", "ым", "им", "ом", "ах",
  "ью", "ия", "ю", "я", "ы", "и", "а", "о", "е", "у", "ь",
];
function stemRu(w: string): string {
  for (const end of RU_ENDINGS) {
    if (w.length - end.length >= 4 && w.endsWith(end)) {
      return w.slice(0, w.length - end.length);
    }
  }
  return w;
}
function stemTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^а-яa-z0-9\s]/gi, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4)
    .map(stemRu);
}
function significantWords(s: string): Set<string> {
  return new Set(stemTokens(s));
}

export function dedupNormalizedList(
  list: Array<string | null | undefined>,
  limit = 30,
): string[] {
  const seen = new Set<string>();
  const exact: string[] = [];
  for (const raw of list) {
    const text = fixMixedRuTypos(clean(raw))
      .replace(/^\s*(?:[-•]|\d+[.)])\s*/, "")
      .trim();
    if (!text || text === "—") continue;
    const key = normalizeDedupKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    exact.push(text);
  }
  // Second pass: collapse NEAR-duplicates. If every significant word of one line
  // is contained in another, the shorter is redundant (e.g. "оценить баланс ножа"
  // ⊂ "оценить баланс ножа и удобство хвата"). Keep the more complete line.
  const out: string[] = [];
  for (const item of exact) {
    const wi = significantWords(item);
    if (wi.size < 2) {
      out.push(item);
      continue;
    }
    const seqI = stemTokens(item);
    let redundant = false;
    for (let j = 0; j < out.length; j++) {
      const wj = significantWords(out[j]);
      if (wj.size < 2) continue;
      const iInJ = [...wi].every((w) => wj.has(w));
      const jInI = [...wj].every((w) => wi.has(w));
      if (iInJ) {
        redundant = true;
        break;
      }
      if (jInI) {
        out[j] = item; // replace the shorter kept line with the fuller one
        redundant = true;
        break;
      }
      // Shared leading phrase: two items that open with the SAME >=3 significant
      // stems ("проверить устойчивость коррозии …", "маркетинговые утверждения
      // без подтверждения …") are the same point rephrased. Keep the fuller one.
      const seqJ = stemTokens(out[j]);
      let lead = 0;
      while (lead < seqI.length && lead < seqJ.length && seqI[lead] === seqJ[lead])
        lead++;
      if (lead >= 3) {
        if (wi.size > wj.size) out[j] = item;
        redundant = true;
        break;
      }
    }
    if (!redundant) out.push(item);
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

function uniq(list: Array<string | null | undefined>, limit = 30): string[] {
  return dedupNormalizedList(list, limit);
}

/**
 * Resolve the supplier name shown across all docs consistently. Material-like
 * junk ("нержавеющая сталь") is dropped. A real name is kept even when it is
 * Chinese — safeRu would strip it to empty, so we fall back to the raw cleaned
 * name so buyer brief and ProductDetails agree instead of showing
 * "не указано".
 */
export function resolveSupplierName(value: unknown): string {
  if (isMaterialLikeSupplierName(value)) return "не указано";
  const raw = clean(value);
  if (!raw || raw === "—" || isPlaceholderValue(raw)) return "не указано";
  const ru = safeRu(raw);
  return ru || raw;
}

export function supplierTypeDisplay(value: unknown): string {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!raw || /unknown|неизвест|не указан/.test(raw)) return "не указан";
  if (/factory|фабрик|工厂|厂家/.test(raw)) return "фабрика";
  if (/merchant|провер|实力|供应商/.test(raw)) return "проверенный продавец";
  if (/seller|store|shop|продав/.test(raw)) return "продавец";
  return safeRu(value) || "продавец";
}

function normalizeProductKind(value: unknown): ProductKind | null {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!raw) return null;
  const direct = raw.match(
    /footwear|clothing|towel_kilt|umbrella|sleep_mask|mini_washer|dish_rack|kitchen_storage_rack|passive_insect_trap|usb_device|heating_food_mat|small_appliance|kitchen_tool|knife|bag_accessory|fake_security_camera|generic_product/,
  )?.[0];
  if (direct && direct in KIND_RULES) return direct as ProductKind;
  if (
    /暖菜板|保温板|恒温垫|热菜板|热饭.*垫|греющ[а-яё ]*подставк|подогреватель\s+блюд|подставк[а-яё ]*для\s+подогрев|warming\s*tray|food\s*warming\s*mat|电热.*暖菜/i.test(
      raw,
    )
  )
    return "heating_food_mat";
  if (
    /仿真摄像头|假监控|假摄像头|dummy\s*camera|fake\s*camera|imitation\s*(security\s*)?camera|имитац[а-яё ]*камер|муляж\s*камер|фальш[- ]?камер|камера[- ]?муляж|fake\s*cctv/i.test(
      raw,
    )
  )
    return "fake_security_camera";
  if (/зонт|umbrella|雨伞|雨傘|伞|傘/.test(raw)) return "umbrella";
  if (/маск[аи]\s+для\s+сна|sleep\s*mask|眼罩|睡眠/.test(raw))
    return "sleep_mask";
  if (
    /мини[ -]?стирал|стиральн[а-яё ]*машин|washing\s*machine|洗衣机/.test(raw)
  )
    return "mini_washer";
  if (/сабо|shoe|footwear|обув|тапоч|шл[её]пан|сандал|鞋|拖鞋|凉鞋/.test(raw))
    return "footwear";
  if (/полотенц[еа][ -]?килт|towel[_ -]?kilt/.test(raw)) return "towel_kilt";
  if (
    /балаклав|подшлемник|face\s*mask|одежд|clothing|clothes|плать|брюк|футбол|衣|裤|面罩|头套|防晒面罩/.test(
      raw,
    )
  )
    return "clothing";
  if (/usb|type-c|type c/.test(raw)) return "usb_device";
  if (/насеком|insect|ловуш|粘虫|捕虫/.test(raw)) return "passive_insect_trap";
  if (
    /厨房置物架|碗碟盘|碗盘架|沥水架|家用台面|dish\s*rack|drying\s*rack|kitchen\s*storage\s*rack|сушилк.*посуд|стеллаж.*посуд|подставк.*тарел|кухонн.*органайзер|многоярусн.*сушилк|кухонн.*полк/.test(
      raw,
    )
  )
    return "dish_rack";
  if (
    /\bнож[аи]?\b|нож[- ]?топорик|кухонн\w*\s+нож|菜刀|切片刀|斩切|切肉刀|厨师刀|cleaver|chef'?s?\s*knife|kitchen\s*knife|paring\s*knife|butcher\s*knife|刀具/i.test(
      raw,
    ) &&
    !/ножниц|подножк/i.test(raw)
  )
    return "knife";
  if (/кухон|kitchen/.test(raw)) return "kitchen_tool";
  if (/сумк|bag|кошел|брелок/.test(raw)) return "bag_accessory";
  if (/электр|220v|вилка|мощность|appliance|прибор/.test(raw))
    return "small_appliance";
  return null;
}

function detectKindByRules(product: any): ProductKind {
  const text =
    `${product?.titleRu ?? ""} ${product?.titleEn ?? ""} ${product?.titleCn ?? ""} ${product?.categoryName ?? ""} ${JSON.stringify(product?.attributes ?? [])}`.toLowerCase();
  return normalizeProductKind(text) ?? "generic_product";
}

export function classifyProductKindConsensus(
  product: any,
  intelligence?: ProductIntelligence | any,
): ProductKindDecision {
  const rulesKind = detectKindByRules(product);
  const visionKind = normalizeProductKind(
    intelligence?.productIdentity?.productKind ??
      intelligence?.productIdentity?.categoryType ??
      intelligence?.identity?.productType ??
      intelligence?.identity?.productKind ??
      product?.productContext?.identity?.productType,
  );
  const textKind = normalizeProductKind(
    `${intelligence?.cleanTitles?.titleForReport ?? ""} ${intelligence?.cleanTitles?.titleRuClean ?? ""} ${intelligence?.productIdentity?.coreObject ?? ""} ${product?.productContext?.titles?.cleanRu ?? ""}`,
  );
  const votes = [visionKind, textKind, rulesKind].filter(
    Boolean,
  ) as ProductKind[];
  const tally = votes.reduce<Record<string, number>>((acc, k) => {
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  // A SPECIFIC kind (anything other than generic_product) must not be overridden
  // by weak/generic LLM votes: when the title/rules clearly identify the object
  // (e.g. "нож" → knife) but the LLM classifiers only returned "generic/other",
  // the specific kind should win. Only fall back to generic when there is no
  // specific vote at all.
  const tallyEntries = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const specificEntries = tallyEntries.filter(([k]) => k !== "generic_product");
  const winner =
    ((specificEntries[0]?.[0] ?? tallyEntries[0]?.[0]) as ProductKind) ||
    rulesKind;
  const agree = tally[winner] ?? 1;
  const disagreement = new Set(votes).size > 1;
  const confidence = Math.max(
    0.35,
    Math.min(
      0.98,
      agree >= 3
        ? 0.96
        : agree === 2
          ? 0.86
          : winner === rulesKind
            ? 0.72
            : 0.68,
    ),
  );
  return {
    productKind: winner,
    confidence,
    confidenceLabel:
      confidence >= 0.9 ? "high" : confidence >= 0.75 ? "medium" : "low",
    visionKind,
    textKind,
    rulesKind,
    evidence: uniq(
      [
        visionKind ? `vision/text LLM: ${visionKind}` : "",
        textKind ? `title/context: ${textKind}` : "",
        `rules: ${rulesKind}`,
        disagreement
          ? "есть расхождение классификаторов"
          : "классификаторы согласованы",
      ],
      6,
    ),
    disagreement,
  };
}

function detectKind(
  product: any,
  intelligence?: ProductIntelligence | any,
): ProductKind {
  return classifyProductKindConsensus(product, intelligence).productKind;
}

function collectMaterials(
  product: any,
  intelligence: any,
  kind: ProductKind,
): string[] {
  const fromIntel = [
    ...array<string>(intelligence?.productIdentity?.material),
    ...array<string>(intelligence?.productIdentity?.materials),
  ];
  const attrs = array<any>(
    product?.attributes ?? product?.normalized1688?.attributes,
  );
  const fromAttrs = attrs
    .filter((a) =>
      /материал|材质|面料|成分|material/i.test(String(a?.name ?? "")),
    )
    .map((a) => safeRu(a?.value));
  // A material that actually describes a sub-component (wire core / cable /
  // plug), e.g. 铜线 (copper wire) or 铜芯 (copper core), is NOT the product's
  // housing material — mark it component-scoped and unconfirmed instead of
  // presenting it as THE material.
  const rawMaterialText = [
    ...fromIntel,
    ...attrs
      .filter((a) =>
        /материал|材质|面料|成分|material/i.test(String(a?.name ?? "")),
      )
      .map((a) => String(a?.value ?? "")),
  ].join(" ");
  const isWireComponentMaterial =
    /铜线|铜芯|线芯|медн\w*\s+(?:провод|жил|шнур|кабел)|провод|кабел|шнур/i.test(
      rawMaterialText,
    );

  let items = uniq(
    [...fromIntel, ...fromAttrs]
      .map(safeRu)
      // Translate copper and drop the sub-component wire material from the
      // main product-material list; keep general (not solar-specific).
      .map((s) => s.replace(/\bcopper\b/gi, "медь"))
      .filter((s) => {
        if (!isWireComponentMaterial) return true;
        return !/медн?\w*|copper/i.test(s);
      }),
    6,
  );
  // If ALL materials were the wire sub-component, surface it as component-scoped
  // and unconfirmed rather than dropping the info entirely.
  if (isWireComponentMaterial && !items.length) {
    items = ["медь — только жила шнура/вилки, не корпус — подтвердить"];
  }
  if (kind === "umbrella") {
    const joined = items.join(" ").toLowerCase();
    const hasMetal = /желез|сплав|металл|iron|alloy|钢|铁|合金/i.test(
      joined + " " + JSON.stringify(product?.attributes ?? ""),
    );
    items = [
      "ткань купола",
      hasMetal ? "железо/сплав — подтвердить" : "материал спиц — подтвердить",
    ];
  }
  if (kind === "dish_rack" || kind === "kitchen_storage_rack") {
    const joined =
      `${items.join(" ")} ${JSON.stringify(product?.attributes ?? "")}`.toLowerCase();
    const hasSteel = /нержав|сталь|steel|不锈钢|铁|钢|металл/i.test(joined);
    items = [
      hasSteel
        ? "возможно сталь/нержавеющая сталь — подтвердить"
        : "материал каркаса — уточнить",
      "тип покрытия — уточнить",
    ];
  }
  return items.length ? items : ["уточнить у поставщика"];
}

/**
 * Normalizes and dedups material strings for user-facing output.
 * - maps 塑料 / ABS / 苯乙烯 → "ABS-пластик — подтвердить"
 * - dedups "ABS-пластик, ABS" → single entry
 * - drops raw Chinese when a Russian equivalent exists
 * - keeps at most `limit` materials (default 2 for main report)
 */
function normalizeMaterials(items: string[], limit = 2): string[] {
  const cleaned = (items ?? [])
    .map((s) => String(s ?? "").trim())
    .filter(Boolean)
    .filter((s) => !isPlaceholderValue(s));
  const out: string[] = [];
  let absAdded = false;
  const seen = new Set<string>();
  for (const rawItem of cleaned) {
    // Split combined entries like "ABS-пластик, ABS" or "塑料（ABS（苯乙烯）"
    const parts = rawItem
      .split(/[,，、;；/／()（）]+/)
      .map((p) => p.trim())
      .filter(Boolean);
    for (const part of parts) {
      const low = part.toLowerCase();
      if (/塑料|苯乙烯|^abs$|abs[- ]?пластик|\babs\b/i.test(low)) {
        if (!absAdded) {
          out.push("ABS-пластик — подтвердить");
          absAdded = true;
        }
        continue;
      }
      // Drop raw-Chinese-only fragments if a Russian material already present
      const isChineseOnly = /^[㐀-鿿\s]+$/.test(part);
      if (isChineseOnly) continue;
      const key = low.replace(/\s+/g, " ").replace(/\s*—.*$/, "");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(part);
    }
  }
  // Drop bogus fragments: a material that is only a substring/token-prefix of
  // another material (e.g. "3" split out of the steel grade "3CR13") is noise.
  // Steel grade codes like 3CR13 / 4CR13 / 5CR15 must survive intact as one
  // token, so we only prune entries that are a proper fragment of a longer one.
  const deduped = out.filter((item, idx) => {
    const norm = item.toLowerCase().replace(/\s+/g, " ").trim();
    return !out.some((other, j) => {
      if (j === idx) return false;
      const otherNorm = other.toLowerCase().replace(/\s+/g, " ").trim();
      if (otherNorm.length <= norm.length) return false;
      // fragment if `item` appears as a substring inside a longer material and
      // is bounded by a non-space (i.e. glued into a token like the "3" of "3cr13")
      const at = otherNorm.indexOf(norm);
      if (at < 0) return false;
      const before = at > 0 ? otherNorm[at - 1] : " ";
      const after =
        at + norm.length < otherNorm.length ? otherNorm[at + norm.length] : " ";
      return before !== " " || after !== " ";
    });
  });
  const result = deduped.slice(0, limit);
  return result.length ? result : ["уточнить у поставщика"];
}

function collectSkuVariants(product: any): any[] {
  return array(product?.skus).length
    ? array(product.skus)
    : array(product?.normalized1688?.skuVariants);
}

function skuName(s: any): string {
  return safeRu(
    s?.name ?? s?.label ?? s?.skuName ?? s?.propertiesName ?? s?.raw ?? "",
  ).replace(/;\s*/g, " · ");
}

function skuPrice(s: any): number | null {
  return pos(s?.priceYuan ?? s?.price ?? s?.discountPrice ?? s?.salePrice);
}

function extractColors(labels: string[]): string[] {
  const colors = [
    "чёрный",
    "черный",
    "белый",
    "синий",
    "голубой",
    "зелёный",
    "зеленый",
    "жёлтый",
    "желтый",
    "розовый",
    "красный",
    "серый",
    "фиолетовый",
    "хаки",
    "бежевый",
    "коричневый",
    "оранжевый",
  ];
  return uniq(
    labels
      .flatMap((l) =>
        colors.filter((c) =>
          new RegExp(`(^|[^а-яё])${c}([^а-яё]|$)`, "i").test(l),
        ),
      )
      .map((c) =>
        c === "черный"
          ? "чёрный"
          : c === "зеленый"
            ? "зелёный"
            : c === "желтый"
              ? "жёлтый"
              : c,
      ),
    12,
  );
}

function extractAmbiguousParams(labels: string[], kind: ProductKind): string[] {
  if (
    kind === "footwear" ||
    kind === "dish_rack" ||
    kind === "kitchen_storage_rack"
  )
    return [];
  const nums = labels.flatMap((l) =>
    Array.from(l.matchAll(/\b(?:8|16|40|120|\d{1,3})\b/g)).map((m) => m[0]),
  );
  return uniq(
    nums.filter((n) => !/^20\d{2}$/.test(n)),
    10,
  );
}

const ELECTRICAL_KINDS: ProductKind[] = [
  "heating_food_mat",
  "small_appliance",
  "mini_washer",
  "usb_device",
];

function isElectricalKind(kind: ProductKind): boolean {
  return ELECTRICAL_KINDS.includes(kind);
}

/**
 * Builds a clean, structured RU label for an electrical SKU variant from a raw
 * (usually Chinese) SKU string like `FWM-02数显款浅紫色美规`:
 *   → `FWM-02 · цифровой дисплей · светло-фиолетовый · US`
 * Stock/logistics labels are dropped. Returns the structured parts plus the plug.
 */
function structureElectricalSku(rawLabel: string): {
  text: string;
  model: string | null;
  color: string | null;
  plugStandard: string | null;
  displayType: string | null;
} {
  const cleaned = stripStockLabels(rawLabel);
  const model = extractModelCode(cleaned) ?? null;
  const displayType = extractDisplayType(cleaned) ?? null;
  const color = extractColor(cleaned) ?? null;
  const plugStandard = extractPlugStandard(cleaned) ?? null;
  const parts = [model, displayType, color, plugStandard].filter(
    Boolean,
  ) as string[];
  return {
    text: parts.length ? parts.join(" · ") : safeRu(cleaned),
    model,
    color,
    plugStandard,
    displayType,
  };
}

type StructuredSkuDimension = { label: string; value: string };
type StructuredSkuVariant = {
  raw: string;
  model: string | null;
  color: string | null;
  plugStandard: string | null;
  dimensions: StructuredSkuDimension[];
};

/**
 * Reads the LLM-provided structured SKU breakdown from the canonicalizer draft.
 * Returns [] when absent (old jobs / LLM miss) so callers fall back to the
 * deterministic path.
 */
function readStructuredSkuVariants(product: any): StructuredSkuVariant[] {
  const draft = record(
    product?.productProcurementProfileDraft ??
      product?.procurementProfileDraft ??
      product?.productContext?.procurementProfileDraft ??
      product?.productContext?.profileDraft,
  );
  const raw = array<any>(record(draft.sku).variants);
  const out: StructuredSkuVariant[] = [];
  for (const v of raw) {
    const obj = record(v);
    const dims = array<any>(obj.dimensions)
      .map((d) => {
        const dd = record(d);
        const label = safeRu(dd.label);
        const value = clean(dd.value);
        return label && value ? { label, value } : null;
      })
      .filter((d): d is StructuredSkuDimension => !!d);
    const rawLabel = clean(obj.raw);
    const model = safeRu(obj.model) || null;
    const color = safeRu(obj.color) || null;
    const plug = (extractPlugStandard(obj.plugStandard) ??
      String(obj.plugStandard ?? "").trim()) || null;
    if (!rawLabel && !model && !color && !dims.length) continue;
    out.push({
      raw: rawLabel,
      model,
      color,
      plugStandard: plug && /^(US|EU|UK|JP|KR|AU|CN)$/i.test(plug) ? plug.toUpperCase() : null,
      dimensions: dims,
    });
  }
  return out;
}

/** Joins a structured variant into a single labeled human string. */
function renderStructuredVariant(v: StructuredSkuVariant): string {
  const parts = [
    v.model,
    ...v.dimensions.map((d) => d.value),
    v.color,
    v.plugStandard,
  ].filter((x): x is string => !!x && x.trim().length > 0);
  return uniq(parts, 8).join(" · ");
}

/**
 * Safe deterministic cleanup of a raw SKU label when no structured data exists.
 * Strips trailing " _", dangling "-", stray separators — so we show a cleaned
 * raw label instead of number-soup like `68800M 80 _10 -`.
 */
function cleanRawSkuLabel(label: string): string {
  const cleaned = clean(label)
    .replace(/[_·\-–—/]+\s*$/g, "")
    .replace(/\s*[_·\-–—/]{2,}\s*/g, " · ")
    .replace(/\s+_\s+/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/[_\-–—]+$/g, "")
    .trim();
  return collapseRepeatedSkuFragments(cleaned);
}

/**
 * Collapses echoed fragments in a composed SKU label so we never ship
 * "X неподтверждённое свойство и неподтверждённое свойство Y" or "X и X".
 * - splits on " · " and " и " boundaries, dedups identical segments;
 * - collapses an immediate "phrase и phrase" repetition to a single phrase.
 */
function collapseRepeatedSkuFragments(text: string): string {
  if (!text) return text;
  // Collapse "<phrase> и <same phrase>" (case-insensitive) → "<phrase>".
  let out = text.replace(
    /(\S[^·]*?\S)\s+и\s+\1(?=\s|$|·)/gi,
    "$1",
  );
  // Dedup identical " · "-separated segments, preserving order.
  const seen = new Set<string>();
  out = out
    .split(/\s*·\s*/)
    .filter((seg) => {
      const key = seg.trim().toLowerCase();
      if (!key) return false;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(" · ");
  return out.replace(/\s{2,}/g, " ").trim();
}

function buildSkuProfile(
  product: any,
  kind: ProductKind,
  sourceUrl?: string,
): ProductProcurementProfile["sku"] {
  const variants = collectSkuVariants(product);
  const labels = variants.map(skuName).filter(Boolean);
  const electrical = isElectricalKind(kind);
  const structuredVariants = readStructuredSkuVariants(product);
  const hasStructured = structuredVariants.length > 0;
  // Distinct labeled dimensions the LLM identified across all variants, e.g.
  // "ёмкость", "мощность", "длина кабеля" — used to render a clean summary and
  // to replace the anonymous number pile.
  const structuredLabels = uniq(
    structuredVariants.flatMap((v) => v.dimensions.map((d) => d.label)),
    8,
  );
  // One representative value per label (e.g. "ёмкость: 26800 мА·ч").
  const structuredSummaryPairs: string[] = structuredLabels.map((label) => {
    const values = uniq(
      structuredVariants
        .flatMap((v) => v.dimensions.filter((d) => d.label === label))
        .map((d) => d.value),
      4,
    );
    return `${label}: ${values.join(" / ")}`;
  });
  // Raw (still-Chinese) variant names — needed because skuName()/safeRu strips
  // CJK, which would destroy plug/color/model tokens for electrical goods.
  const rawNames = variants
    .map((s: any) =>
      String(
        s?.name ?? s?.label ?? s?.skuName ?? s?.propertiesName ?? s?.raw ?? "",
      ),
    )
    .filter(Boolean);
  const colors = extractColors(labels);
  // When the LLM provided labeled dimensions, never emit the bare number pile.
  const ambiguousParams =
    electrical || hasStructured ? [] : extractAmbiguousParams(labels, kind);
  const plugStandards = electrical
    ? uniq(
        rawNames
          .map((l) => extractPlugStandard(l))
          .filter((v): v is string => !!v),
        8,
      )
    : [];
  const electricalModels = electrical
    ? uniq(
        rawNames
          .map((l) => extractModelCode(l))
          .filter((v): v is string => !!v),
        8,
      )
    : [];
  const electricalColors = electrical
    ? uniq(
        rawNames
          .map((l) => extractColor(l))
          .filter((v): v is string => !!v),
        12,
      )
    : [];
  const sizeMatches =
    kind === "footwear"
      ? uniq(
          labels.flatMap((l) =>
            Array.from(
              l.matchAll(/\b(?:3[5-9]|4[0-9])(?:[–-](?:3[5-9]|4[0-9]))?\b/g),
            ).map((m) => m[0]),
          ),
          12,
        )
      : [];
  const packageTypes = uniq(
    labels
      .filter((l) => /opp|пакет|короб|box|袋|盒|полный комплект/i.test(l))
      .map((l) =>
        /полный комплект/i.test(l)
          ? "полный комплект"
          : l.replace(/.*?(OPP|пакет|коробка|box|袋|盒).*/i, "$1"),
      ),
    8,
  );
  const models = electrical
    ? electricalModels
    : kind === "dish_rack" || kind === "kitchen_storage_rack"
      ? uniq(
          labels.flatMap((l) =>
            Array.from(l.matchAll(/\b[23]\s*(?:ярус[а-яё]*|tier|层)/gi)).map(
              (m) => m[0],
            ),
          ),
          8,
        )
      : [];
  const allColors = electrical
    ? uniq([...colors, ...electricalColors], 12)
    : colors;
  const packCounts = uniq(
    labels.flatMap((l) =>
      Array.from(l.matchAll(/\b\d+\s*(?:шт|pcs|件|个)\b/gi)).map((m) => m[0]),
    ),
    8,
  );
  const dims: string[] = [];
  if (allColors.length) dims.push("цвет");
  if (models.length)
    dims.push(electrical ? "модель" : "количество ярусов");
  if (plugStandards.length) dims.push("стандарт вилки");
  if (sizeMatches.length)
    dims.push(
      kind === "dish_rack" || kind === "kitchen_storage_rack"
        ? "размер"
        : "размер",
    );
  if (ambiguousParams.length) dims.push("параметр SKU");
  // Add LLM-identified labeled dimensions (ёмкость, мощность, длина кабеля…).
  for (const label of structuredLabels) {
    if (!dims.some((d) => d.toLowerCase() === label.toLowerCase()))
      dims.push(label);
  }
  if (!dims.length && variants.length > 1) dims.push("вариант");
  const count = variants.length || labels.length;
  const dimsSummary = dims.filter((d) => d && d !== "вариант").join(" × ");
  const skuSummary = count
    ? dimsSummary
      ? `${count} ${pluralRu(count, "вариант", "варианта", "вариантов")} · ${dimsSummary}`
      : `${count} ${pluralRu(count, "вариант", "варианта", "вариантов")}`
    : "SKU нужно уточнить";
  const normalizedExamples = hasStructured
    ? uniq(
        structuredVariants
          .map(renderStructuredVariant)
          .filter(Boolean),
        5,
      )
    : electrical
      ? uniq(
          rawNames.map((l) => structureElectricalSku(l).text).filter(Boolean),
          5,
        )
      : labels
          .slice(0, 5)
          .map((l) =>
            ambiguousParams.length
              ? cleanRawSkuLabel(l)
              : cleanRawSkuLabel(l),
          );
  const selected = makeSelectedSkuDecision(product, variants, sourceUrl, kind);
  // Prefer a labeled structured render for the selected SKU when the LLM
  // matched a variant (by raw label). Falls back to the deterministic text.
  if (hasStructured && selected.selectedSkuText) {
    const selRaw = clean(selected.selectedSkuText).toLowerCase();
    // Compare on a token-normalized form so CJK-stripping on the selected text
    // (e.g. "26800M 20 10m") still matches the structured raw label.
    const tok = (s: string) =>
      s.toLowerCase().replace(/[^a-z0-9]+/gi, " ").trim();
    const selTok = tok(selRaw);
    const match =
      structuredVariants.find(
        (v) => v.raw && selRaw.includes(clean(v.raw).toLowerCase()),
      ) ??
      structuredVariants.find(
        (v) => v.raw && clean(v.raw).toLowerCase().includes(selRaw),
      ) ??
      structuredVariants.find((v) => {
        if (!v.raw || !selTok) return false;
        const vt = tok(v.raw);
        return vt.includes(selTok) || selTok.includes(vt);
      }) ??
      // Fall back to model-code match (e.g. selected "26800M" vs model "26800mAh").
      structuredVariants.find((v) => {
        const modelDigits = (v.model ?? "").replace(/\D/g, "");
        const selDigits = selRaw.replace(/\D/g, "").slice(0, 6);
        return modelDigits && selDigits && modelDigits.startsWith(selDigits.slice(0, 4));
      });
    const rendered = match ? renderStructuredVariant(match) : "";
    if (rendered) selected.selectedSkuText = rendered;
    else selected.selectedSkuText = cleanRawSkuLabel(selected.selectedSkuText);
  } else if (selected.selectedSkuText) {
    // Deterministic fallback: never leak `68800M 80 _10 -` style soup.
    selected.selectedSkuText = cleanRawSkuLabel(selected.selectedSkuText);
  }
  // For an electrical kind, never show a selected SKU without a plug slot when
  // the variant set contains plug standards.
  if (electrical && selected.selectedSkuText && plugStandards.length) {
    const hasPlugInText = /(?:^|·\s*)(?:US|EU|UK|JP|KR|AU|CN)\b/.test(
      selected.selectedSkuText,
    );
    if (!selected.selectedPlugStandard && !hasPlugInText) {
      selected.selectedSkuText = `${selected.selectedSkuText} · стандарт вилки уточнить`;
    }
  }
  // Guard against garbage SKU labels ("+ -", "！", "-") leaking into questions/UI:
  // a real variant label must carry meaningful alphanumeric content. Otherwise the
  // variant is effectively unknown.
  if (
    selected.selectedSkuText &&
    selected.selectedSkuText.replace(/[^\p{L}\p{N}]/gu, "").length < 2
  ) {
    selected.selectedSkuText = null;
    selected.reliable = false;
  }
  return {
    skuSummary,
    selectedSkuText: selected.selectedSkuText,
    selectedSkuReliable: selected.reliable,
    selectedSkuDecision: selected,
    dimensions: dims,
    colors: allColors,
    sizes: sizeMatches,
    models,
    packageTypes,
    packCounts,
    plugStandards,
    selectedPlugStandard: selected.selectedPlugStandard,
    skuRisk: selected.reliable
      ? "ok"
      : count > 1
        ? "needs_selection"
        : "unknown",
    skuWarnings: uniq(
      [
        !selected.reliable && count > 1 ? "выбранный SKU не определён" : "",
        ambiguousParams.length
          ? `значение параметров SKU ${ambiguousParams.join(" / ")} нужно уточнить`
          : "",
      ],
      4,
    ),
    normalizedExamples,
    ambiguousParams,
    labeledParams: uniq(structuredSummaryPairs, 8),
  };
}

/**
 * A single-variant SKU whose "name" is just the product title (or a long
 * descriptive marketing string) carries no real SKU distinction. Detect this so
 * the report shows a clean "единственный вариант" instead of echoing the title.
 */
function isSingleVariantNoise(skuText: string, productTitle: string): boolean {
  const norm = (s: string) =>
    String(s ?? "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  const s = norm(skuText);
  if (!s) return true;
  const t = norm(productTitle);
  if (t && (s === t || t.includes(s) || s.includes(t))) return true;
  // Very long "SKU" strings are descriptive titles, not variant labels.
  if (skuText.trim().length > 40) return true;
  return false;
}

export function makeSelectedSkuDecision(
  product: any,
  variants = collectSkuVariants(product),
  sourceUrl?: string,
  kind?: ProductKind,
): SelectedSkuDecision {
  const electrical = !!kind && isElectricalKind(kind);
  const rawNameOf = (s: any): string =>
    String(
      s?.name ?? s?.label ?? s?.skuName ?? s?.propertiesName ?? s?.raw ?? "",
    );
  const plugOf = (raw: unknown): string | null =>
    electrical ? (extractPlugStandard(raw) ?? null) : null;
  // For electrical goods, build the display text from the raw (Chinese) SKU so
  // plug/color/model tokens survive; else fall back to the CJK-stripped name.
  const electricalText = (raw: string, fallback: string): string =>
    electrical ? structureElectricalSku(raw).text || fallback : fallback;
  const url = String(
    sourceUrl ?? product?.sourceUrl ?? product?.inputUrl ?? product?.url ?? "",
  );
  const urlSku = url.match(/[?&](?:skuId|skuid|sku|specId)=([^&#]+)/i)?.[1];
  if (urlSku) {
    const found = variants.find(
      (s: any) =>
        String(s?.skuId ?? s?.id ?? s?.specId ?? s?.offerSkuId ?? "") ===
        urlSku,
    );
    if (found) {
      const raw = rawNameOf(found);
      const name = skuName(found);
      return {
        selectedSkuText: electricalText(raw, name || `SKU ${urlSku}`),
        selectedPriceYuan: skuPrice(found),
        selectedPlugStandard: plugOf(raw),
        reliable: true,
        reason: "SKU взят из URL и найден в API.",
      };
    }
  }
  if (variants.length === 1) {
    const raw = rawNameOf(variants[0]);
    const name = skuName(variants[0]);
    // When the single variant "name" is basically the product title (or a very
    // long descriptive string), it's noise, not a real SKU distinction. Show a
    // clean placeholder instead of echoing the whole title.
    const productTitle = String(
      product?.titleRu ?? product?.titleEn ?? product?.titleCn ?? "",
    );
    const skuTextRaw = electricalText(raw, name || "единственный вариант");
    const isTitleNoise = isSingleVariantNoise(skuTextRaw, productTitle);
    return {
      selectedSkuText: isTitleNoise ? "единственный вариант" : skuTextRaw,
      selectedPriceYuan: skuPrice(variants[0]),
      selectedPlugStandard: plugOf(raw),
      reliable: true,
      reason: "В карточке один SKU.",
    };
  }
  const explicit =
    product?.selectedSku ??
    product?.selectedSkuText ??
    product?.selectedSkuName ??
    product?.normalized1688?.pricing?.selectedSkuName;
  const explicitPrice = pos(
    product?.selectedSkuPriceYuan ??
      product?.selectedSkuPrice ??
      product?.normalized1688?.pricing?.selectedSkuPriceYuan,
  );
  if (explicit)
    return {
      selectedSkuText: electricalText(String(explicit), safeRu(explicit)),
      selectedPriceYuan: explicitPrice,
      selectedPlugStandard: plugOf(explicit),
      reliable: true,
      reason: "SKU передан явно после выбора пользователя/URL.",
    };
  return {
    selectedSkuText: null,
    selectedPriceYuan: null,
    selectedPlugStandard: null,
    reliable: false,
    reason:
      variants.length > 1
        ? "В карточке несколько SKU, но выбранный SKU не подтверждён."
        : "SKU не найден в данных.",
  };
}

function buildPricing(
  product: any,
  selected: SelectedSkuDecision,
): ProductProcurementProfile["pricing"] {
  const variants = collectSkuVariants(product);
  const skuPrices = variants.map(skuPrice).filter((v): v is number => !!v);
  const min =
    pos(product?.priceRange?.min ?? product?.minPriceYuan) ??
    (skuPrices.length
      ? Math.min(...skuPrices)
      : pos(product?.priceYuan ?? product?.price));
  const max =
    pos(product?.priceRange?.max ?? product?.maxPriceYuan) ??
    (skuPrices.length ? Math.max(...skuPrices) : min);
  // A range/min price is only a *selected* price when the SKU decision is
  // reliable. Otherwise it stays a range and priceReliable must be false so
  // economics are not computed as exact.
  const selectedPrice = selected.reliable
    ? (selected.selectedPriceYuan ?? pos(product?.priceYuan ?? product?.price))
    : null;
  const normalized = normalizePrice({
    selectedPriceYuan: selectedPrice,
    minPriceYuan: min,
    maxPriceYuan: max,
  });
  return {
    displayPriceText: normalized.displayPriceText,
    selectedPriceYuan: normalized.selectedPriceYuan,
    minPriceYuan: normalized.minPriceYuan,
    maxPriceYuan: normalized.maxPriceYuan,
    priceSource: normalized.selectedPriceYuan
      ? "selected_sku"
      : skuPrices.length
        ? "sku_range"
        : normalized.minPriceYuan
          ? "price_range"
          : "missing",
    priceReliable: normalized.priceReliable,
    priceWarnings: uniq(
      [
        !selected.reliable ? "цена выбранного SKU требует подтверждения" : "",
        ...normalized.warnings,
      ],
      4,
    ),
  };
}

/**
 * Single source of truth for price display. Returns ONLY the value,
 * never prefixed with "Цена:". Never emits "0 ¥" / "0 ₽".
 */
export function formatPriceForDisplay(
  pricing: Pick<
    ProductProcurementProfile["pricing"],
    "selectedPriceYuan" | "minPriceYuan" | "maxPriceYuan"
  >,
): string {
  const selected = pos(pricing.selectedPriceYuan);
  const min = pos(pricing.minPriceYuan);
  const max = pos(pricing.maxPriceYuan);
  if (selected) return cny(selected);
  if (min && max && min !== max)
    return `${String(min).replace(".", ",")}–${String(max).replace(".", ",")} ¥`;
  if (min) return cny(min);
  return "нужно уточнить";
}

function buildQuestions(
  profileBase: Pick<ProductProcurementProfile, "identity" | "sku" | "pricing">,
  rules: (typeof KIND_RULES)[ProductKind],
): string[] {
  const priceValue = profileBase.pricing.selectedPriceYuan
    ? cny(profileBase.pricing.selectedPriceYuan)
    : "";
  const selectedSkuRaw = profileBase.sku.selectedSkuText
    ? fixMixedRuTypos(profileBase.sku.selectedSkuText)
    : "";
  // Do not embed a giant SKU string (title/placeholder/very long) into the
  // price question — it makes the question unreadable.
  const skuIsNoise =
    !selectedSkuRaw ||
    selectedSkuRaw.trim().length > 40 ||
    /^единственный вариант$/i.test(selectedSkuRaw.trim()) ||
    isSingleVariantNoise(selectedSkuRaw, profileBase.identity.titleForReport);
  const selectedSku = skuIsNoise ? "" : selectedSkuRaw;
  const priceQuestion =
    selectedSku && priceValue
      ? `Подтвердите цену выбранного SKU: ${selectedSku} — ${priceValue}.`
      : priceValue
        ? `Подтвердите цену выбранного SKU — ${priceValue}.`
        : "Подтвердите цену выбранного SKU.";
  const params = profileBase.sku.ambiguousParams;
  const base = rules.mustAskSupplier.map((q) =>
    q
      .replace("Подтвердите цену выбранного SKU.", priceQuestion)
      .replace(
        "Укажите вес с упаковкой.",
        "Укажите вес с упаковкой выбранного SKU.",
      ),
  );
  const merged = params.length
    ? [
        ...base.filter((q) => !/Что означает параметр|параметр SKU/i.test(q)),
        `Что означают параметры SKU ${params.join(" / ")}: диаметр, длина, размер, комплектация или другой параметр?`,
      ]
    : base;
  const priority: Array<RegExp> = [
    /цен(?:а|у|ы|е|ой|у выбранного)/i,
    /вес/i,
    /габарит|размер.*упаков|упаков.*размер/i,
    /состав/i,
    /точн.*размер|длина|ширина|растяж/i,
    /сетчат|дыхани/i,
    /уф|uv|upf/i,
    /фото/i,
    /образец/i,
    /параметр/i,
    /диаметр/i,
    /спиц/i,
    /чехол/i,
    /материал/i,
    /комплектац/i,
    /moq/i,
  ];
  const rank = (q: string) => {
    const i = priority.findIndex((rx) => rx.test(q));
    return i < 0 ? 999 : i;
  };
  return uniq(merged, 14)
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, 10);
}

function buildKindVerdict(
  kind: ProductKind,
  product: any,
  needsSupplierData: boolean,
  reliability?: {
    priceReliable: boolean;
    selectedPlugStandard: string | null;
    hasPlugVariants: boolean;
    ordersUnknownOrZero: boolean;
  },
): string {
  if (isElectricalKind(kind) && reliability) {
    const plugMissing =
      reliability.hasPlugVariants && !reliability.selectedPlugStandard;
    const blocked =
      !reliability.priceReliable ||
      plugMissing ||
      reliability.ordersUnknownOrZero;
    if (blocked) {
      return "Заказывать образец рано. Сначала нужно подтвердить цену выбранного SKU, стандарт вилки, напряжение, мощность, температурный диапазон, сертификаты, вес и упаковку.";
    }
    return "Можно готовить образец, но партию закупать только после проверки вилки, нагрева, дисплея, сертификатов и упаковки.";
  }
  if (kind === "dish_rack" || kind === "kitchen_storage_rack") {
    return "Товар можно рассматривать для образца, но партию закупать рано. Сначала подтвердите размер выбранного SKU, количество ярусов, материал, покрытие, комплектацию, вес и упаковку. На образце нужно проверить устойчивость, качество покрытия, сборку и риск деформации при доставке.";
  }
  if (kind === "clothing" && isBalaclavaProduct(product)) {
    return "Товар можно рассматривать для образца, но партию закупать рано. Сначала подтвердите состав ткани, размеры, посадку, упаковку и заявленную УФ-защиту. На образце важно проверить комфорт дыхания, швы, растяжимость и посадку на голове/лице.";
  }
  if (kind === "umbrella") {
    return "Товар можно рассматривать для образца, но партию закупать рано. Сначала подтвердите механизм, спицы, материал купола, наличие чехла, размер в сложенном/раскрытом виде и заявленную UPF-защиту.";
  }
  if (kind === "footwear") {
    return "Товар можно рассматривать для образца, но партию закупать рано. Сначала подтвердите длину стельки, размерность, материал, запах EVA/PU, качество литья/склейки и упаковку.";
  }
  if (kind === "sleep_mask") {
    return "Товар можно рассматривать для образца, но партию закупать рано. Сначала подтвердите материал, 3D-форму, затемнение, ремешок, упаковку и комфорт при носке.";
  }
  if (kind === "mini_washer") {
    return "Товар можно рассматривать для образца, но партию закупать рано. Сначала подтвердите мощность, напряжение, тип вилки, слив, режимы работы, инструкцию и видео работы.";
  }
  return needsSupplierData
    ? "Товар можно рассматривать для образца, но партию закупать рано. Сначала подтвердите выбранный SKU, цену, вес, упаковку, материал и реальные фото."
    : "Можно готовить заказ образца. Партию закупать только после проверки образца и упаковки.";
}

// Builds the category-agnostic gap-engine context from an assembled profile
// (identity/sku/pricing) + raw product. Shared by the supplier-questions ranking
// and the buyer-brief "must confirm" checklist so both read the same signals.
function gapContextFromProfile(
  p: Pick<ProductProcurementProfile, "identity" | "sku" | "pricing">,
  product: any,
): GapEngineContext {
  return {
    productText: [
      p.identity.coreObject,
      p.identity.titleForReport,
      product?.titleRu,
      product?.titleEn,
      product?.titleCn,
      product?.categoryName,
      ...p.identity.materials,
      ...p.identity.visibleFeatures,
      ...p.identity.claimedFeatures,
      ...p.identity.useCases,
    ]
      .filter(Boolean)
      .join(" "),
    materials: p.identity.materials,
    weightKgKnown: extractWeightKg(product) != null,
    packageDimsKnown: extractDimensionsCm(product) != null,
    priceReliable: p.pricing.priceReliable,
    selectedSkuReliable: p.sku.selectedSkuReliable,
  };
}

// Normalized key for de-duplicating questions (Unicode-safe).
function questionKey(q: string): string {
  return q.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

// Deterministic hard-gate questions from the profile's own state. Currently: when
// the variant is unconfirmed, force a composition-aware "which SKU / what's
// included" question — the single most important thing to confirm before buying an
// ambiguous listing. Category-agnostic (built from the SKU's own variant data).
function buildLeadQuestions(
  sku: ProductProcurementProfile["sku"],
  pricing: ProductProcurementProfile["pricing"],
): string[] {
  const lead: string[] = [];
  if (!sku.selectedSkuReliable) {
    const priceText =
      pricing.displayPriceText &&
      !/не\s*указан|missing|^—$/i.test(pricing.displayPriceText.trim())
        ? ` за ${clean(pricing.displayPriceText)}`
        : "";
    const variants = uniq(
      [...sku.packageTypes, ...sku.models, ...sku.colors]
        .map((v) => clean(v))
        .filter(Boolean),
      4,
    );
    const variantHint = variants.length
      ? ` Что именно входит в этот комплект (в карточке есть варианты: ${variants.join(" / ")}) — сам товар или только упаковка/аксессуар?`
      : " Входит ли в комплект сам товар, а не только упаковка/аксессуар?";
    lead.push(
      `Какой именно SKU соответствует цене${priceText}?${variantHint}`,
    );
  }
  return lead;
}

// Composes the final supplier-question list: hard gates first, then the LLM's top
// questions, then RESERVED slots for the universal basics — so a verbose LLM list
// can't push logistics/compliance off the capped end. Lead questions are fed to
// the gap engine too, so their slots (variant/price) aren't re-added generically.
function assembleSupplierQuestions(
  lead: string[],
  domainQuestions: string[],
  ctx: GapEngineContext,
  cap: number,
): string[] {
  const merged = applyUniversalGaps([...lead, ...domainQuestions], ctx);
  const leadKeys = new Set(lead.map(questionKey));
  // Cargo essentials (packed weight, individual-package dims, carton) are required
  // for any quote and the LLM almost never asks them; material grade likewise. They
  // may arrive from KIND_RULES (tail of domainQuestions) or the gap engine — either
  // way RESERVE slots for them by CONTENT so a verbose LLM list can't cap them out.
  // Patterns match the questions' own wording, not product/category terms.
  const isCargo = (q: string) =>
    /вес[^.]*(с\s+упаковк|с\s+индивидуальн|брутто)|габарит[а-яё]*\s*(индивидуальн|упаковк)|транспортн[а-яё]*\s+короб|коробе|коробк|карт[оа]н|мастер-?короб/i.test(
      q,
    );
  const isMaterial = (q: string) =>
    /материал|марк[аиуе]\s*(стали|металл|пластик)|состав\s+(ткани|материал)/i.test(q);
  // A hard-gate lead already asks "which SKU / what's included" → drop the gap
  // engine's generic variant re-ask (its own internal string) to avoid a duplicate.
  const body = merged.filter(
    (q) =>
      !leadKeys.has(questionKey(q)) &&
      !(lead.length && /какой\s+именно\s+вариант\/sku\s+соответствует/i.test(q)),
  );
  const cargo = body.filter(isCargo);
  const material = body.filter((q) => isMaterial(q) && !isCargo(q));
  // Reserve up to 3 cargo essentials + 1 material; drop any EXTRA cargo/material
  // from the tail so they can't produce duplicate material/packaging questions.
  const reserved = [...cargo.slice(0, 3), ...material.slice(0, 1)];
  const cargoMaterialKeys = new Set([...cargo, ...material].map(questionKey));
  const rest = body.filter((q) => !cargoMaterialKeys.has(questionKey(q)));
  // Order: hard gate → LLM's top product-specific questions → reserved
  // cargo/material at the end. Guarantees the basics survive the cap without
  // pushing the LLM's own priorities (e.g. a knife's HRC) below them.
  const keptRest = rest.slice(0, Math.max(0, cap - lead.length - reserved.length));
  const composed = [...lead, ...keptRest, ...reserved];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of composed) {
    const k = questionKey(q);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(q);
    if (out.length >= cap) break;
  }
  return out;
}

export function buildProductProcurementProfile(
  product: any,
  opts: { sourceUrl?: string; intelligence?: ProductIntelligence | any } = {},
): ProductProcurementProfile {
  const intelligence =
    opts.intelligence ??
    product?.procurementProfileSourceIntelligence ??
    product?.productIntelligence ??
    product?.intelligence ??
    product?.productContext?.productIntelligence ??
    {};
  const aiDraft = record(
    product?.productProcurementProfileDraft ??
      product?.procurementProfileDraft ??
      product?.productContext?.procurementProfileDraft ??
      product?.productContext?.profileDraft,
  );
  const classifier = classifyProductKindConsensus(product, intelligence);
  const draftKind = normalizeProductKind(
    record(aiDraft.identity).productKind ?? aiDraft.productKind,
  );
  const kind = draftKind ?? classifier.productKind;
  const rules = productSpecificRules(kind, product, intelligence);
  const aiContent = aiDomainContent(product);
  const sourceUrl = opts.sourceUrl ?? product?.sourceUrl ?? product?.inputUrl;
  const sku = buildSkuProfile(product, kind, sourceUrl);
  const pricing = buildPricing(product, sku.selectedSkuDecision);
  const materials = collectMaterials(product, intelligence, kind);
  const identity = record(intelligence?.productIdentity);
  const cleanTitles = record(intelligence?.cleanTitles);
  const draftIdentity = record(aiDraft.identity);
  const selectedTitles = selectBestProductTitle({
    intelligenceTitle:
      draftIdentity.titleForReport ||
      cleanTitles.titleForReport ||
      cleanTitles.titleRuClean ||
      identity.shortNameRu ||
      identity.marketNameRu,
    translatedTitle: product?.titleRu || product?.titleEn,
    rawTitleCn: product?.titleCn,
    productKind: kind,
    fallbackTitle: product?.seoContent?.titleRu,
    candidates: [
      draftIdentity.titleForSeo,
      cleanTitles.titleForWb,
      cleanTitles.titleForSeo,
    ],
  });
  const titleForReport = cleanDisplayTitle(selectedTitles.titleForReport);
  const titleForSeo = cleanDisplayTitle(
    safeSeoTitle(
      safeRu(draftIdentity.titleForSeo || selectedTitles.titleForSeo),
      kind,
    ),
  );
  const missing = uniq(
    [
      ...(pricing.priceReliable ? [] : ["цена выбранного SKU"]),
      ...(product?.weightKg ? [] : ["вес с упаковкой"]),
      ...(sku.selectedSkuReliable ? [] : ["выбранный SKU"]),
      ...array<string>(intelligence?.dataQuality?.missingCriticalFields),
    ],
    8,
  );
  const baseProfile = {
    identity: {
      productKind: kind,
      categoryType:
        kind === "heating_food_mat"
          ? "small_appliance"
          : kind === "dish_rack" || kind === "kitchen_storage_rack"
            ? "home_kitchen"
            : safeRu(identity.categoryType || product?.categoryType || kind),
      subCategoryType:
        kind === "heating_food_mat"
          ? "food_warmer"
          : safeRu(identity.subCategoryType || ""),
      titleForReport: safeTitle(titleForReport),
      titleForSeo,
      shortTitle: safeRu(identity.shortNameRu || titleForReport),
      coreObject: safeRu(identity.coreObject || titleForReport),
      formFactor: safeRu(draftIdentity.formFactor || identity.formFactor || ""),
      audience: safeRu(draftIdentity.audience || identity.audience || ""),
      gender: safeRu(draftIdentity.gender || identity.gender || ""),
      season: safeRu(draftIdentity.season || identity.season || ""),
      useCases: uniq(
        [
          ...array<string>(draftIdentity.useCases),
          ...array<string>(identity.useCases),
        ].map(safeRu),
        6,
      ),
      materials: normalizeMaterials(
        uniq(
          [...array<string>(draftIdentity.materials).map(safeRu), ...materials],
          6,
        ),
        2,
      ),
      visibleFeatures: uniq(
        [
          ...array<string>(draftIdentity.visibleFeatures),
          ...array<string>(identity.visibleFeatures),
        ].map(safeRu),
        8,
      ),
      claimedFeatures: uniq(
        [
          ...array<string>(draftIdentity.claimedFeatures),
          ...array<string>(identity.importantFeatures),
          ...array<string>(intelligence?.claimsPolicy?.claimedButNeedProof),
        ].map(safeRu),
        8,
      ),
      unconfirmedFeatures: uniq(
        [
          ...array<string>(draftIdentity.unconfirmedFeatures),
          ...array<string>(identity.notConfirmedFeatures),
          ...array<string>(identity.unconfirmedFeatures),
        ].map(safeRu),
        8,
      ),
    },
    sku,
    pricing,
  } as Pick<ProductProcurementProfile, "identity" | "sku" | "pricing">;
  const draftProcurement = record(aiDraft.procurement);
  // Single cross-cutting critical block the LLM derives from THIS product's nature
  // (electrical/compliance for a powered device, composition/shrink for textile,
  // transport docs for battery, …). Fanned into every surface below so domain
  // coverage is consistent by construction. Category-agnostic: no hardcoded list —
  // the model produces it; the deterministic layer only guarantees distribution.
  const criticalConfirmations = aiCriticalConfirmations(product);
  const domainQuestions = uniq(
    [
      // Critical block first so it survives the supplier-question cap.
      ...criticalConfirmations,
      ...array<string>(draftProcurement.mustAskSupplier).map(safeRu),
      ...buildQuestions(baseProfile, rules),
    ],
    20,
  );
  // Hard gates (deterministic): the questions EVERY document must lead with. When
  // the variant isn't confirmed, "which SKU / what's included" is always #1 — the
  // more so when variants differ in contents (full item vs case/box only). Built
  // from the profile's own SKU data, category-agnostic.
  const leadQuestions = buildLeadQuestions(sku, pricing);
  // Universal, category-agnostic gap engine guarantees the procurement basics
  // (packed weight, package/carton dims, material, transport, compliance) are
  // present. Assembly forces the hard gates first and RESERVES cap slots for the
  // basics, so a long LLM list can't push logistics/compliance off the end.
  const mustAskSupplier = assembleSupplierQuestions(
    leadQuestions,
    domainQuestions,
    gapContextFromProfile(baseProfile, product),
    10,
  );
  const images = collectProductIntelligenceImages(product, 3);
  const supplierRaw =
    product?.supplierType ??
    product?.normalized1688?.supplierType ??
    product?.normalized1688?.debug?.sellerType;
  return {
    ...baseProfile,
    supplier: {
      displayType: supplierTypeDisplay(supplierRaw),
      rating: clean(product?.supplierRating ?? product?.rating ?? "—") || "—",
      orders: clean(product?.sold ?? product?.orders ?? "—") || "—",
      name: resolveSupplierName(product?.supplierName),
      reliability: computeSupplierReliability(product),
    },
    logistics: (() => {
      const dimensionsCm = extractDimensionsCm(product);
      return {
        weightKg: extractWeightKg(product),
        dimensionsCm,
        volumetricWeightKg: volumetricWeightKgFromDimensions(dimensionsCm),
      };
    })(),
    procurement: {
      status: missing.length
        ? "🟡 Нужны данные поставщика"
        : "🟢 Готов к заказу образца",
      verdict: buildKindVerdict(kind, product, missing.length > 0, {
        priceReliable: pricing.priceReliable,
        selectedPlugStandard: sku.selectedPlugStandard,
        hasPlugVariants: sku.plugStandards.length > 0,
        ordersUnknownOrZero: (() => {
          const o = String(product?.sold ?? product?.orders ?? "").trim();
          if (!o || o === "—") return true;
          const digits = o.replace(/\D/g, "");
          return digits === "" || Number(digits) === 0;
        })(),
      }),
      nextAction: "Отправьте вопросы поставщику и скачайте закупочный пакет.",
      leadQuestions,
      criticalConfirmations,
      mustAskSupplier,
      mustCheckBeforeSample: normalizeFragmentLines(
        uniq(
          [
            ...criticalConfirmations,
            ...array<string>(draftProcurement.mustCheckBeforeSample).map(safeRu),
            ...rules.beforeSample,
          ],
          10,
        ),
      ),
      mustCheckOnSample: uniq(
        [
          ...array<string>(draftProcurement.mustCheckOnSample).map(safeRu),
          ...rules.onSample,
        ],
        12,
      ),
      redFlags: normalizeFragmentLines(
        uniq(
          [
            // Hard SKU-composition flag first: when the variant is unconfirmed and
            // the listing has case/box-only variants, the #1 risk is receiving the
            // wrong set (only packaging) instead of the product itself.
            ...(sku.selectedSkuReliable
              ? []
              : [
                  "Заказанный SKU может оказаться не тем комплектом — проверить, что в него входит сам товар, а не только упаковка/футляр/коробка/аксессуар",
                ]),
            ...array<string>(draftProcurement.redFlags).map(safeRu),
            ...rules.redFlags,
            ...array<string>(intelligence?.reportRules?.riskFlags).map(safeRu),
          ],
          12,
        ),
      ),
    },
    cargo: {
      mustAsk: uniq(
        [
          "вес одной единицы с упаковкой",
          "габариты индивидуальной упаковки",
          "количество в транспортной коробке",
          "вес транспортной коробки",
          "габариты транспортной коробки",
          "фото индивидуальной упаковки",
          "фото транспортной коробки",
          "материал товара",
          "ограничения по перевозке",
          ...rules.cargo,
          // Cross-cutting critical block (e.g. plug/voltage/certs/power-marking for a
          // powered device) — the compliance items a forwarder needs. Same source as
          // the other surfaces, so cargo can't silently drop the electrical profile.
          ...criticalConfirmations,
        ],
        16,
      ),
      likelySensitiveCargoIssues: uniq(
        [
          ...aiContent.cargoSensitiveIssues,
          ...(kind === "mini_washer" ||
          kind === "small_appliance" ||
          kind === "usb_device"
            ? [
                "питание/вилка/напряжение",
                "аккумулятор или батарейка — уточнить",
                "сертификаты для техники",
              ]
            : []),
        ],
        6,
      ),
      whatToRequest: aiContent.cargoWhatToRequest,
      cargoNature: aiContent.cargoNature || undefined,
      packagingNotes: aiContent.cargoPackagingNotes || undefined,
    },
    content: {
      seoAllowedClaims: uniq(
        [
          ...array<string>(record(aiDraft.content).seoAllowedClaims).map(
            safeRu,
          ),
          ...rules.seoAllowed,
          ...array<string>(intelligence?.reportRules?.seoAllowedClaims).map(
            safeRu,
          ),
        ],
        12,
      ),
      seoForbiddenClaims: uniq(
        [
          ...array<string>(record(aiDraft.content).seoForbiddenClaims).map(
            safeRu,
          ),
          ...rules.seoForbidden,
          ...array<string>(intelligence?.reportRules?.seoForbiddenClaims).map(
            safeRu,
          ),
          ...(kind === "dish_rack" || kind === "kitchen_storage_rack"
            ? []
            : DANGEROUS_CLAIMS),
        ],
        18,
      ),
      titleWarnings: dangerousClaims(titleForSeo).map(
        (c) => `Не писать в названии без подтверждения: ${c}`,
      ),
      infographicIdeas: uniq(
        [
          ...array<string>(record(aiDraft.content).infographicIdeas).map(
            safeRu,
          ),
          ...rules.infographic,
          ...array<string>(intelligence?.reportRules?.infographicIdeas).map(
            safeRu,
          ),
        ],
        7,
      ),
      seoDescription: aiContent.seoDescription || undefined,
      seoBullets: aiContent.seoBullets.length
        ? aiContent.seoBullets
        : undefined,
      seoKeywords: aiContent.seoKeywords.length
        ? aiContent.seoKeywords
        : undefined,
      seoTitle: aiContent.seoTitle || undefined,
      seoCharacteristics: aiContent.seoCharacteristics.length
        ? aiContent.seoCharacteristics
        : undefined,
    },
    dataQuality: {
      missingCriticalFields: missing,
      contradictions: uniq(
        [
          ...(sku.selectedSkuReliable ? [] : ["выбранный SKU не подтверждён"]),
          ...array<any>(product?.productContext?.conflicts).map((c: any) =>
            safeRu(c.field || c.message || c),
          ),
        ],
        8,
      ),
      confidence: (["high", "medium", "low"].includes(
        String(intelligence?.dataQuality?.overallConfidence),
      )
        ? intelligence.dataQuality.overallConfidence
        : missing.length > 3
          ? "low"
          : "medium") as any,
      reason: safeRu(
        intelligence?.dataQuality?.reason ||
          `Профиль собран из Product Intelligence v2, selected SKU, цены, поставщика, атрибутов и ${images.length ? "фото" : "текстовых данных"} 1688. Уверенность классификации: ${classifier.confidenceLabel}.`,
      ),
    },
    classifier,
    intelligenceImages: images,
    // CN questions must keep their Chinese characters (do NOT run through safeRu,
    // which strips CJK). Read the translation + its validity from the draft or the
    // product, populated upstream by the RU→CN translator.
    supplierQuestionsCn: array<string>(
      record(draftProcurement).supplierQuestionsCn ?? product?.supplierQuestionsCn,
    ),
    supplierQuestionsCnValid: Boolean(
      record(draftProcurement).supplierQuestionsCnValid ??
        product?.supplierQuestionsCnValid,
    ),
  };
}

export function ensureProductProcurementProfile(
  product: any,
  opts: { sourceUrl?: string } = {},
): ProductProcurementProfile {
  const existing =
    product?.productProcurementProfile ?? product?.procurementProfile;
  if (
    existing?.identity?.productKind &&
    existing?.procurement?.mustAskSupplier?.length
  )
    return existing as ProductProcurementProfile;
  const profile = buildProductProcurementProfile(product, opts);
  if (product && typeof product === "object") {
    product.productProcurementProfile = profile;
    product.procurementProfile = profile;
  }
  return profile;
}

export function collectProductIntelligenceImages(
  product: any,
  limit = 3,
): ProductIntelligenceImage[] {
  const variants = collectSkuVariants(product);
  const selectedName = String(
    product?.selectedSkuName ??
      product?.selectedSkuText ??
      product?.normalized1688?.pricing?.selectedSkuName ??
      "",
  ).trim();
  const selectedVariant = selectedName
    ? variants.find(
        (s: any) =>
          skuName(s).toLowerCase() === selectedName.toLowerCase() ||
          String(s?.name ?? "").toLowerCase() === selectedName.toLowerCase(),
      )
    : null;
  const selectedImage = clean(
    product?.selectedSkuImage ??
      product?.selectedSkuImageUrl ??
      selectedVariant?.image ??
      selectedVariant?.imageUrl ??
      "",
  );
  const rawImages = array<string>(
    product?.images ?? product?.imageUrls ?? product?.normalized1688?.images,
  ).filter(Boolean);
  const mainImage = clean(product?.mainImageUrl) || rawImages[0] || "";
  const candidates: ProductIntelligenceImage[] = [];
  if (selectedImage)
    candidates.push({
      url: selectedImage,
      role: "selected_sku_image",
      note: "Фото выбранного SKU; использовать только для типа товара, формы и видимых деталей.",
    });
  if (mainImage)
    candidates.push({
      url: mainImage,
      role: "main_product_image",
      note: "Главное фото карточки; цена, MOQ, остатки и SKU берутся только из API.",
    });
  for (const url of rawImages) {
    if (!url || candidates.some((img) => img.url === url)) continue;
    candidates.push({
      url,
      role: candidates.length < 2 ? "detail_image" : "package_image",
      note: "Дополнительное фото карточки для проверки видимых деталей.",
    });
    if (candidates.length >= limit) break;
  }
  const seen = new Set<string>();
  return candidates
    .filter((img) => {
      if (!img.url || seen.has(img.url)) return false;
      seen.add(img.url);
      return true;
    })
    .slice(0, limit);
}

export function preprocessMainImageForProductIntelligence(product: any): {
  url: string | null;
  role: string;
  note: string;
  images: ProductIntelligenceImage[];
} {
  const images = collectProductIntelligenceImages(product, 3);
  const first = images[0];
  return {
    url: first?.url ?? null,
    role: first?.role ?? "main_product_image",
    note: first?.note ?? "Главное фото не найдено.",
    images,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strip a bare trailing material/steel grade (3CR13, 4CR13, 5CR15, 304, 430,
 * 201, 440C, etc.) that leaked into a display title, and capitalize the first
 * letter. The grade belongs in the Материал field, not the product name.
 */
export function cleanDisplayTitle(title: unknown): string {
  let out = clean(title)
    // Trailing bare steel/material grade tokens: 3CR13 / 4Cr13 / 440C / 304 / 430 / 201 / 18/10.
    .replace(
      /[\s,;·—-]*\b(?:[2-9]?cr\s?\d{2,3}[a-z]?|\d{3}[a-z]?|18\/1\d)\b\s*$/i,
      "",
    )
    .replace(/[\s,;·—-]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!out) return "";
  return out.charAt(0).toUpperCase() + out.slice(1);
}

// An SEO title must not assert an unconfirmed material grade/alloy CODE as fact:
// on 1688 the material is always a seller claim (the questions file asks the
// supplier to confirm that very grade). Category-agnostic — strips only the
// alloy/grade codes, keeping the base material noun (сталь, алюминий). The code
// stays valid as a search keyword, just not as a title-level fact.
// Examples: "сталь 3Cr13" → "сталь", "SUS304 нержавейка" → "нержавейка".
function stripUnconfirmedGradeTokens(title: string): string {
  return title
    .replace(/\b\d{1,2}Cr\d{1,2}(?:MoV|Mo|V|Ni|Si|Mn)?\b/gi, " ") // 3Cr13, 5Cr15MoV
    .replace(/\bSUS\s?\d{3}[A-Za-z]?\b/gi, " ") // SUS304, SUS 316L
    .replace(/\bмарк[аиуеой]\s+[A-Za-z0-9-]+/gi, " ") // "марка 304"
    // Tidy punctuation orphaned by a removed code (e.g. "сталь , для" → "сталь,").
    .replace(/\s+,/g, ",")
    .replace(/,\s*,/g, ",")
    .replace(/\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,]+|[\s,]+$/g, "")
    .trim();
}

// A number followed by a physical unit asserted in the SEO title. Category- and
// word-agnostic: it matches the numeric+unit PATTERN, not any product term. On
// 1688 these specs (length, weight, angle, power) are seller claims, never
// confirmed — so the title must not present them as fact while the questions
// file / characteristics table simultaneously ask to confirm them. Mirrors the
// bullet-level BULLET_MEASUREMENT_RE guard. Bare counts ("3 в 1", "5 шт") carry
// no physical unit and are kept.
function stripAssertedMeasurements(title: string): string {
  return title
    .replace(
      // NB: JS \b is ASCII-only — a trailing \b after a Cyrillic unit ("см") never
      // matches, so the token was never stripped. Use a Unicode-safe negative
      // lookahead (unit not followed by another letter) instead.
      /\s*\b\d+(?:[.,]\d+)?\s*(?:см|мм|кг|мл|hrc|вт|ватт|вольт|дюйм|градус[а-яё]*|°)(?![а-яёa-z])\.?/gi,
      " ",
    )
    .replace(/\s+,/g, ",")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,]+|[\s,·—–-]+$/g, "")
    .trim();
}

function safeSeoTitle(title: string, kind: ProductKind): string {
  let out = fixMixedRuTypos(
    stripRawSourceLabels(
      title || KIND_RULES[kind]?.seoAllowed?.[0] || "Товар с 1688",
    ),
  );
  out = out
    .replace(/\b(?:WB|Ozon)\b/gi, "")
    .replace(
      /cross[\s-]?border|для\s*cross[\s-]?border\s*торговли|\bтовар\b|\bфункции\b/gi,
      "",
    )
    .replace(/\s{2,}/g, " ")
    .trim();
  for (const re of DANGEROUS_CLAIM_RES)
    out = out.replace(new RegExp(re.source, "gi"), "").trim();
  out = stripUnconfirmedGradeTokens(out);
  out = stripAssertedMeasurements(out);
  if (kind === "dish_rack" || kind === "kitchen_storage_rack")
    return "Сушилка для посуды настольная многоярусная";
  if (/балаклав|подшлемник/i.test(out))
    return "Балаклава защитная от солнца и ветра для велосипеда и активного отдыха";
  if (kind === "umbrella" && /зонт/i.test(out) && !/крюч|чехол/i.test(out))
    out = "Зонт автоматический складной с крючком и чехлом";
  if (isBadTitleCandidate(out))
    return selectBestProductTitle({ productKind: kind }).titleForSeo;
  return (
    out.replace(/\s{2,}/g, " ").trim() ||
    selectBestProductTitle({ productKind: kind }).titleForSeo
  );
}

// Build a stem-tolerant matcher for a claim phrase. Russian is inflected, so a
// literal "профессиональный" fails to catch "профессиональных поваров" /
// "профессиональной кухни" — the exact leak that let forbidden claims through
// the SEO guard. We stem each adjectival word to its root and allow any ending.
function claimToRegex(claim: string): RegExp {
  const parts = claim
    .toLowerCase()
    .split(/\s+/)
    .map((w) => {
      const m = w.match(/^([а-яё]{5,})(ый|ий|ой|ая|яя|ое|ее|ые|ие)$/);
      return m ? `${escapeRegExp(m[1])}[а-яё]*` : escapeRegExp(w);
    });
  return new RegExp(parts.join("\\s+"), "i");
}
const DANGEROUS_CLAIM_RES = DANGEROUS_CLAIMS.map(claimToRegex);
function dangerousClaims(text: string): string[] {
  return DANGEROUS_CLAIMS.filter((_c, i) => DANGEROUS_CLAIM_RES[i].test(text));
}
/** Public: does the text assert any dangerous claim (stem-tolerant)? */
export function textHasDangerousClaim(text: string): boolean {
  return dangerousClaims(text).length > 0;
}
/** Public: does the text contain evaluative puffery water? */
export function textHasPuffery(text: string): boolean {
  return hasPuffery(text);
}

// Evaluative "puffery" — quality claims asserted as fact with no proof. Unlike
// DANGEROUS_CLAIMS these aren't legally risky, but they read as generated water
// ("высококачественный", "эффективная нарезка", "обеспечивает точность") and are
// the main thing keeping SEO drafts at ~5/10. Category-agnostic: matched by stem.
const PUFFERY_STEMS = [
  "высококачествен", "качествен", "идеальн", "эффективн", "незаменим",
  "долговечн", "премиальн", "превосходн", "непревзойден", "совершенн",
  "первоклассн", "наилучш", "великолепн", "отличн", "прекрасн", "лучш",
  "надежн", "прочн", "острейш", "сверхостр", "гарантиру", "обеспечива",
  "легко и просто", "на долгие годы", "прослужит", "порадует",
];
const PUFFERY_RE = new RegExp(
  PUFFERY_STEMS.map((s) =>
    /[а-яё]$/i.test(s) && !/\s/.test(s) ? `${s}[а-яё]*` : s,
  ).join("|"),
  "i",
);
// Empty "audience filler" — vague marketing that names a buyer/scenario but
// states no concrete product fact ("подходит как для дома, так и для тех, кто
// ценит удобство"; "станет незаменимым помощником"). Category-agnostic, and
// distinct from PUFFERY_STEMS (which catches praise adjectives): these are
// hollow sentence constructions. Kept narrow to avoid dropping real features.
const VAGUE_MARKETING_RE =
  /подходит\s+(?:как\s+)?для\s+[^.!?]*\bтак\s+и\s+для\b|для\s+тех,?\s+кто\s+(?:ценит|любит|предпочита|ищет|заботит|привык)|стан(?:ет|ут)\s+[^.!?]*\b(?:помощник|выбор|подарк|дополнени|решени|спутник)|оцен(?:ит|ят)\s+по\s+достоинств|не\s+оставит\s+равнодушн|для\s+ценител|тем,?\s+кто\s+ценит/i;
function hasPuffery(text: string): boolean {
  return PUFFERY_RE.test(text) || VAGUE_MARKETING_RE.test(text);
}
// Drop puffery/claim sentences from an LLM paragraph, keeping the honest ones.
// Better than rejecting the whole description to the generic floor: we salvage
// the concrete, factual sentences (what it is / what it's for / material).
function stripPufferySentences(text: string): string {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const kept = sentences.filter(
    (s) => !hasPuffery(s) && !dangerousClaims(s).length,
  );
  return kept.join(" ").replace(/\s{2,}/g, " ").trim();
}

function pluralRu(n: number, one: string, few: string, many: string): string {
  const v = Math.abs(n) % 100;
  const v1 = v % 10;
  if (v > 10 && v < 20) return many;
  if (v1 > 1 && v1 < 5) return few;
  if (v1 === 1) return one;
  return many;
}

export function buildMainReportFromProfile(
  product: any,
  statusInfo?: { creditsRemaining?: number },
  opts: { sourceUrl?: string } = {},
): string {
  const p = ensureProductProcurementProfile(product, opts);
  // Economics are only computed when the price is reliable (confirmed selected
  // SKU). An unconfirmed range must not turn into an "exact" cost estimate.
  const priceYuan = p.pricing.priceReliable
    ? (p.pricing.selectedPriceYuan ?? p.pricing.minPriceYuan)
    : null;
  const purchaseRub = priceYuan ? Math.round(priceYuan * YUAN_TO_RUB) : null;
  const costWithoutCargo = purchaseRub
    ? Math.round(purchaseRub * (1 + BANK_MARKUP) + FULFILLMENT_RUB)
    : null;
  const moq = pos(product?.moq ?? product?.normalized1688?.moq);
  const weight = p.logistics?.weightKg ?? extractWeightKg(product);
  const rel = p.supplier.reliability;
  const relLine = `Надёжность: ${rel.badge} ${RELIABILITY_LEVEL_RU[rel.level]}${rel.reasons.length ? ` — ${rel.reasons.slice(0, 3).join(", ")}` : ""}`;
  const lines: Array<string | null> = [
    `📦 <b>${escapeHtml(p.identity.titleForReport)}</b>`,
    "",
    "Источник: 1688",
    `Поставщик: ${escapeHtml(p.supplier.displayType)}${p.supplier.rating && p.supplier.rating !== "—" ? ` · рейтинг ${escapeHtml(p.supplier.rating)}` : ""}${p.supplier.orders && p.supplier.orders !== "—" ? ` · заказов ${escapeHtml(p.supplier.orders)}` : ""}`,
    escapeHtml(relLine),
    "",
    "📌 <b>Товар</b>",
    `• Цена: ${escapeHtml(formatPriceForDisplay(p.pricing))}`,
    `• Выбранный SKU: ${escapeHtml(p.sku.selectedSkuText || (p.sku.selectedSkuReliable ? "не определён" : `не определён. ${p.pricing.minPriceYuan && p.pricing.maxPriceYuan ? `Цена по SKU: ${String(p.pricing.minPriceYuan).replace(".", ",")}${p.pricing.maxPriceYuan !== p.pricing.minPriceYuan ? `–${String(p.pricing.maxPriceYuan).replace(".", ",")}` : ""} ¥.` : "Нужен выбор SKU."}`))}`,
    `• MOQ: ${moq ? `${Math.round(moq)} шт` : "уточнить"}`,
    `• SKU: ${escapeHtml(p.sku.skuSummary)}`,
    p.sku.models.length
      ? `• Модели: ${escapeHtml(p.sku.models.join(", "))}`
      : null,
    p.sku.colors.length
      ? `• Цвета: ${escapeHtml(p.sku.colors.join(", "))}`
      : null,
    p.sku.plugStandards.length
      ? `• Стандарты вилки: ${escapeHtml(p.sku.plugStandards.join(", "))} — уточнить выбранный SKU`
      : null,
    p.sku.labeledParams.length
      ? `• Параметры: ${escapeHtml(p.sku.labeledParams.join(" · "))}`
      : p.sku.sizes.length
        ? `• Размеры: ${escapeHtml(p.sku.sizes.join(", "))}`
        : p.sku.ambiguousParams.length
          ? `• Параметры: ${escapeHtml(p.sku.ambiguousParams.join(" / "))} — значение нужно уточнить`
          : null,
    `• Материал: ${escapeHtml(p.identity.materials.join(", "))}${/подтверд/i.test(p.identity.materials.join(" ")) ? "" : " — подтвердить"}`,
    `• Вес: ${weight ? `${String(weight).replace(".", ",")} кг — подтвердить, нужен вес с упаковкой` : "не указан"}`,
    "",
    "<b>🟡 Статус: нужны данные поставщика</b>",
    "",
    "⚠️ <b>Что уточнить</b>",
    ...p.procurement.mustAskSupplier
      .slice(0, 5)
      .map((q) => `• ${escapeHtml(q)}`),
    "",
    "💸 <b>Предварительная себестоимость</b>",
    `• Закупка: ${priceYuan ? `${cny(priceYuan)} ≈ ${rub(purchaseRub)}` : "нужно уточнить"}`,
    `• Без карго: ${costWithoutCargo ? `~${rub(costWithoutCargo)}` : "нужно уточнить"}`,
    "• Карго: нужен вес с упаковкой",
    (() => {
      const line = volumetricWeightLine(
        p.logistics?.dimensionsCm ?? null,
        p.logistics?.volumetricWeightKg ?? null,
        "• ",
        typeof weight === "number" ? weight : null,
      );
      return line ? escapeHtml(line) : null;
    })(),
    "",
    "📁 <b>Закупочный пакет готов</b>",
    "• вопросы поставщику",
    "• ТЗ байеру",
    "• ТЗ карго",
    "• чек-лист образца",
    "• SEO-черновик",
    "• фото товара",
    "",
    "🎯 <b>Вывод</b>",
    escapeHtml(p.procurement.verdict),
    "",
    "<b>Что сделать:</b>",
    "1. Нажмите «💬 Вопросы поставщику».",
    "2. Отправьте текст поставщику в чат 1688.",
    "3. Скачайте закупочный пакет.",
  ];
  return joinReportLines(lines);
}

/**
 * Join report lines keeping intentional blank-line section separators, while
 * dropping content lines that resolved to empty (optional bullets that were
 * filtered out). Collapses any run of blanks to a single blank line so we never
 * glue sections together and never stack multiple blank lines.
 */
function joinReportLines(lines: Array<string | null>): string {
  const out: string[] = [];
  for (const raw of lines) {
    if (raw === null) continue; // omitted optional bullet — not a separator
    const isBlank = raw === "";
    if (isBlank) {
      if (out.length === 0 || out[out.length - 1] === "") continue;
      out.push("");
      continue;
    }
    out.push(raw);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

function escapeHtml(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function validateProfile(profile: ProductProcurementProfile): {
  ok: boolean;
  errors: string[];
  fixedProfile: ProductProcurementProfile;
} {
  const errors: string[] = [];
  if (!profile.identity.titleForReport) errors.push("titleForReport empty");
  if (!profile.identity.productKind) errors.push("productKind empty");
  if (!profile.procurement.mustAskSupplier.length)
    errors.push("mustAskSupplier empty");
  if (!profile.procurement.mustCheckOnSample.length)
    errors.push("mustCheckOnSample empty");
  const ruFields = JSON.stringify([
    profile.identity,
    profile.procurement,
    profile.cargo,
    profile.content,
  ]);
  if (/[一-鿿]/.test(ruFields)) errors.push("raw Chinese in RU fields");
  if (dangerousClaims(profile.identity.titleForSeo).length)
    errors.push("dangerous claim in titleForSeo");
  return { ok: errors.length === 0, errors, fixedProfile: profile };
}

export function validateMainReport(text: string): {
  ok: boolean;
  errors: string[];
  fixedText: string;
} {
  const errors: string[] = [];
  let fixed = sanitizeUserFacingText(fixMixedRuTypos(text));
  if (/Product Intelligence|AI-черновик|debug/i.test(fixed))
    errors.push("internal text");
  if (
    /из\s+карточки\s+1688|cross[\s-]?border|для\s*cross[\s-]?border|тип товара:\s*home|аудитория:|пол:|сезон:/i.test(
      fixed,
    )
  )
    errors.push("raw attribute pollution");
  if (/[一-鿿]/.test(fixed)) errors.push("raw Chinese");
  if (/0(?:[,.]0+)?\s*[₽¥￥]/.test(fixed)) errors.push("zero money");
  if (/\b(?:seller|factory|merchant)\b/i.test(fixed))
    errors.push("english supplier type");
  if (/ориентир\s+0[,.]\d+\s*кг|category default/i.test(fixed))
    errors.push("category default weight");
  fixed = fixed
    .replace(/\bseller\b/gi, "продавец")
    .replace(/\bmerchant\b/gi, "проверенный продавец")
    .replace(/\bfactory\b/gi, "фабрика");
  fixed = fixed
    .split("\n")
    .filter(
      (line) =>
        !/из\s+карточки\s+1688|cross[\s-]?border|для\s*cross[\s-]?border|тип товара:\s*home|аудитория:|пол:|сезон:/i.test(
          line,
        ),
    )
    .join("\n");
  fixed = sanitizeUserFacingText(fixed.replace(/0(?:[,.]0+)?\s*[₽¥￥]/g, "нужно уточнить"));
  return { ok: errors.length === 0, errors, fixedText: fixed };
}

export function validateCnQuestions(
  ru: string[],
  cn: string[],
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!cn.length) errors.push("CN empty");
  if (cn.length !== ru.length) errors.push("CN count differs");
  if (cn.length > 10) errors.push("too many CN questions");
  const joined = cn.join("\n");
  if (/[А-Яа-яЁё]/.test(joined)) errors.push("Cyrillic in CN");
  if (/file:\/\//i.test(joined)) errors.push("file url");
  if (
    /\b(?:material|размерная сетка|вес|габарит|цвет|поставщик)\b/i.test(joined)
  )
    errors.push("language mix");
  if (/\d+,\d+\s*元/.test(joined)) errors.push("comma decimal");
  if (/\d+[.)]\s*\d+[.)]/.test(joined)) errors.push("nested numbering");
  if (/该问题中的相关产品信息/.test(joined)) errors.push("meta CN");
  if (/接水盘|支架|挂钩|层架|伞骨/.test(joined))
    errors.push("wrong-product accessory term");
  return { ok: errors.length === 0, errors };
}

// Deterministic CN is used ONLY as a faithful literal translation of the truly
// generic supplier lines (price/weight/dimensions/material/photos/MOQ/sample).
// It NEVER synthesizes product-specific accessory terms (接水盘/支架/挂钩/层架/伞骨)
// or meta-garbage (该问题中的相关产品信息). Anything it cannot translate faithfully
// returns "" so the caller can fall back to RU-only.
function translateQuestionToCn(q: string): string {
  const lower = q.toLowerCase();
  const price = q.match(/(\d+(?:[,.]\d+)?)\s*¥/)?.[1]?.replace(",", ".");
  if (/цен/.test(lower))
    return `请确认所选SKU的价格${price ? `：${price} 元` : ""}。`;
  if (/вес/.test(lower)) return "请提供所选SKU单件含独立包装的重量。";
  if (/габарит|размер.*упаков/.test(lower)) return "请提供单件独立包装尺寸。";
  if (/материал/.test(lower)) return "请确认产品的主要材质和表面涂层/处理。";
  if (/комплектац/.test(lower))
    return "请确认所选SKU的配置：包装盒/袋内包含哪些内容。";
  if (/реальн.*фото|фото.*комплектац|фото.*упаков|пришлите.*фото/.test(lower))
    return "请发送所选SKU、配置和包装的实拍照片。";
  if (/moq|минимальн|срок отгрузки/.test(lower))
    return "请确认所选SKU的最小起订量和发货时间。";
  if (/образец/.test(lower)) return "下单前是否可以先购买1-2件样品？";
  return "";
}

export function buildSupplierQuestionsFromProfile(
  product: any,
  opts: { sourceUrl?: string } = {},
): SupplierQuestionsProfileResult {
  const profile = ensureProductProcurementProfile(product, opts);
  // Prefer the EXACT RU list the CN translation ran on (persisted upstream), so the
  // rendered RU and CN are always a matched pair of equal length. Re-deriving here
  // can differ by a question and silently drop the whole CN version.
  const pairedRu =
    profile.supplierQuestionsCnValid &&
    Array.isArray((product as any)?.supplierQuestionsRu) &&
    (product as any).supplierQuestionsRu.length
      ? ((product as any).supplierQuestionsRu as string[]).slice(0, 10)
      : null;
  const ru = pairedRu ?? uniq(profile.procurement.mustAskSupplier, 10).slice(0, 10);
  const savedCn =
    profile.supplierQuestionsCnValid &&
    Array.isArray(profile.supplierQuestionsCn)
      ? profile.supplierQuestionsCn
      : [];
  // Prefer LLM CN saved upstream. Only fall back to deterministic CN if every
  // line translates faithfully (no empties); otherwise emit RU-only rather than
  // wrong-product/meta CN.
  let cn: string[];
  if (savedCn.length === ru.length) {
    cn = savedCn;
  } else {
    const det = ru.map(translateQuestionToCn);
    cn = det.every((s) => s.trim().length > 0) ? det : [];
  }
  const cnCheck = validateCnQuestions(ru, cn);
  const label = cnCheck.ok
    ? "💬 Вопросы поставщику RU/CN"
    : "💬 Вопросы поставщику RU";
  const lines = [
    "# Вопросы поставщику",
    "",
    "## Русская версия",
    "",
    "Здравствуйте. Хотим уточнить товар перед заказом:",
    "",
    ...ru.map((q, i) => `${i + 1}. ${q}`),
    "",
  ];
  if (cnCheck.ok)
    lines.push(
      "## Китайская версия",
      "",
      "您好。下单前想确认以下产品信息：",
      "",
      ...cn.map((q, i) => `${i + 1}. ${q}`),
    );
  else
    lines.push(
      "## Китайская версия",
      "",
      "Китайская версия не сформирована. Используйте русскую версию или переведите через байера.",
    );
  return {
    ru,
    cn: cnCheck.ok ? cn : [],
    cnValid: cnCheck.ok,
    text: lines.join("\n"),
    label,
    errors: cnCheck.errors,
  };
}

export function formatSupplierQuestionsText(
  ru: string[],
  cn: string[],
): SupplierQuestionsProfileResult {
  const cleanRu = uniq(ru, 10).slice(0, 10);
  const cnCheck = validateCnQuestions(cleanRu, cn);
  const lines = [
    "# Вопросы поставщику",
    "",
    "## Русская версия",
    "",
    "Здравствуйте. Хотим уточнить товар перед заказом:",
    "",
    ...cleanRu.map((q, i) => `${i + 1}. ${q}`),
    "",
  ];
  if (cnCheck.ok)
    lines.push(
      "## Китайская версия",
      "",
      "您好。下单前想确认以下产品信息：",
      "",
      ...cn.map((q, i) => `${i + 1}. ${q}`),
    );
  else
    lines.push(
      "## Китайская версия",
      "",
      "Китайская версия не сформирована. Используйте русскую версию или переведите через байера.",
    );
  return {
    ru: cleanRu,
    cn: cnCheck.ok ? cn : [],
    cnValid: cnCheck.ok,
    text: lines.join("\n"),
    label: cnCheck.ok
      ? "💬 Вопросы поставщику RU/CN"
      : "💬 Вопросы поставщику RU",
    errors: cnCheck.errors,
  };
}

export async function translateSupplierQuestionsRuToCn(
  ru: string[],
): Promise<string[]> {
  const cleanRu = uniq(ru, 10).slice(0, 10);
  // Deterministic fallback only if it fully covers every line; otherwise RU-only.
  const det = cleanRu.map(translateQuestionToCn);
  const fallback: string[] = det.every((s) => s.trim().length > 0) ? det : [];
  const g: any = globalThis as any;
  const apiKey = g.process?.env?.OPENROUTER_API_KEY;
  if (!apiKey || typeof g.fetch !== "function" || !g.AbortSignal)
    return fallback;

  try {
    const res = await g.fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model:
          g.process?.env?.CARDZIP_CN_TRANSLATOR_MODEL ||
          "google/gemini-2.5-flash",
        max_tokens: 1200,
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              'Ты переводчик закупочных вопросов RU→CN для 1688. Верни строго JSON: {"questionsCn":[""]}. Не добавляй и не удаляй вопросы. Не используй русский. Десятичные числа пиши через точку: 12.5 元.',
          },
          { role: "user", content: JSON.stringify({ questionsRu: cleanRu }) },
        ],
      }),
      signal: g.AbortSignal.timeout(15_000),
    });
    if (!res.ok) return fallback;
    const data = (await res.json()) as any;
    const raw = String(data.choices?.[0]?.message?.content ?? "")
      .replace(/```json\s*/i, "")
      .replace(/```/g, "")
      .trim();
    const parsed = JSON.parse(raw);
    const cn = Array.isArray(parsed?.questionsCn)
      ? parsed.questionsCn.map(String)
      : [];
    return validateCnQuestions(cleanRu, cn).ok ? cn : fallback;
  } catch {
    return fallback;
  }
}

export function validateSupplierQuestions(text: string): {
  ok: boolean;
  errors: string[];
  fixedText: string;
} {
  const errors: string[] = [];
  if (/file:\/\//i.test(text)) errors.push("file url");
  const ruLines = text
    .split("\n")
    .filter((l) => /^\d+[.)]\s/.test(l) && /[А-Яа-яЁё]/.test(l));
  if (
    uniq(ruLines.map((l) => l.replace(/^\d+[.)]\s*/, ""))).length !==
    ruLines.length
  )
    errors.push("duplicates");
  if (ruLines.length > 10) errors.push("too many questions");
  return { ok: errors.length === 0, errors, fixedText: text };
}

function list(items: string[], limit = 12): string[] {
  return uniq(items, limit).map((v) => `- ${v}`);
}

export function buildBuyerBriefFromProfile(
  product: any,
  opts: { sourceUrl?: string } = {},
): string {
  const p = ensureProductProcurementProfile(product, opts);
  const weightKg = extractWeightKg(product);
  const pkgDims = extractDimensionsCm(product);
  // Slot-based "must confirm" checklist (short labels), NOT a copy of the full
  // supplier-questions list — the buyer brief used to re-dump the same questions
  // as 01_Вопросы_поставщику.txt. Full wording stays in that file; here we show a
  // compact gap checklist so the two documents don't duplicate each other.
  const mustConfirm = evaluateGapSlots(gapContextFromProfile(p, product))
    .filter((s) => s.state === "must_confirm" && s.label)
    .map((s) => s.label);
  return [
    "# ТЗ байеру",
    "",
    "## 1. Товар (данные из карточки — заявлено, проверить)",
    `Название: ${p.identity.titleForReport}`,
    `Ссылка: ${opts.sourceUrl ?? product?.sourceUrl ?? "—"}`,
    `Цена: ${formatPriceForDisplay(p.pricing)}`,
    `SKU: ${p.sku.selectedSkuText ?? "не определён"}`,
    `SKU в карточке: ${p.sku.skuSummary}`,
    `Цвета: ${p.sku.colors.length ? p.sku.colors.join(", ") : "уточнить"}`,
    `Материал: ${p.identity.materials.length ? p.identity.materials.join(", ") : "не указан"}`,
    `Вес: ${weightKg != null ? `${String(weightKg).replace(".", ",")} кг (заявлено, уточнить с упаковкой)` : "нет в карточке"}`,
    `Габариты упаковки: ${pkgDims ? `${pkgDims} см (предварительно)` : "нет в карточке"}`,
    `MOQ: ${pos(product?.moq) ? `${Math.round(pos(product?.moq)!)} шт.` : "уточнить"}`,
    "",
    "## 2. Поставщик",
    `Название: ${p.supplier.name || "не указано"}`,
    `Тип: ${p.supplier.displayType}`,
    `Рейтинг: ${p.supplier.rating || "—"}`,
    `Заказы: ${p.supplier.orders || "—"}`,
    "",
    "## 3. Что подтвердить у поставщика (ключевое)",
    ...list(
      [
        ...(p.procurement.leadQuestions ?? []),
        // The cross-cutting critical block (electrical/compliance for a powered
        // device, …) so the buyer brief carries the same domain spine as the other
        // docs instead of only the generic gap slots.
        ...(p.procurement.criticalConfirmations ?? []),
        ...mustConfirm,
      ],
      12,
    ),
    "Полные формулировки вопросов — в файле 01_Вопросы_поставщику.txt.",
    "",
    "## 4. Что проверить на образце",
    ...list(dedupBulletsByOverlap(p.procurement.mustCheckOnSample), 10),
    "",
    "## 5. Фото, которые нужно запросить",
    "- общий вид выбранного SKU",
    "- крупно материал и важные детали",
    "- упаковка и маркировка",
    "- комплектация в одном кадре",
    "- фото рядом с линейкой, если размер важен",
    "",
    "## 6. Риски",
    ...list(dedupBulletsByOverlap(p.procurement.redFlags), 10),
    "",
    "## 7. Решение",
    p.procurement.verdict,
  ].join("\n");
}

export function buildCargoBriefFromProfile(
  product: any,
  opts: { sourceUrl?: string } = {},
): string {
  // Prefer the LLM-polished document when the writer produced a validated one
  // (stashed on the product during the pipeline). Falls through to the
  // deterministic template otherwise.
  const polished = product?.polishedDocs?.cargo;
  if (typeof polished === "string" && polished.trim().length > 200)
    return sanitizeUserFacingText(polished.trim());
  const p = ensureProductProcurementProfile(product, opts);
  const weight = p.logistics?.weightKg ?? extractWeightKg(product);
  const dims = p.logistics?.dimensionsCm ?? null;
  const volLine = volumetricWeightLine(
    dims,
    p.logistics?.volumetricWeightKg ?? null,
    "",
    typeof weight === "number" ? weight : null,
  );
  return [
    "# ТЗ карго",
    "",
    "## Товар",
    `Название: ${p.identity.titleForReport}`,
    `Ссылка: ${opts.sourceUrl ?? product?.sourceUrl ?? "—"}`,
    `SKU: ${p.sku.selectedSkuText ?? "не определён"}`,
    `Цена: ${formatPriceForDisplay(p.pricing)}`,
    "",
    "## Что нужно запросить для доставки",
    // Product-specific requests (LLM) first, then the base logistics questions.
    ...list(uniq([...(p.cargo.whatToRequest ?? []), ...p.cargo.mustAsk], 18), 18),
    "",
    ...(volLine ? ["## Объёмный вес (предварительно)", volLine, ""] : []),
    "## Дополнительно по этому товару",
    ...cargoAdditionalLines(p),
    "",
    "## Текущий статус",
    `Вес: ${weight ? `${String(weight).replace(".", ",")} кг — подтвердить, нужен вес с упаковкой` : "не указан"}`,
    `Габариты: ${dims ? `${dims} см (предварительно, подтвердить у поставщика)` : "не указаны"}`,
    `SKU: ${p.sku.selectedSkuText ?? "не определён"}`,
    "",
    "## Важно",
    "Карго не рассчитывается точно без веса и габаритов выбранного SKU.",
  ].join("\n");
}

// Per-cargo-nature standard cautions, added when the LLM reports a known nature.
const CARGO_NATURE_CAUTIONS: Record<string, string> = {
  inflatable:
    "надувной товар — уточните, перевозится ли в сдутом виде; проверьте клапан и упаковку от проколов",
  battery:
    "аккумулятор/батарея — уточните правила перевозки и маркировку опасного груза",
  liquid: "жидкость — возможны ограничения по перевозке, уточните у карго",
  aerosol: "аэрозоль — возможны ограничения по перевозке, уточните у карго",
  fragile: "хрупкий товар — уточните защитную упаковку и допустимую нагрузку",
  oversized:
    "негабаритный товар — уточните габариты упаковки и тариф по объёмному весу",
  powder: "порошок/сыпучее — возможны ограничения, уточните у карго",
  bladed:
    "острый режущий предмет: уточните у карго требования к упаковке лезвия (чехол/блистер/жёсткая коробка) и ограничения/таможенные требования на перевозку ножей; лезвие должно быть защищено от повреждения упаковки и травм при вскрытии",
  sharp:
    "острый режущий предмет: уточните у карго требования к упаковке лезвия (чехол/блистер/жёсткая коробка) и ограничения/таможенные требования на перевозку ножей; лезвие должно быть защищено от повреждения упаковки и травм при вскрытии",
  powered:
    "электротовар — уточните у карго требования к перевозке техники, маркировку и совместимость с РФ/ЕАЭС по питанию",
};

/**
 * Derive a cargo nature from the product kind when the LLM did not supply one.
 * Keeps the per-nature cautions firing for kinds that clearly imply a nature
 * (a knife is always a bladed/sharp item) instead of falling to generic filler.
 */
function cargoAdditionalLines(p: ProductProcurementProfile): string[] {
  // cargoNature is LLM-driven (dynamic per product); the caution dictionary fires
  // on whatever nature the LLM classified. No category-derived guessing here — when
  // the LLM gave nothing, the floor honestly defers to the freight forwarder.
  const nature = (p.cargo.cargoNature ?? "").toLowerCase().trim();
  const items: string[] = [
    ...p.cargo.likelySensitiveCargoIssues,
    ...(p.cargo.packagingNotes ? [p.cargo.packagingNotes] : []),
  ];
  for (const [key, caution] of Object.entries(CARGO_NATURE_CAUTIONS)) {
    if (nature.includes(key)) items.push(caution);
  }
  const deduped = uniq(items, 10);
  if (deduped.length) return list(deduped, 10);
  // Only show the generic filler when truly nothing is known and nature is absent.
  if (!nature || nature === "none") {
    return [
      "- специальных ограничений не найдено, но ограничения по перевозке нужно подтвердить у карго",
    ];
  }
  return ["- уточните ограничения по перевозке этого товара у карго"];
}

export function buildSampleChecklistFromProfile(
  product: any,
  opts: { sourceUrl?: string } = {},
): string {
  const polished = product?.polishedDocs?.checklist;
  if (typeof polished === "string" && polished.trim().length > 200)
    return sanitizeUserFacingText(polished.trim());
  const p = ensureProductProcurementProfile(product, opts);
  const measure = uniq(
    [
      "вес с упаковкой",
      "габариты индивидуальной упаковки",
      ...p.cargo.mustAsk.filter((v) =>
        /длина|диаметр|размер|объ[её]м|вес|габарит/i.test(v),
      ),
    ],
    8,
  );
  return [
    "# Чек-лист образца",
    "",
    "## До заказа образца",
    ...list(p.procurement.mustCheckBeforeSample, 8),
    "",
    "## Какой SKU взять",
    `- ${p.sku.selectedSkuText ?? "самый массовый/целевой SKU после подтверждения у поставщика"}`,
    "- Количество: 1–2 единицы, не партия",
    "",
    "## Что проверить на образце",
    ...list(p.procurement.mustCheckOnSample, 12),
    "",
    "## Что измерить",
    ...list(measure, 8),
    "",
    "## Какие фото сделать",
    "- общий вид выбранного SKU",
    "- товар крупно с разных сторон",
    "- важные детали/механизм/материал",
    "- комплектация",
    "- индивидуальная упаковка и маркировка",
    "",
    "## Красные флаги",
    ...list(dedupBulletsByOverlap(p.procurement.redFlags), 10),
    "",
    "## Решение после образца",
    "- брать в тестовую партию",
    "- доработать SKU/упаковку/контент",
    "- не брать",
  ].join("\n");
}

// Vague, non-informative characteristic values that add nothing to a WB card
// ("Стиль: новый китайский", "классический дизайн"). Category-agnostic: these are
// marketing/style descriptors, not buyer-useful specs.
const VAGUE_CHAR_VALUE_RE =
  /^(?:нов(?:ый|ое)\s+китайск|классическ|современн|модн|стильн|трендов|универсальн|обычн|стандартн)/i;

// Restore a steel/alloy grade that the LLM truncated ("Cr13" → "3Cr13") using the
// full grade found in the product materials. Generic for N-prefixed alloy codes.
function restoreAlloyGrade(value: string, p: ProductProcurementProfile): string {
  const m = value.match(/(?<![0-9A-Za-z])(Cr\d{2,3}[A-Za-z]?)/i);
  if (!m) return value;
  const full = p.identity.materials
    .join(" ")
    .match(/(\d(?:Cr\d{2,3}[A-Za-z]?))/i);
  if (full && full[1].toLowerCase().endsWith(m[1].toLowerCase())) {
    return value.replace(m[1], full[1]);
  }
  return value;
}

export function sanitizeSeoChars(
  raw: Array<{ name?: unknown; value?: unknown; status?: unknown }>,
  p: ProductProcurementProfile,
): Array<{ name: string; value: string; status: string }> {
  const seen = new Set<string>();
  const out: Array<{ name: string; value: string; status: string }> = [];
  for (const c of raw) {
    let value = fixGluedFallback(clean(c.value));
    let status = clean(c.status) || "подтвердить у поставщика";
    const name = clean(c.name);
    if (!name) continue;
    // GLOBAL PRINCIPLE: 1688 card data is a SELLER CLAIM, not a verified fact.
    // A value taken "из карточки" must read as declared/unconfirmed — otherwise
    // the card asserts (e.g.) a steel grade as fact while the questions file
    // simultaneously asks the supplier to confirm it.
    if (/из\s*карточк/i.test(status)) status = "заявлено, уточнить";
    // Drop vague style/marketing rows entirely — they are card noise.
    if (VAGUE_CHAR_VALUE_RE.test(value)) continue;
    const hasDigit = /\d/.test(value);
    if (
      !value ||
      value.length < 2 ||
      /^(?:см|мм|м|кг|г|мл|л|вт|в|°|шт|hrc)\.?$/i.test(value) ||
      /^(?:более|около|примерно|приблизительно|порядка|~|до|от)\s*\d/i.test(value) ||
      (/[°]|\b(?:см|мм|кг|мл|hrc)\b/i.test(value) && !hasDigit)
    ) {
      value = "уточнить";
      status = "подтвердить";
    } else {
      // Restore truncated alloy grade (Cr13 → 3Cr13) for consistency with the
      // description/material.
      value = restoreAlloyGrade(value, p);
    }
    // A "Цвет" whose value is a long marketing phrase / bracketed SKU title is
    // not a colour — the LLM mapped a variant title into the colour slot.
    const looksLikeTitle =
      /[\[\]]/.test(value) || value.split(/\s+/).filter(Boolean).length > 3;
    if (/^цвет/i.test(name) && looksLikeTitle) {
      value = "уточнить";
      status = "подтвердить";
    }
    if (dangerousClaims(`${name} ${value}`).length) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, value, status });
    if (out.length >= 8) break;
  }
  return out;
}

// ─── SEO honesty projection ─────────────────────────────────────────────────
// Architectural guarantee: SEO copy is a PROJECTION of the profile, never a
// re-guess of the product. The LLM supplies LANGUAGE; these deterministic guards
// enforce the profile's authority over FACTS. They are data-driven — keyed on the
// profile's own material set and claimed-feature list — so they stay category- and
// word-agnostic (no hardcoded product terms). Cyrillic-safe (no \b, no \w).

// A hedge marker already frames a claim as declared → don't double-hedge.
const HEDGE_MARKER_RE = /заявл|по заявлению|со слов|указан|производитель|продавец/i;

// 5-char stems of significant words, for fuzzy matching a profile feature phrase
// against a copy segment despite inflection. ё→е is normalized FIRST: JS treats
// them as distinct chars, so without this "бесщеточный" (е) would never match a
// claimed "бесщёточный" (ё) and the claim would leak unhedged.
function featureStemSet(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/ё/g, "е")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4)
      .map((w) => w.slice(0, 5)),
  );
}

// A segment "asserts" a claimed feature when it shares a stem with the feature and
// carries no hedge marker. Threshold is deliberately lenient: for short features
// (1–2 significant words) a single shared stem is enough, because synonyms and
// inflection ("бесщёточный МОТОР" vs "бесщёточный ДВИГАТЕЛЬ") break strict overlap
// — and OVER-hedging (adding a harmless "(заявлено)") is far safer than letting an
// unconfirmed claim through as fact. Longer feature phrases still need 60% overlap
// so one common stem doesn't hedge every sentence.
function segmentAssertsFeature(segment: string, featureStems: Set<string>): boolean {
  if (featureStems.size === 0 || HEDGE_MARKER_RE.test(segment)) return false;
  const seg = featureStemSet(segment);
  let inter = 0;
  for (const t of featureStems) if (seg.has(t)) inter += 1;
  if (inter === 0) return false;
  return featureStems.size <= 2 || inter / featureStems.size >= 0.6;
}

// The profile's confirmed materials, cleaned of the stored confirm-suffix
// ("— подтвердить") so the copy doesn't double-hedge (we add "заявленный" ourselves).
function profileMaterials(p: ProductProcurementProfile): string[] {
  return p.identity.materials
    .map((m) =>
      clean(m)
        .replace(/\s*[—–-]\s*подтверд[а-яё]*\.?$/i, "")
        .trim(),
    )
    .filter((m) => m && !/^уточнить/i.test(m));
}

// Structural cue that a segment states material COMPOSITION (not product-specific
// words — "материал/состав/выполнен из/корпус из" are honesty-framework vocabulary).
const MATERIAL_SENTENCE_RE =
  /матери[аи]л|состав\b|выполнен[а-яё]*\s+из|корпус[а-яё]*\s+(?:из|выполнен)|изготовлен[а-яё]*\s+из|сделан[а-яё]*\s+из/i;

// Replace any material-composition segment with the profile's canonical materials,
// so a material the LLM invented or pulled from a raw attribute (e.g. "нейлон PA")
// cannot appear — the profile's normalized material set is the single authority.
function reconcileMaterialToProfile(
  text: string,
  p: ProductProcurementProfile,
): string {
  const mats = profileMaterials(p);
  if (!mats.length || !text) return text;
  const canonical = mats.join(", ");
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => (MATERIAL_SENTENCE_RE.test(s) ? `Заявленный материал — ${canonical}.` : s))
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Append a light "(заявлено)" to a unit that states a seller-CLAIMED feature as
// fact, so the copy matches the "заявлено, уточнить" status the characteristics
// table already carries. Skips units already hedged or reconciled to material.
function hedgeUnitIfClaimed(unit: string, featureStems: Set<string>[]): string {
  if (!unit || HEDGE_MARKER_RE.test(unit)) return unit;
  if (!featureStems.some((fs) => segmentAssertsFeature(unit, fs))) return unit;
  return `${unit.replace(/[.\s]+$/, "")} (заявлено).`;
}

// Packaging / gift-set vocabulary (structural, not category-specific): the case,
// pouch or gift box a listing may include. When the exact variant is unconfirmed,
// these can't be sold as a guaranteed inclusion — the buyer might receive only the
// box, or a different set.
const PACKAGING_RE =
  /кейс[а-яё]*|футляр[а-яё]*|чехл[а-яё]*|чехол|подарочн[а-яё]*|комплектн[а-яё]*|в\s+подарок|готов[а-яё]*\s+подар/i;

// Effect / safety claims about the user or their health ("бережно относится к
// волосам", "предотвращает повреждение", "безопасен для кожи"). These need tests
// to state and must never appear in a 1688 draft. Structural (about the person),
// not category-specific product terms.
const SAFETY_CLAIM_RE =
  /бережн[а-яё]*|защища[а-яё]*\s+(?:волос|кож|здоров|организм|от\s+поврежд)|предотвраща[а-яё]*\s+(?:поврежд|ломк|сечени|выпаден|вред)|безопасн[а-яё]*\s+для\s+(?:волос|кож|здоров|детей|организм)|не\s+вред[а-яё]*|защит[а-яё]*\s+волос/i;

// Deterministic, structured SEO title: assembled ONLY from the closed set of
// confirmed identity facts (object + use-cases). Claimed features, packaging and
// numbers are never in that set, so by construction they cannot appear in the
// title. Keyword-dense and honest.
// Strip seller-claimed feature WORDS from a noun (ё/е-tolerant), so a noisy object
// like "Высокоскоростной фен с ионизацией" loses the unconfirmed feature. Operates
// WORD-BY-WORD, never on substrings: a previous version matched a feature stem
// inside a word ("скорос" inside "Высокоскоростной") and truncated it → the broken
// title "Высоко фен". Dropping only whole words makes an orphan fragment impossible.
function stripClaimedFeaturePhrases(
  text: string,
  claimedFeatures: string[],
): string {
  const norm = (w: string) =>
    w.toLowerCase().replace(/ё/g, "е").replace(/[^а-яёa-z0-9]/gi, "");
  const stems = new Set<string>();
  for (const f of claimedFeatures) {
    for (const w of clean(f).split(/\s+/)) {
      const n = norm(w);
      if (n.length >= 5) stems.add(n.slice(0, 6));
    }
  }
  if (!stems.size) return clean(text);
  const kept = clean(text)
    .split(/\s+/)
    .filter((w) => {
      const n = norm(w);
      // Keep short words (connectors, the object noun); drop a word only when it is
      // itself a claimed-feature word (shares the feature's whole 6-char stem).
      if (n.length < 5) return true;
      return ![...stems].some((s) => n.startsWith(s));
    })
    .join(" ")
    // A leftover trailing connector ("… фен с") after dropping a feature word.
    .replace(/\s+(?:с|со|и|для|,|—)\s*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return kept;
}

export function buildStructuredTitle(
  coreObject: string,
  useCases: string[],
  claimedFeatures: string[] = [],
): string {
  // "X с Y" in a product noun almost always introduces a feature ("фен с
  // ионизацией") — cut at the first " с/со " so the object is just the noun. Then
  // strip any remaining claimed-feature phrase as a backup. ("для волос" is part of
  // the noun, so we never cut there.)
  const nounOnly = clean(coreObject).split(/\s+(?:с|со)\s+/i)[0];
  const obj =
    capitalizeRu(stripClaimedFeaturePhrases(nounOnly, claimedFeatures)) ||
    "Товар";
  const objWords = new Set(
    obj.toLowerCase().replace(/ё/g, "е").split(/[^а-яёa-z0-9]+/i).filter(Boolean),
  );
  const uses = uniq(
    useCases
      // Drop use-cases that smuggle packaging / gift-set / safety claims or an
      // unconfirmed measurement into the title — same firewall as the copy. This is
      // why "подарочный комплект для ухода за волосами" no longer reaches the title.
      .filter(
        (u) =>
          !PACKAGING_RE.test(u) &&
          !SAFETY_CLAIM_RE.test(u) &&
          !BULLET_MEASUREMENT_RE.test(u),
      )
      .map((u) =>
        clean(u)
          // Keep only the first clause of a verbose use-case — a title must stay
          // tight. "использование дома, в салоне или в поездках" → "использование
          // дома" (also sheds the venue speculation that follows the comma).
          .split(/[,;–—]|\s+(?:или|и)\s+/i)[0]
          .replace(/^для\s+/i, "")
          // drop words already present in the object (avoids "фен для волос — сушка волос")
          .split(/\s+/)
          .filter((w) => !objWords.has(w.toLowerCase().replace(/ё/g, "е")))
          .join(" ")
          .trim(),
      )
      .filter((u) => u && !/уточнит/i.test(u)),
    // Cap at 2: more than that turns the title into a run-on summary dump.
    2,
  );
  return uses.length ? `${obj} — ${uses.join(", ")}` : obj;
}

// Strip an unconfirmed packaging clause from a title (e.g. "в подарочном кейсе").
export function stripUnconfirmedPackaging(title: string): string {
  return title
    // "в подарочном кейсе" / "с подарочным футляром" / "подарочный набор" — consume
    // the leading preposition too (no trailing \b: it's ASCII-only and fails on
    // Cyrillic, which previously left a dangling "в").
    .replace(
      /\s*(?:в|с|—|,)?\s*подарочн[а-яё]*\s+(?:кейс[а-яё]*|футляр[а-яё]*|чехл[а-яё]*|набор[а-яё]*|бокс[а-яё]*|упаковк[а-яё]*)(?![а-яё])/gi,
      " ",
    )
    // "в кейсе" / "с футляром" without "подарочный".
    .replace(
      /\s*(?:в|с)\s+(?:кейс[а-яё]*|футляр[а-яё]*|чехл[а-яё]*|чехол)(?![а-яё])/gi,
      " ",
    )
    .replace(/\s{2,}/g, " ")
    .replace(/\s+,/g, ",")
    .replace(/[\s,]+$/g, "")
    .trim();
}

// The significant words of the profile's claimed + unconfirmed features, normalized
// (lowercase, ё→е, punctuation-stripped). The single authority for "is this text
// asserting an unconfirmed feature?" across keywords and infographic ideas.
function claimedFeatureWords(p: ProductProcurementProfile): string[] {
  return uniq(
    [...p.identity.claimedFeatures, ...p.identity.unconfirmedFeatures]
      .flatMap((f) => clean(f).toLowerCase().replace(/ё/g, "е").split(/\s+/))
      .map((w) => w.replace(/[^а-яёa-z0-9]/gi, ""))
      .filter((w) => w.length >= 4),
    60,
  );
}

// True if any word of `text` shares a 4-char prefix with a claimed-feature word —
// e.g. keyword "фен с ионизацией" vs claimed "ионизация". Deliberately loose (a
// keyword is a speculative search tag, not prose; over-dropping an unconfirmed
// feature tag when the SKU is unknown is exactly what we want). ё/е-normalized so
// spelling variants match; prefix-based so "мощный"/"мощность" align where fixed
// stems ("мощны" vs "мощно") missed.
export function assertsClaimedFeatureWord(text: string, featureWords: string[]): boolean {
  if (!featureWords.length) return false;
  const words = text
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^а-яёa-z0-9]+/i)
    .filter((w) => w.length >= 4);
  const shares = (a: string, b: string) => {
    let i = 0;
    const n = Math.min(a.length, b.length);
    while (i < n && a[i] === b[i]) i += 1;
    // 4-char shared prefix, OR a 3-char prefix when the shorter word is itself short
    // (Russian roots like "ион" are only 3 chars: "ионами"↔"ионизация" share "ион",
    // and a fixed 4-char rule — "иона" vs "иони" — missed them).
    return i >= 4 || (i >= 3 && n <= 5);
  };
  return words.some((w) => featureWords.some((fw) => shares(w, fw)));
}

/**
 * Projects the profile's fact confidence onto the SEO prose: contains materials to
 * the profile's set, hedges seller-claimed features, and — when the variant is
 * unconfirmed — drops bullets that sell the packaging/gift-set as a guaranteed
 * inclusion. Deterministic and offline-testable; guarantees honesty regardless of
 * what the LLM produced.
 */
export function groundSeoToProfile(
  p: ProductProcurementProfile,
  description: string,
  bullets: string[],
): { description: string; bullets: string[] } {
  const claimed = uniq(
    [...p.identity.claimedFeatures, ...p.identity.unconfirmedFeatures]
      .map((f) => clean(f))
      .filter((f) => f.length >= 4),
    30,
  );
  const featureStems = claimed
    .map(featureStemSet)
    .filter((s) => s.size >= 1);
  // Uniform firewall applied to EVERY description sentence and EVERY bullet: drop
  // effect/safety claims outright, and drop packaging/gift assertions when the
  // variant is unconfirmed. Same rule everywhere — no surface left ungoverned.
  const packagingRisky = p.sku?.selectedSkuReliable === false;
  const dropUnit = (u: string) =>
    SAFETY_CLAIM_RE.test(u) || (packagingRisky && PACKAGING_RE.test(u));
  // Hedge a unit if it asserts a seller-claimed feature OR states an unconfirmed
  // physical measurement (power/size/weight). On 1688 a bare "1450 Вт" in prose is
  // an unverified spec — mark it "(заявлено)" so it can't read as a guaranteed fact.
  const hedgeUnit = (u: string) => {
    const h = hedgeUnitIfClaimed(u, featureStems);
    if (h !== u) return h;
    if (BULLET_MEASUREMENT_RE.test(u) && !HEDGE_MARKER_RE.test(u)) {
      return `${u.replace(/[.\s]+$/, "")} (заявлено).`;
    }
    return u;
  };
  const desc = reconcileMaterialToProfile(description, p)
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !dropUnit(s))
    .map(hedgeUnit)
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();
  const bl = bullets
    .map((b) => reconcileMaterialToProfile(b, p))
    .filter((b) => !dropUnit(b))
    .map(hedgeUnit);
  return { description: desc, bullets: bl };
}

// Force the material characteristic row to the profile's materials — the LLM's row
// may carry an invented/raw-attribute material (e.g. "нейлон PA") absent from the
// normalized profile.
function enforceProfileMaterialRow(
  chars: Array<{ name: string; value: string; status: string }>,
  p: ProductProcurementProfile,
): Array<{ name: string; value: string; status: string }> {
  const mats = profileMaterials(p);
  if (!mats.length) return chars;
  const canonical = mats.join(", ");
  return chars.map((c) =>
    /^матери[аи]л/i.test(c.name)
      ? { ...c, value: canonical, status: "заявлено, уточнить" }
      : c,
  );
}

export function buildSeoDraftFromProfile(
  product: any,
  opts: { sourceUrl?: string } = {},
): string {
  const p = ensureProductProcurementProfile(product, opts);
  const prose = product?.polishedDocs?.seoProse as
    | {
        title?: string;
        description?: string;
        bullets?: string[];
        keywords?: string[];
        characteristics?: Array<{ name: string; value: string; status: string }>;
      }
    | undefined;
  // Prefer the LLM-generated SEO title when present — always through the
  // safeSeoTitle guard (strips WB/Ozon, dangerous claims, cross-border junk) —
  // else keep the deterministic identity-derived title.
  // Prefer the SEO prose writer's title (single strong source), else the AI
  // content title, else the deterministic identity title. All go through the
  // safeSeoTitle guard (strips WB/Ozon, dangerous claims, unconfirmed measurements).
  // Structured title: built deterministically from the closed identity fact set —
  // the LLM's free-form title (which asserted claimed features as fact, e.g.
  // "бесщёточный мотор") is no longer trusted for the title. safeSeoTitle still
  // sanitizes; packaging is stripped when the variant is unconfirmed.
  const structuredTitle = buildStructuredTitle(
    p.identity.coreObject,
    p.identity.useCases,
    [...p.identity.claimedFeatures, ...p.identity.unconfirmedFeatures],
  );
  const guardSeoTitle = (candidate: string): string => {
    const safe = safeSeoTitle(candidate, p.identity.productKind);
    return p.sku.selectedSkuReliable ? safe : stripUnconfirmedPackaging(safe) || safe;
  };
  const title =
    (prose?.title ? guardSeoTitle(prose.title) : "") ||
    guardSeoTitle(
      structuredTitle || safeTitle(p.identity.titleForSeo, p.identity.titleForReport),
    );
  const useCases = p.identity.useCases.length
    ? p.identity.useCases.join(", ")
    : "повседневного использования";
  const material = p.identity.materials.join(", ");

  // Bullets: prefer LLM selling points, else a customer-facing deterministic set.
  // Internal advice ("SKU в карточке: N", "проверьте образец") is NOT a selling
  // point and belongs to "Что уточнить", not here.
  const objectForBullet = p.identity.shortTitle || p.identity.coreObject || title;
  // Prefer the LLM writer's prose (description + bullets) when it produced a
  // validated one — it has stronger anti-water / anti-invented-number control
  // than the generic seoCard generator.
  const bulletSource =
    prose?.bullets?.length ? prose.bullets : p.content.seoBullets ?? [];
  const llmBullets = filterDangerousBullets(bulletSource, p);
  // Product-specific selling points come from the LLM (p.content.seoBullets).
  // When the LLM gave nothing, the deterministic floor is HONEST-GENERIC: it states
  // only what we actually know from the LLM-extracted identity (object, use cases,
  // material, colors) and openly defers the rest to the supplier — no fabricated
  // selling points, no category-specific claims.
  const materialBullet =
    material && !/уточнить/.test(material)
      ? `Материал: ${material}${/подтверд/i.test(material) ? "" : " — подтвердите у поставщика"}`
      : "Материал уточните у поставщика перед закупкой";
  // Honest customer-facing pool: only facts from the LLM-extracted identity.
  // NO internal procurement advice ("проверьте образец", "уточните у поставщика")
  // — that is not a selling point and lives in "Что уточнить".
  // Don't top up with a material bullet if the LLM bullets already cover material
  // (avoids "Материал лезвия: …" + "Материал: …" appearing as two bullets).
  const llmCoversMaterial = llmBullets.some((b) => /материал|сталь|нержавею/i.test(b));
  const honestBulletPool = uniq(
    [
      p.identity.useCases.length
        ? `${objectForBullet} — ${p.identity.useCases.slice(0, 3).join(", ")}`
        : objectForBullet,
      llmCoversMaterial ? undefined : materialBullet,
      p.sku.colors.length ? `Цвета на выбор: ${p.sku.colors.join(", ")}` : undefined,
      p.sku.normalizedExamples.length > 1 || p.sku.models.length > 1
        ? "Несколько вариантов в карточке — выберите подходящий"
        : undefined,
    ].filter((b): b is string => Boolean(b && String(b).trim())),
    6,
  );
  // 3–5 HONEST bullets, never padded with filler. Previously "exactly 5" forced
  // hollow marketing water ("Универсальный вариант для дома и в подарок") whenever
  // the product had fewer than 5 real facts. Now we ship only what we actually
  // know (LLM selling points + honest identity pool) and stop.
  const bullets = dedupBulletsByOverlap(
    uniq([...llmBullets, ...honestBulletPool], 8),
  ).slice(0, 5);
  // Prefer the writer's characteristics, else the seoCard generator's, else the
  // deterministic per-kind table. Both LLM sources go through the same sanitizer.
  const rawChars =
    (prose?.characteristics?.length ? prose.characteristics : p.content.seoCharacteristics) ??
    [];
  const llmChars = sanitizeSeoChars(rawChars, p);
  const characteristics = enforceProfileMaterialRow(
    llmChars.length ? llmChars : seoCharacteristics(p),
    p,
  );

  // Keywords: prefer LLM deduped set, else a deterministic set (dropping the giant
  // title as a keyword and de-duplicating near-identical entries).
  const rawKeywords = prose?.keywords?.length
    ? prose.keywords
    : (p.content.seoKeywords ?? []).length
    ? p.content.seoKeywords!
    : [
        // Honest floor: only LLM-extracted identity facts, no category seeding.
        p.identity.coreObject,
        p.identity.shortTitle,
        ...p.identity.useCases,
        p.identity.coreObject && p.identity.materials[0] && !/уточнить/.test(p.identity.materials[0])
          ? `${p.identity.coreObject} ${p.identity.materials[0]}`
          : "",
        ...p.sku.colors.map((c) => `${p.identity.coreObject} ${c}`),
      ].filter(Boolean);
  // Keyword firewall: same rule as the copy. When the variant is unconfirmed, a
  // search term that sells packaging ("фен в футляре") OR asserts an unconfirmed
  // feature ("фен с ионизацией", "фен мощный", "фен с бесщёточным мотором") is
  // speculative — drop it until the SKU/комплектация/features are confirmed. Object
  // + use-case + material keywords (the honest bulk) stay.
  const skuRisky = p.sku?.selectedSkuReliable === false;
  // Feature-word authority = the profile's claimed features PLUS every characteristic
  // row the table itself marks unconfirmed ("заявлено/уточнить/подтвердить"). A row
  // like "Насадка | концентратор | заявлено" is a claim by definition, so its words
  // gate keywords too — that's why "фен с насадкой" no longer leaks. The bare Тип /
  // Материал rows are structural (object + material), not feature claims, so skipped.
  const featureWords = uniq(
    [
      ...claimedFeatureWords(p),
      ...characteristics
        .filter(
          (c) =>
            /заявл|уточн|подтверд/i.test(c.status) &&
            !/^(тип|материал)/i.test(clean(c.name)),
        )
        .flatMap((c) =>
          `${c.name} ${c.value}`
            .toLowerCase()
            .replace(/ё/g, "е")
            .split(/[^а-яёa-z0-9]+/i),
        )
        .filter((w) => w.length >= 5),
    ],
    80,
  );
  const keywords = dedupKeywords(
    filterDangerousList(rawKeywords, p).filter(
      (k) =>
        !skuRisky ||
        (!PACKAGING_RE.test(k) && !assertsClaimedFeatureWord(k, featureWords)),
    ),
    12,
  ).join(", ");

  // Honesty projection: force the profile's authority over facts onto the LLM copy
  // — contain materials to the profile's set, hedge seller-claimed features.
  const grounded = groundSeoToProfile(
    p,
    seoDescription(p, title, prose?.description),
    bullets,
  );
  // The firewall may drop enough bullets (safety/packaging claims) to fall below
  // the 3–5 range the card validator requires. Refill from the honest identity pool
  // (run through the same firewall) so we never ship a 1–2 bullet card.
  if (grounded.bullets.length < 3) {
    const floor = groundSeoToProfile(p, "", honestBulletPool).bullets;
    for (const b of floor) {
      if (grounded.bullets.length >= 3) break;
      if (!grounded.bullets.some((x) => x.toLowerCase() === b.toLowerCase())) {
        grounded.bullets.push(b);
      }
    }
  }

  const out = [
    "# SEO-черновик карточки товара",
    "",
    "## Название",
    title,
    "",
    "## Описание",
    grounded.description,
    "",
    "## Буллеты",
    ...grounded.bullets.map((b, i) => `${i + 1}. ${b}`),
    "",
    "## Характеристики",
    "| Параметр | Значение | Статус |",
    "|---|---|---|",
    ...characteristics.map((c) => `| ${c.name} | ${c.value} | ${c.status} |`),
    "",
    "## Ключевые слова",
    keywords,
    "",
    "## Что уточнить перед публикацией",
    ...list(
      [
        ...p.procurement.mustAskSupplier.slice(0, 6),
        ...p.dataQuality.missingCriticalFields,
      ],
      10,
    ),
    "",
    "## Нельзя писать как факт",
    ...list(p.content.seoForbiddenClaims, 12),
    "",
    "## Идеи для инфографики",
    ...p.content.infographicIdeas
      // Unconfirmed variant → drop slides that sell packaging OR an unconfirmed
      // feature (bare "бесщёточный двигатель", "функция ионизации") — a slide reads
      // as an established selling point, so a soft "(по данным поставщика)" isn't
      // enough; don't propose it as a ready idea until the SKU/feature is confirmed.
      .filter(
        (idea) =>
          p.sku.selectedSkuReliable ||
          (!PACKAGING_RE.test(String(idea)) &&
            !assertsClaimedFeatureWord(String(idea), featureWords)),
      )
      .slice(0, 6)
      .map((idea, i) => `${i + 1}. ${idea}`),
  ]
    .map((line) => fixGluedFallback(line))
    .join("\n");
  return sanitizeUserFacingText(out);
}

// Soften bald material assertions into declared form. 1688 card material is a
// seller claim; a card must not state "изготовлен из нержавеющей стали 3Cr13" as
// fact while the questions file asks to confirm that very grade. Global,
// category-agnostic: rewrites the assertion verb, not the material itself.
function hedgeDeclaredMaterial(text: string): string {
  if (!text) return text;
  // Per-sentence: an assertion that OPENS with "изготовлен/выполнен/сделан из …"
  // is a bald material claim → soften. (\b is unreliable before Cyrillic in JS, so
  // anchor at sentence start.) Mid-sentence uses are rarer and left intact.
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) =>
      s
        .replace(
          /^(?:изготовлен|выполнен|сделан|произвед[её]н)[а-яё]*\s+из\s+/i,
          "Заявленный материал — ",
        )
        // "Материал изделия/товара/продукции — X" reads as a confirmed fact; the
        // 1688 card material is only a seller claim. Rewrite to declared form.
        // (Component labels like "материал лезвия/рукояти" are left intact.)
        .replace(
          /^Материал\s+(?:издели[а-яё]*|товара|продукц[а-яё]*)\s*[—:–-]\s*/i,
          "Заявленный материал — ",
        ),
    )
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function seoDescription(
  p: ProductProcurementProfile,
  title: string,
  proseDescription?: string,
): string {
  // Prefer the LLM writer's prose description; else the seoCard generator's.
  // Salvage the factual sentences from the LLM paragraph, dropping puffery and
  // dangerous-claim sentences rather than discarding the whole thing. Only if
  // enough concrete text survives do we use it; else fall to the honest floor.
  const llm = hedgeDeclaredMaterial(
    stripPufferySentences(
      (proseDescription || p.content.seoDescription || "").trim(),
    ),
  );
  if (llm.length >= 40) {
    // Pure customer-facing copy — publish caveats live in the dedicated
    // "Что уточнить перед публикацией" section, never inside the description.
    return /[.!?]$/.test(llm) ? llm : `${llm}.`;
  }

  // Deterministic fallback — a full sentence, never a bare-noun opener like "шорты.".
  const objectName = safeTitle(
    p.identity.coreObject,
    p.identity.shortTitle,
    title,
  );
  const useCases = p.identity.useCases.length
    ? p.identity.useCases.slice(0, 3).join(", ")
    : "";
  const materialPart =
    p.identity.materials.length &&
    p.identity.materials[0] !== "уточнить у поставщика"
      ? ` Материал: ${p.identity.materials.slice(0, 2).join(", ")}.`
      : "";
  // Honest-generic floor (used only when the LLM gave no description): state the
  // object and its use cases if known, otherwise openly defer to the supplier —
  // never the filler "подходит для повседневного использования", never category
  // guesses. The real, product-specific description comes from the LLM above.
  return useCases
    ? `${capitalizeRu(objectName)} — ${useCases}.${materialPart}`
    : `${capitalizeRu(objectName)}.${materialPart}`.trim();
}

function capitalizeRu(s: string): string {
  const t = (s || "").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

/**
 * Guard against the glue bug: a numeric spec value concatenated directly with a
 * weight/price fallback (e.g. "нагрузка 12вес не указан"). Show the number OR the
 * fallback, never glued. Applied to every user-facing SEO line.
 */
function fixGluedFallback(s: string): string {
  return (s || "").replace(
    /(\d)\s*(вес не указан|вес с упаковкой не указан|цена не указана|не указан[оаы]?)/gi,
    "$1",
  );
}

// A number followed by a physical unit — an SEO bullet must not assert these
// (length/angle/hardness/weight/power). On 1688 they're almost never confirmed
// and belong in the characteristics table, not marketing copy. Counts ("3 режима",
// "5 шт") have no physical unit and are allowed.
const BULLET_MEASUREMENT_RE =
  /\d+(?:[.,]\d+)?\s*(?:см|мм|м\b|кг|г\b|мл|л\b|°|градус|hrc|вт|ватт|в\b|вольт|дюйм)/i;

function filterDangerousBullets(
  bullets: string[],
  _p: ProductProcurementProfile,
): string[] {
  const isOverloadedDisclosureSeoLine = (text: string) => {
    const line = clean(text);
    if (!line) return false;
    const low = line.toLowerCase();
    const clauses = line.split(/[;,]\s*/).filter(Boolean).length;
    const separators = (line.match(/[;,]/g) ?? []).length;
    const hedgeHeavy = /по\s+заявлен|уточнит|подтверд/i.test(low);
    return (hedgeHeavy && clauses >= 4) || (line.length > 190 && clauses >= 3) || separators >= 6;
  };
  return bullets
    .map((b) => hedgeDeclaredMaterial(fixGluedFallback(clean(b))))
    .filter(
      (b) =>
        b &&
        !dangerousClaims(b).length &&
        !hasPuffery(b) &&
        !BULLET_MEASUREMENT_RE.test(b) &&
        !isOverloadedDisclosureSeoLine(b),
    );
}

function filterDangerousList(
  items: Array<string | null | undefined>,
  _p: ProductProcurementProfile,
): string[] {
  return items
    .map((i) => fixGluedFallback(clean(i)))
    .filter((i) => i && !dangerousClaims(i).length);
}

/** Dedup keywords case-insensitively, dropping near-duplicate substrings. */
function dedupKeywords(items: string[], limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    const k = raw.trim();
    if (!k) continue;
    const key = k.toLowerCase();
    if (seen.has(key)) continue;
    // Exact-dup only. A previous substring filter wrongly nuked every long-tail
    // phrase once a bare head term slipped in first ("фен" killed "фен для волос",
    // "фен с ионизацией" …), collapsing keywords to one word. WB wants many
    // variations, so near-duplicates are kept.
    seen.add(key);
    out.push(k);
    if (out.length >= limit) break;
  }
  return out;
}

// Category-agnostic near-duplicate filter for SEO bullets. Two bullets that share
// most of their significant word-stems (e.g. an LLM use-case bullet and the
// deterministic use-case floor bullet — "нарезка мяса, овощей" twice) read as a
// repeat; keep the first, drop the rest. Stems to 5 chars so inflections
// ("нарезки"/"нарезка") still match. No product/category words hardcoded — pure
// token overlap.
function bulletStemSet(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4)
      .map((w) => w.slice(0, 5)),
  );
}
export function dedupBulletsByOverlap(bullets: string[], threshold = 0.6): string[] {
  const kept: string[] = [];
  const keptSets: Set<string>[] = [];
  for (const b of bullets) {
    const toks = bulletStemSet(b);
    if (toks.size === 0) {
      kept.push(b);
      continue;
    }
    const dup = keptSets.some((k) => {
      if (k.size === 0) return false;
      let inter = 0;
      for (const t of toks) if (k.has(t)) inter += 1;
      return inter / Math.min(toks.size, k.size) >= threshold;
    });
    if (dup) continue;
    kept.push(b);
    keptSets.push(toks);
  }
  return kept;
}

function seoCharacteristics(
  p: ProductProcurementProfile,
): Array<{ name: string; value: string; status: string }> {
  const balaclava =
    p.identity.productKind === "clothing" &&
    /балаклав|подшлемник/i.test(
      `${p.identity.titleForReport} ${p.identity.titleForSeo} ${p.identity.coreObject}`,
    );
  const rows =
    p.identity.productKind === "dish_rack" ||
    p.identity.productKind === "kitchen_storage_rack"
      ? [
          {
            name: "Тип",
            value: "настольная сушилка для посуды",
            status: "рабочая гипотеза",
          },
          {
            name: "Конструкция",
            value: p.sku.skuSummary || "многоярусная",
            status: "подтвердить по выбранному SKU",
          },
          {
            name: "Размер",
            value: p.sku.sizes.length
              ? p.sku.sizes.join(", ")
              : "43/53 см — уточнить, что измеряется",
            status: "уточнить у поставщика",
          },
          {
            name: "Материал каркаса",
            value: "сталь/нержавеющая сталь — возможно",
            status: "подтвердить у поставщика",
          },
          {
            name: "Покрытие",
            value: "нужно уточнить",
            status: "подтвердить у поставщика",
          },
          {
            name: "Комплектация",
            value: "полный комплект — уточнить состав",
            status: "подтвердить у поставщика",
          },
          {
            name: "Поддон для воды",
            value: "если входит в комплект",
            status: "подтвердить",
          },
          { name: "Вес", value: "не указан", status: "нужен вес с упаковкой" },
        ]
      : balaclava
        ? [
            {
              name: "Тип",
              value: "балаклава защитная",
              status: "подтвердить назначение",
            },
            ...(p.sku.colors.length
              ? [
                  {
                    name: "Цвета",
                    value: p.sku.colors.join(", "),
                    status: "по SKU карточки",
                  },
                ]
              : []),
            {
              name: "Материал",
              value: p.identity.materials.join(", ") || "полиэстер/ткань",
              status: "подтвердить состав в процентах",
            },
            {
              name: "Размер",
              value: p.sku.sizes.length
                ? p.sku.sizes.join(", ")
                : "один размер / уточнить",
              status: "нужны замеры и растяжимость",
            },
            {
              name: "Сетчатая зона",
              value: "заявлена/видна по фото",
              status: "проверить дыхание на образце",
            },
            {
              name: "УФ-защита",
              value: "если заявлена",
              status: "не писать без подтверждения",
            },
            {
              name: "Вес",
              value: "не указан",
              status: "нужен вес с упаковкой",
            },
          ]
        : [
            {
              name: "Тип",
              value:
                p.identity.productKind === "umbrella"
                  ? "складной автоматический зонт"
                  : p.identity.coreObject || p.identity.shortTitle,
              status: "уточнить/подтвердить",
            },
            ...(p.sku.colors.length
              ? [
                  {
                    name: "Цвета",
                    value: p.sku.colors.join(", "),
                    status: "по SKU карточки",
                  },
                ]
              : []),
            {
              name:
                p.identity.productKind === "umbrella"
                  ? "Материал купола"
                  : "Материал",
              value:
                p.identity.productKind === "umbrella"
                  ? "уточнить"
                  : p.identity.materials.join(", "),
              status: "подтвердить у поставщика",
            },
            ...(p.identity.productKind === "umbrella"
              ? [
                  {
                    name: "Материал спиц",
                    value: "железо/сплав",
                    status: "подтвердить у поставщика",
                  },
                  {
                    name: "Механизм",
                    value: "автоматический",
                    status: "проверить на образце",
                  },
                  {
                    name: "Защита от солнца",
                    value: "UPF50+ заявлено",
                    status: "не писать без подтверждения",
                  },
                ]
              : []),
            {
              name: "Вес",
              value: "не указан",
              status: "нужен вес с упаковкой",
            },
            {
              name: "SKU",
              value: p.sku.skuSummary,
              status: p.sku.selectedSkuReliable
                ? "выбран"
                : "уточнить выбранный SKU",
            },
          ];
  const seen = new Set<string>();
  return rows
    .filter((r) => {
      const k = r.name.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return !!r.value;
    })
    .slice(0, 8);
}

export function buildReadmeFromProfile(
  product: any,
  opts: { sourceUrl?: string } = {},
): string {
  const out = [
    "CardZip — закупочный пакет",
    "",
    "Что внутри:",
    "1. 01_Вопросы_поставщику.txt — вопросы поставщику на русском и китайском.",
    "2. 02_ТЗ_байеру.md — что закупаем, какой SKU выбран и что проверить.",
    "3. 03_ТЗ_карго.md — вес, габариты, упаковка и ограничения для доставки.",
    "4. 04_Чеклист_образца.md — что проверить до образца, на образце и перед партией.",
    "5. 05_SEO_черновик.md — черновик карточки товара и идеи инфографики.",
    "6. 06_Фото_товара.zip — фото товара с 1688, если удалось скачать.",
    "",
    "Рекомендуемый порядок:",
    "1. Отправьте 01_Вопросы_поставщику.txt поставщику.",
    "2. Получите вес, габариты, фото и подтверждение SKU.",
    "3. Передайте 02_ТЗ_байеру.md байеру.",
    "4. Передайте 03_ТЗ_карго.md карго.",
    "5. Закажите 1–2 образца.",
    "6. Проверьте образец по 04_Чеклист_образца.md.",
    "7. Используйте 05_SEO_черновик.md как черновик карточки.",
  ].join("\n");
  return sanitizeUserFacingText(out);
}

function dedupMarkdownBulletLines(text: string): string {
  const seenBySection = new Map<string, Set<string>>();
  let section = "root";
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const h = line.match(/^#{1,3}\s+(.+)/);
    if (h) {
      section = h[1].toLowerCase();
      out.push(line);
      continue;
    }
    const m = line.match(/^\s*(?:[-•]|\d+[.)])\s+(.+)/);
    if (!m) {
      out.push(line);
      continue;
    }
    const key = normalizeDedupKey(m[1]);
    const scoped = `${section}:${key}`;
    if (!key) {
      out.push(line);
      continue;
    }
    if (!seenBySection.has(section))
      seenBySection.set(section, new Set<string>());
    const set = seenBySection.get(section)!;
    if (set.has(scoped) || set.has(key)) continue;
    set.add(scoped);
    set.add(key);
    out.push(line);
  }
  return out.join("\n");
}

export function repairProcurementTexts(input: {
  mainReport?: string;
  productDetails?: string;
  docs?: Array<{ filename: string; text: string }>;
  profile?: ProductProcurementProfile;
}): {
  ok: boolean;
  errors: string[];
  fixed: {
    mainReport?: string;
    productDetails?: string;
    docs: Array<{ filename: string; text: string }>;
  };
} {
  const errors: string[] = [];
  let mainReport = input.mainReport
    ? validateMainReport(input.mainReport).fixedText
    : undefined;
  let productDetails = input.productDetails
    ? fixMixedRuTypos(input.productDetails)
    : undefined;
  const docsInput = input.docs ?? [];
  const checkedDocs = validateDocuments(docsInput, input.profile);
  errors.push(...checkedDocs.errors);

  const BAD_USER_TEXT_RX =
    /из\s+карточки\s+1688|cross[\s-]?border|для\s*cross[\s-]?border|для\s+торговли\s+функции|тип товара:\s*home|аудитория:|пол:|сезон:|артикул:\s*\+|материал:\s*,,|\b(?:undefined|null|nan|debug|raw)\b/i;
  const BAD_TITLE_LINE_RX =
    /(?:Название|## Название|title)[^\n]*(?:для\s+торговли\s+функции|\bтовар\b\s*$|\bфункции\b\s*$|^\s*6\s*$)/i;
  const HUGE_STOCK_RX = /(?:остаток|stock)\D{0,20}\d{7,}/i;
  const MATERIAL_SUPPLIER_RX =
    /(?:Поставщик:[\s\S]{0,180}|Название:\s*)(?:нержавеющ|сталь|steel|пластик|полиэстер|сплав)/i;

  const scan = (label: string, text: string) => {
    if (BAD_USER_TEXT_RX.test(text)) errors.push(`${label}: raw pollution`);
    if (BAD_TITLE_LINE_RX.test(text)) errors.push(`${label}: bad title`);
    if (HUGE_STOCK_RX.test(text))
      errors.push(`${label}: technical stock leaked`);
    if (MATERIAL_SUPPLIER_RX.test(text))
      errors.push(`${label}: material-like supplier name`);
    if (/^\s*\d+\.\s*товар\s*$/im.test(text))
      errors.push(`${label}: SEO bullet товар`);
  };

  if (mainReport) scan("mainReport", mainReport);
  if (productDetails) scan("productDetails", productDetails);
  for (const doc of checkedDocs.fixedDocs) scan(doc.filename, doc.text);

  if (
    input.profile &&
    (input.profile.identity.productKind === "dish_rack" ||
      input.profile.identity.productKind === "kitchen_storage_rack")
  ) {
    const joined = [
      mainReport,
      productDetails,
      ...checkedDocs.fixedDocs.map((d) => d.text),
    ]
      .filter(Boolean)
      .join("\n");
    const productSpecificHits = [
      "ярус",
      "43/53",
      "поддон",
      "покрытие",
      "устойчив",
      "деформац",
      "сборк",
    ].filter((token) => new RegExp(token, "i").test(joined)).length;
    if (productSpecificHits < 4)
      errors.push("dish_rack: not enough product-specific checks");
  }

  const repairText = (text: string) =>
    sanitizeUserFacingText(fixMixedRuTypos(text))
      .split("\n")
      .filter(
        (line) => !BAD_USER_TEXT_RX.test(line) && !HUGE_STOCK_RX.test(line),
      )
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

  return {
    ok: errors.length === 0,
    errors,
    fixed: {
      mainReport: mainReport ? repairText(mainReport) : undefined,
      productDetails: productDetails ? repairText(productDetails) : undefined,
      docs: checkedDocs.fixedDocs.map((doc) => ({
        ...doc,
        text: repairText(doc.text) + "\n",
      })),
    },
  };
}

export function validateDocuments(
  docs: Array<{ filename: string; text: string }>,
  profile?: ProductProcurementProfile,
): {
  ok: boolean;
  errors: string[];
  fixedDocs: Array<{ filename: string; text: string }>;
} {
  const errors: string[] = [];
  const rules = profile ? KIND_RULES[profile.identity.productKind] : undefined;
  const fixedDocs = docs.map((doc) => {
    let text = sanitizeUserFacingText(doc.text);
    if (/Product Intelligence|AI-черновик|debug/i.test(text)) {
      errors.push(`${doc.filename}: internal text`);
      text = text.replace(
        /Product Intelligence|AI-черновик|debug/gi,
        "данные анализа",
      );
    }
    if (
      /из\s+карточки\s+1688|cross[\s-]?border|для\s*cross[\s-]?border|тип товара:\s*home|аудитория:|пол:|сезон:/i.test(
        text,
      )
    ) {
      errors.push(`${doc.filename}: raw pollution`);
      text = text
        .split("\n")
        .filter(
          (l) =>
            !/из\s+карточки\s+1688|cross[\s-]?border|для\s*cross[\s-]?border|тип товара:\s*home|аудитория:|пол:|сезон:/i.test(
              l,
            ),
        )
        .join("\n");
    }
    if (/0(?:[,.]0+)?\s*[₽¥￥]/.test(text)) {
      errors.push(`${doc.filename}: zero money`);
      text = text.replace(/0(?:[,.]0+)?\s*[₽¥￥]/g, "нужно уточнить");
    }
    for (const claim of DANGEROUS_CLAIMS) {
      const rx = new RegExp(
        `\\b${claim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
        "gi",
      );
      if (
        rx.test(text) &&
        !/нельзя писать|не писать|без документов|подтвердить/i.test(text)
      )
        errors.push(`${doc.filename}: dangerous claim ${claim}`);
    }
    if (rules?.forbiddenCategoryWords?.length) {
      for (const word of rules.forbiddenCategoryWords) {
        const rx = new RegExp(
          word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          "gi",
        );
        if (rx.test(text)) {
          errors.push(`${doc.filename}: чужая категория ${word}`);
          text = text
            .split("\n")
            .filter((l) => !rx.test(l))
            .join("\n");
        }
      }
    }
    if (
      doc.filename === "seo_draft.md" ||
      doc.filename === "05_SEO_черновик.md"
    ) {
      const bulletSection =
        text.match(/## Буллеты\n([\s\S]*?)(?:\n## |$)/)?.[1] ?? "";
      const bullets = bulletSection.match(/^\d+\.\s+/gm)?.length ?? 0;
      if (bullets < 3 || bullets > 5)
        errors.push(`${doc.filename}: bullets not in 3–5 range (${bullets})`);
    }

    if (
      profile &&
      (profile.identity.productKind === "dish_rack" ||
        profile.identity.productKind === "kitchen_storage_rack")
    ) {
      const required = /устойчив|покрыт|сборк|поддон|ярус|деформац/i;
      if (
        (doc.filename.includes("байер") || doc.filename.includes("Чеклист")) &&
        !required.test(text)
      ) {
        errors.push(`${doc.filename}: generic checklist for known productKind`);
      }
      if (
        doc.filename.includes("SEO") &&
        (/^\s*\d+\.\s*товар\s*$/im.test(text) ||
          /для\s*cross[\s-]?border/i.test(text))
      ) {
        errors.push(`${doc.filename}: bad SEO for dish rack`);
      }
    }
    return { ...doc, text: text.replace(/\n{3,}/g, "\n\n").trim() + "\n" };
  });
  return { ok: errors.length === 0, errors, fixedDocs };
}

import type { ProductIntelligence } from "../types";
import { normalizeMixedProductText } from "./cnNormalize";
import {
  cleanRawAttributes,
  isMaterialLikeSupplierName,
  stripRawSourceLabels,
  containsRawPollution,
} from "./rawAttributeCleaner";
import { selectBestProductTitle, isBadTitleCandidate } from "./titleSelection";
import { sanitizeUserFacingText } from "./userFacingSanitizer";

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
  | "kitchen_tool"
  | "bag_accessory"
  | "generic_product";

export type SelectedSkuDecision = {
  selectedSkuText: string | null;
  selectedPriceYuan: number | null;
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
    skuRisk: string;
    skuWarnings: string[];
    normalizedExamples: string[];
    ambiguousParams: string[];
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
  };
  procurement: {
    status: string;
    verdict: string;
    nextAction: string;
    mustAskSupplier: string[];
    mustCheckBeforeSample: string[];
    mustCheckOnSample: string[];
    redFlags: string[];
  };
  cargo: {
    mustAsk: string[];
    likelySensitiveCargoIssues: string[];
  };
  content: {
    seoAllowedClaims: string[];
    seoForbiddenClaims: string[];
    titleWarnings: string[];
    infographicIdeas: string[];
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
  usb_device: genericRules("USB-товар"),
  small_appliance: genericRules("малая техника"),
  kitchen_tool: genericRules("кухонный товар"),
  bag_accessory: genericRules("аксессуар"),
  generic_product: genericRules("товар"),
};

function genericRules(label: string) {
  return {
    mustAskSupplier: [
      `Подтвердите цену выбранного SKU для товара “${label}”.`,
      `Укажите вес одной единицы “${label}” с индивидуальной упаковкой.`,
      `Укажите габариты индивидуальной упаковки для “${label}”.`,
      `Подтвердите основной материал и покрытие/отделку, если они есть у “${label}”.`,
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
      `соответствие выбранному SKU для “${label}”`,
      `фактический материал/покрытие “${label}”`,
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
  if (/состав.*ткан/.test(key)) return "состав ткани";
  if (/реальн.*фото|фото.*модел|фото.*упаков/.test(key))
    return "реальные фото товара и упаковки";
  if (/уф|uv|upf/.test(key)) return "подтверждение уф защиты";
  return key;
}

export function dedupNormalizedList(
  list: Array<string | null | undefined>,
  limit = 30,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const text = fixMixedRuTypos(clean(raw))
      .replace(/^\s*(?:[-•]|\d+[.)])\s*/, "")
      .trim();
    if (!text || text === "—") continue;
    const key = normalizeDedupKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function uniq(list: Array<string | null | undefined>, limit = 30): string[] {
  return dedupNormalizedList(list, limit);
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
    /footwear|clothing|towel_kilt|umbrella|sleep_mask|mini_washer|dish_rack|kitchen_storage_rack|passive_insect_trap|usb_device|small_appliance|kitchen_tool|bag_accessory|generic_product/,
  )?.[0];
  if (direct && direct in KIND_RULES) return direct as ProductKind;
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
  const winner =
    (Object.entries(tally).sort(
      (a, b) => b[1] - a[1],
    )[0]?.[0] as ProductKind) || rulesKind;
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
  let items = uniq([...fromIntel, ...fromAttrs].map(safeRu), 6);
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

function buildSkuProfile(
  product: any,
  kind: ProductKind,
  sourceUrl?: string,
): ProductProcurementProfile["sku"] {
  const variants = collectSkuVariants(product);
  const labels = variants.map(skuName).filter(Boolean);
  const colors = extractColors(labels);
  const ambiguousParams = extractAmbiguousParams(labels, kind);
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
  const models =
    kind === "dish_rack" || kind === "kitchen_storage_rack"
      ? uniq(
          labels.flatMap((l) =>
            Array.from(l.matchAll(/\b[23]\s*(?:ярус[а-яё]*|tier|层)/gi)).map(
              (m) => m[0],
            ),
          ),
          8,
        )
      : [];
  const packCounts = uniq(
    labels.flatMap((l) =>
      Array.from(l.matchAll(/\b\d+\s*(?:шт|pcs|件|个)\b/gi)).map((m) => m[0]),
    ),
    8,
  );
  const dims: string[] = [];
  if (colors.length) dims.push("цвет");
  if (models.length) dims.push("количество ярусов");
  if (sizeMatches.length)
    dims.push(
      kind === "dish_rack" || kind === "kitchen_storage_rack"
        ? "размер"
        : "размер",
    );
  if (ambiguousParams.length) dims.push("параметр SKU");
  if (!dims.length && variants.length > 1) dims.push("вариант");
  const count = variants.length || labels.length;
  const skuSummary = count
    ? `${count} ${pluralRu(count, "вариант", "варианта", "вариантов")} · ${dims.join(" × ") || "вариант"}`
    : "SKU нужно уточнить";
  const normalizedExamples = labels
    .slice(0, 5)
    .map((l) =>
      ambiguousParams.length
        ? l.replace(/\b(8|16|40|120)\b/g, "Параметр $1")
        : l,
    );
  const selected = makeSelectedSkuDecision(product, variants, sourceUrl);
  return {
    skuSummary,
    selectedSkuText: selected.selectedSkuText,
    selectedSkuReliable: selected.reliable,
    selectedSkuDecision: selected,
    dimensions: dims,
    colors,
    sizes: sizeMatches,
    models,
    packageTypes,
    packCounts,
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
  };
}

export function makeSelectedSkuDecision(
  product: any,
  variants = collectSkuVariants(product),
  sourceUrl?: string,
): SelectedSkuDecision {
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
    if (found)
      return {
        selectedSkuText: skuName(found) || `SKU ${urlSku}`,
        selectedPriceYuan: skuPrice(found),
        reliable: true,
        reason: "SKU взят из URL и найден в API.",
      };
  }
  if (variants.length === 1)
    return {
      selectedSkuText: skuName(variants[0]) || "единственный SKU",
      selectedPriceYuan: skuPrice(variants[0]),
      reliable: true,
      reason: "В карточке один SKU.",
    };
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
      selectedSkuText: safeRu(explicit),
      selectedPriceYuan: explicitPrice,
      reliable: true,
      reason: "SKU передан явно после выбора пользователя/URL.",
    };
  return {
    selectedSkuText: null,
    selectedPriceYuan: null,
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
  const selectedPrice =
    selected.selectedPriceYuan ??
    (selected.reliable ? pos(product?.priceYuan ?? product?.price) : null);
  const displayPriceText = selectedPrice
    ? `Выбранный SKU: ${cny(selectedPrice)}`
    : min && max && min !== max
      ? `Цена по SKU: ${String(min).replace(".", ",")}–${String(max).replace(".", ",")} ¥`
      : min
        ? `Цена: ${cny(min)}`
        : "Цена: нужно уточнить";
  return {
    displayPriceText,
    selectedPriceYuan: selectedPrice,
    minPriceYuan: min,
    maxPriceYuan: max,
    priceSource: selectedPrice
      ? "selected_sku"
      : skuPrices.length
        ? "sku_range"
        : min
          ? "price_range"
          : "missing",
    priceReliable: !!selectedPrice || (!!min && !!max),
    priceWarnings: uniq(
      [
        !selected.reliable ? "цена выбранного SKU требует подтверждения" : "",
        !min ? "нет цены в данных" : "",
      ],
      4,
    ),
  };
}

function buildQuestions(
  profileBase: Pick<ProductProcurementProfile, "identity" | "sku" | "pricing">,
  rules: (typeof KIND_RULES)[ProductKind],
): string[] {
  const priceValue = profileBase.pricing.selectedPriceYuan
    ? cny(profileBase.pricing.selectedPriceYuan)
    : "";
  const selectedSku = profileBase.sku.selectedSkuText
    ? fixMixedRuTypos(profileBase.sku.selectedSkuText)
    : "";
  const priceQuestion =
    selectedSku && priceValue
      ? `Подтвердите цену выбранного SKU: ${selectedSku} — ${priceValue}.`
      : priceValue
        ? `Подтвердите цену выбранного SKU: ${priceValue}.`
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
): string {
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
  const titleForReport = selectedTitles.titleForReport;
  const titleForSeo = safeSeoTitle(
    safeRu(draftIdentity.titleForSeo || selectedTitles.titleForSeo),
    kind,
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
        kind === "dish_rack" || kind === "kitchen_storage_rack"
          ? "home_kitchen"
          : safeRu(identity.categoryType || product?.categoryType || kind),
      subCategoryType: safeRu(identity.subCategoryType || ""),
      titleForReport,
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
      materials: uniq(
        [...array<string>(draftIdentity.materials).map(safeRu), ...materials],
        6,
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
  const mustAskSupplier = uniq(
    [
      ...array<string>(draftProcurement.mustAskSupplier).map(safeRu),
      ...buildQuestions(baseProfile, rules),
    ],
    12,
  ).slice(0, 10);
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
      name: isMaterialLikeSupplierName(product?.supplierName)
        ? "не указано"
        : safeRu(product?.supplierName || "") || "не указано",
    },
    procurement: {
      status: missing.length
        ? "🟡 Нужны данные поставщика"
        : "🟢 Готов к заказу образца",
      verdict: buildKindVerdict(kind, product, missing.length > 0),
      nextAction: "Отправьте вопросы поставщику и скачайте закупочный пакет.",
      mustAskSupplier,
      mustCheckBeforeSample: uniq(
        [
          ...array<string>(draftProcurement.mustCheckBeforeSample).map(safeRu),
          ...rules.beforeSample,
        ],
        8,
      ),
      mustCheckOnSample: uniq(
        [
          ...array<string>(draftProcurement.mustCheckOnSample).map(safeRu),
          ...rules.onSample,
        ],
        12,
      ),
      redFlags: uniq(
        [
          ...array<string>(draftProcurement.redFlags).map(safeRu),
          ...rules.redFlags,
          ...array<string>(intelligence?.reportRules?.riskFlags).map(safeRu),
        ],
        12,
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
        ],
        14,
      ),
      likelySensitiveCargoIssues: uniq(
        kind === "mini_washer" ||
          kind === "small_appliance" ||
          kind === "usb_device"
          ? [
              "питание/вилка/напряжение",
              "аккумулятор или батарейка — уточнить",
              "сертификаты для техники",
            ]
          : [],
        6,
      ),
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
    supplierQuestionsCn: array<string>(
      record(draftProcurement).supplierQuestionsCn,
    ).map(safeRu),
    supplierQuestionsCnValid: false,
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
  for (const claim of DANGEROUS_CLAIMS)
    out = out.replace(new RegExp(escapeRegExp(claim), "gi"), "").trim();
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

function dangerousClaims(text: string): string[] {
  return DANGEROUS_CLAIMS.filter((c) =>
    new RegExp(escapeRegExp(c), "i").test(text),
  );
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
  const priceYuan = p.pricing.selectedPriceYuan ?? p.pricing.minPriceYuan;
  const purchaseRub = priceYuan ? Math.round(priceYuan * YUAN_TO_RUB) : null;
  const costWithoutCargo = purchaseRub
    ? Math.round(purchaseRub * (1 + BANK_MARKUP) + FULFILLMENT_RUB)
    : null;
  const moq = pos(product?.moq ?? product?.normalized1688?.moq);
  const weight = pos(product?.weightKg ?? product?.packedWeightKg);
  const lines = [
    `📦 <b>${escapeHtml(p.identity.titleForReport)}</b>`,
    "",
    "Источник: 1688",
    `Поставщик: ${escapeHtml(p.supplier.displayType)}${p.supplier.rating && p.supplier.rating !== "—" ? ` · рейтинг ${escapeHtml(p.supplier.rating)}` : ""}${p.supplier.orders && p.supplier.orders !== "—" ? ` · заказов ${escapeHtml(p.supplier.orders)}` : ""}`,
    "",
    "📌 <b>Товар</b>",
    `• Цена: ${escapeHtml(p.pricing.displayPriceText.replace(/^Цена:\s*/i, "").replace(/^Цена по SKU:\s*/i, "по SKU: "))}`,
    `• Выбранный SKU: ${escapeHtml(p.sku.selectedSkuText || (p.sku.selectedSkuReliable ? "не определён" : `не определён. ${p.pricing.minPriceYuan && p.pricing.maxPriceYuan ? `Цена по SKU: ${String(p.pricing.minPriceYuan).replace(".", ",")}${p.pricing.maxPriceYuan !== p.pricing.minPriceYuan ? `–${String(p.pricing.maxPriceYuan).replace(".", ",")}` : ""} ¥.` : "Нужен выбор SKU."}`))}`,
    `• MOQ: ${moq ? `${Math.round(moq)} шт` : "уточнить"}`,
    `• SKU: ${escapeHtml(p.sku.skuSummary)}`,
    p.sku.colors.length
      ? `• Цвета: ${escapeHtml(p.sku.colors.join(", "))}`
      : "",
    p.sku.sizes.length
      ? `• Размеры: ${escapeHtml(p.sku.sizes.join(", "))}`
      : p.sku.ambiguousParams.length
        ? `• Параметры: ${escapeHtml(p.sku.ambiguousParams.join(" / "))} — значение нужно уточнить`
        : "",
    `• Материал: ${escapeHtml(p.identity.materials.join(", "))}${/подтверд/i.test(p.identity.materials.join(" ")) ? "" : " — подтвердить"}`,
    `• Вес: ${weight ? `${weight} кг` : "не указан"}`,
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
  ].filter(Boolean);
  return lines.join("\n");
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
  return { ok: errors.length === 0, errors };
}

function translateQuestionToCn(q: string): string {
  const lower = q.toLowerCase();
  const price = q.match(/(\d+(?:[,.]\d+)?)\s*¥/)?.[1]?.replace(",", ".");
  const params = q
    .match(/SKU\s+([\d\s/]+)/i)?.[1]
    ?.replace(/\s+/g, " ")
    .trim();
  if (/цен/.test(lower))
    return `请确认所选SKU的价格${price ? `：${price} 元` : ""}。`;
  if (/ярус|собранном виде/.test(lower))
    return "请提供所选SKU的层数，以及组装后的长、宽、高尺寸。";
  if (/43\/53|43\s*см|53\s*см/.test(lower))
    return "请说明43/53厘米指的是长度、宽度还是其他尺寸参数。";
  if (/материал.*покрыт|покрыт.*материал|каркас/.test(lower))
    return "请确认框架材质和表面涂层类型。";
  if (/полный комплект|комплектац/.test(lower))
    return "请确认“完整套装”包含哪些配件：接水盘、支架、挂钩、层架等。";
  if (/поддон/.test(lower)) return "请确认是否包含可拆卸接水盘。";
  if (/реальн.*фото|фото.*комплектац|фото.*упаков/.test(lower))
    return "请发送所选SKU、完整配件和包装的实拍照片。";
  if (/вес/.test(lower)) return "请提供所选SKU单件含独立包装的重量。";
  if (/габарит|размер.*упаков/.test(lower)) return "请提供单件独立包装尺寸。";
  if (/параметр/.test(lower))
    return `请说明SKU参数${params ? ` ${params}` : ""}分别代表什么：尺寸、容量、数量规格还是其他参数？`;
  if (/длин/.test(lower)) return "请提供产品折叠后或收纳状态的长度。";
  if (/диаметр/.test(lower)) return "请提供展开后的尺寸或直径。";
  if (/материал/.test(lower)) return "请确认产品材料和关键部件材料。";
  if (/спиц/.test(lower)) return "请确认所选SKU的伞骨数量。";
  if (/чехол/.test(lower))
    return "是否包含收纳套？请发送产品打开、折叠状态和包装的实拍图。";
  if (/moq|минимальн/.test(lower)) return "请确认最小起订量和发货时间。";
  if (/образец/.test(lower)) return "是否可以先购买1-2件样品？";
  return "请确认该问题中的相关产品信息。";
}

export function buildSupplierQuestionsFromProfile(
  product: any,
  opts: { sourceUrl?: string } = {},
): SupplierQuestionsProfileResult {
  const profile = ensureProductProcurementProfile(product, opts);
  const ru = uniq(profile.procurement.mustAskSupplier, 10).slice(0, 10);
  const savedCn =
    profile.supplierQuestionsCnValid &&
    Array.isArray(profile.supplierQuestionsCn)
      ? profile.supplierQuestionsCn
      : [];
  const cn =
    savedCn.length === ru.length ? savedCn : ru.map(translateQuestionToCn);
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
  const fallback = cleanRu.map(translateQuestionToCn);
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
          "google/gemini-2.5-flash-lite",
        max_tokens: 900,
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
      signal: g.AbortSignal.timeout(12_000),
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
  return [
    "# ТЗ байеру",
    "",
    "## 1. Товар",
    `Название: ${p.identity.titleForReport}`,
    `Ссылка: ${opts.sourceUrl ?? product?.sourceUrl ?? "—"}`,
    `Цена: ${p.pricing.displayPriceText}`,
    `SKU: ${p.sku.selectedSkuText ?? "не определён"}`,
    `SKU в карточке: ${p.sku.skuSummary}`,
    `Цвета: ${p.sku.colors.length ? p.sku.colors.join(", ") : "уточнить"}`,
    `Материал: ${p.identity.materials.join(", ")}`,
    `MOQ: ${pos(product?.moq) ? `${Math.round(pos(product?.moq)!)} шт.` : "уточнить"}`,
    "",
    "## 2. Поставщик",
    `Название: ${p.supplier.name || "не указано"}`,
    `Тип: ${p.supplier.displayType}`,
    `Рейтинг: ${p.supplier.rating || "—"}`,
    `Заказы: ${p.supplier.orders || "—"}`,
    "",
    "## 3. Что подтвердить у поставщика",
    ...list(p.procurement.mustAskSupplier, 10),
    "",
    "## 4. Что проверить на образце",
    ...list(p.procurement.mustCheckOnSample, 10),
    "",
    "## 5. Фото, которые нужно запросить",
    "- общий вид выбранного SKU",
    "- крупно материал и важные детали",
    "- упаковка и маркировка",
    "- комплектация в одном кадре",
    "- фото рядом с линейкой, если размер важен",
    "",
    "## 6. Риски",
    ...list(p.procurement.redFlags, 10),
    "",
    "## 7. Решение",
    p.procurement.verdict,
  ].join("\n");
}

export function buildCargoBriefFromProfile(
  product: any,
  opts: { sourceUrl?: string } = {},
): string {
  const p = ensureProductProcurementProfile(product, opts);
  const weight = pos(product?.weightKg ?? product?.packedWeightKg);
  return [
    "# ТЗ карго",
    "",
    "## Товар",
    `Название: ${p.identity.titleForReport}`,
    `Ссылка: ${opts.sourceUrl ?? product?.sourceUrl ?? "—"}`,
    `SKU: ${p.sku.selectedSkuText ?? "не определён"}`,
    `Цена: ${p.pricing.displayPriceText}`,
    "",
    "## Что нужно запросить для доставки",
    ...list(p.cargo.mustAsk, 16),
    "",
    "## Дополнительно по этому товару",
    ...(p.cargo.likelySensitiveCargoIssues.length
      ? list(p.cargo.likelySensitiveCargoIssues, 8)
      : [
          "- специальных ограничений не найдено, но ограничения по перевозке нужно подтвердить у карго",
        ]),
    "",
    "## Текущий статус",
    `Вес: ${weight ? `${weight} кг` : "не указан"}`,
    "Габариты: не указаны",
    `SKU: ${p.sku.selectedSkuText ?? "не определён"}`,
    "",
    "## Важно",
    "Карго не рассчитывается точно без веса и габаритов выбранного SKU.",
  ].join("\n");
}

export function buildSampleChecklistFromProfile(
  product: any,
  opts: { sourceUrl?: string } = {},
): string {
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
    ...list(p.procurement.redFlags, 10),
    "",
    "## Решение после образца",
    "- брать в тестовую партию",
    "- доработать SKU/упаковку/контент",
    "- не брать",
  ].join("\n");
}

export function buildSeoDraftFromProfile(
  product: any,
  opts: { sourceUrl?: string } = {},
): string {
  const p = ensureProductProcurementProfile(product, opts);
  const title = safeSeoTitle(p.identity.titleForSeo, p.identity.productKind);
  const useCases = p.identity.useCases.length
    ? p.identity.useCases.join(", ")
    : "повседневного использования";
  const material = p.identity.materials.join(", ");
  const isDishRack =
    p.identity.productKind === "dish_rack" ||
    p.identity.productKind === "kitchen_storage_rack";
  const balaclava =
    p.identity.productKind === "clothing" &&
    /балаклав|подшлемник/i.test(
      `${p.identity.titleForReport} ${p.identity.titleForSeo} ${p.identity.coreObject}`,
    );
  const bullets = isDishRack
    ? [
        "Настольная сушилка для посуды и кухонного хранения",
        "Варианты на 2 или 3 яруса зависят от выбранного SKU",
        "Подходит для тарелок, чашек, стаканов и столовых приборов",
        "Материал каркаса и покрытие нужно подтвердить у поставщика",
        "Перед продажей проверьте устойчивость, сборку и упаковку",
      ]
    : balaclava
      ? [
          "Лёгкая балаклава для велосипеда, туризма и активного отдыха",
          "Закрывает голову, лицо и шею от ветра, пыли и солнца",
          "Сетчатая зона для более комфортного дыхания",
          p.sku.colors.length
            ? `Несколько цветов в карточке 1688: ${p.sku.colors.join(", ")}`
            : "Несколько вариантов в карточке 1688",
          "Перед продажей подтвердите состав, размер и УФ-защиту",
        ]
      : uniq(
          [
            `${p.identity.shortTitle || title} для ${useCases}`,
            material && !/уточнить/.test(material)
              ? `Материал: ${material}${/подтверд/i.test(material) ? "" : " — подтвердите у поставщика"}`
              : "Материал нужно подтвердить у поставщика",
            p.sku.colors.length
              ? `Доступные цвета: ${p.sku.colors.join(", ")}`
              : "Цвет и SKU выберите по карточке 1688",
            p.sku.skuSummary
              ? `SKU в карточке: ${p.sku.skuSummary}`
              : "SKU нужно уточнить перед закупкой",
            "Перед продажей проверьте образец, вес и упаковку",
          ],
          5,
        ).slice(0, 5);
  while (bullets.length < 5)
    bullets.push("Характеристику нужно подтвердить перед публикацией");
  const characteristics = seoCharacteristics(p);
  const out = [
    "# SEO-черновик карточки товара",
    "",
    "## Название",
    title,
    "",
    "## Описание",
    seoDescription(p, title),
    "",
    "## Буллеты",
    ...bullets.map((b, i) => `${i + 1}. ${b}`),
    "",
    "## Характеристики",
    "| Параметр | Значение | Статус |",
    "|---|---|---|",
    ...characteristics.map((c) => `| ${c.name} | ${c.value} | ${c.status} |`),
    "",
    "## Ключевые слова",
    uniq(
      [
        title,
        p.identity.coreObject,
        p.identity.shortTitle,
        ...p.identity.useCases,
        ...p.sku.colors.map((c) => `${p.identity.coreObject} ${c}`),
      ],
      12,
    ).join(", "),
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
      .slice(0, 6)
      .map((idea, i) => `${i + 1}. ${idea}`),
  ].join("\n");
  return sanitizeUserFacingText(out);
}

function seoDescription(p: ProductProcurementProfile, title: string): string {
  if (
    p.identity.productKind === "dish_rack" ||
    p.identity.productKind === "kitchen_storage_rack"
  ) {
    return "Настольная многоярусная сушилка помогает сушить и хранить тарелки, чашки, стаканы и столовые приборы рядом с мойкой. Перед публикацией нужно подтвердить материал каркаса, тип покрытия, размеры выбранного SKU, комплектацию, вес, упаковку и реальные фото у поставщика.";
  }
  if (
    p.identity.productKind === "clothing" &&
    /балаклав|подшлемник/i.test(
      `${p.identity.titleForReport} ${p.identity.titleForSeo} ${p.identity.coreObject}`,
    )
  ) {
    return "Лёгкая балаклава из полиэстера подходит для поездок на велосипеде, туризма, прогулок и защиты лица от ветра, пыли и солнца. Сетчатая зона помогает легче дышать при активном движении. Перед публикацией подтвердите состав ткани, размеры, упаковку и заявленную УФ-защиту у поставщика.";
  }
  if (p.identity.productKind === "umbrella") {
    return "Складной автоматический зонт с крючком и чехлом подходит для повседневного использования в дороге, на прогулке и в поездках. Перед публикацией подтвердите размер, материал купола и спиц, механизм, комплектацию и заявленную защиту от солнца.";
  }
  return `${title} — черновик карточки товара на основе закупочных данных. Перед публикацией подтвердите материал, выбранный SKU, вес, упаковку и реальные фото у поставщика. Неподтверждённые свойства не указывайте как факт.`;
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

export function validateProcurementResult(input: {
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
      if (bullets !== 5) errors.push(`${doc.filename}: bullets not 5`);
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

import type { ProductIntelligence } from '../types';
import { normalizeMixedProductText } from './cnNormalize';

export type ProductKind =
  | 'footwear'
  | 'clothing'
  | 'towel_kilt'
  | 'umbrella'
  | 'sleep_mask'
  | 'mini_washer'
  | 'passive_insect_trap'
  | 'usb_device'
  | 'small_appliance'
  | 'food_warmer'
  | 'heating_appliance'
  | 'kitchen_tool'
  | 'tool_kit'
  | 'bag_accessory'
  | 'home_textile'
  | 'beauty_accessory'
  | 'pet_product'
  | 'toy'
  | 'generic_product';

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
    plugStandards: string[];
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
    confidence: 'high' | 'medium' | 'low';
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
  confidenceLabel: 'high' | 'medium' | 'low';
  visionKind: ProductKind | null;
  textKind: ProductKind | null;
  rulesKind: ProductKind;
  evidence: string[];
  disagreement: boolean;
};

export type ProductIntelligenceImage = {
  url: string;
  role: 'selected_sku_image' | 'main_product_image' | 'detail_image' | 'package_image';
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
  'медицинский', 'ортопедический', 'лечебный', 'антибактериальный', 'сертифицированный',
  'гипоаллергенный', 'безопасный для детей', 'профессиональный', 'оригинальный бренд',
  '100% водонепроницаемый', 'UPF50+', 'дезинфекция', 'стерилизация',
  'пищевой силикон', 'графеновый', 'защита от перегрева', 'быстрый нагрев',
  'равномерный нагрев', 'энергосберегающий', 'влагозащищённый', 'гарантия',
];

const KIND_RULES: Record<ProductKind, {
  mustAskSupplier: string[];
  beforeSample: string[];
  onSample: string[];
  cargo: string[];
  redFlags: string[];
  seoAllowed: string[];
  seoForbidden: string[];
  infographic: string[];
  forbiddenCategoryWords: string[];
}> = {
  umbrella: {
    mustAskSupplier: [
      'Подтвердите цену выбранного SKU.',
      'Укажите вес с упаковкой выбранного SKU.',
      'Укажите габариты индивидуальной упаковки.',
      'Укажите длину зонта в сложенном виде.',
      'Укажите диаметр купола в раскрытом виде.',
      'Сколько спиц у выбранного SKU?',
      'Какой материал купола и спиц?',
      'Есть ли чехол в комплекте? Пришлите фото открытого/закрытого зонта и упаковки.',
    ],
    beforeSample: ['подтвердить цену SKU', 'получить вес и габариты', 'уточнить параметры SKU', 'запросить фото открытого и закрытого зонта', 'уточнить наличие чехла'],
    onSample: ['работу механизма', 'не заедает ли кнопка', 'прочность спиц', 'люфт ручки', 'качество ткани купола', 'швы', 'водоотталкивание', 'размер в раскрытом виде', 'длину в сложенном виде', 'чехол и упаковку'],
    cargo: ['длина в сложенном виде', 'упаковка, чтобы не погнулись спицы', 'вес с упаковкой выбранного SKU', 'габариты индивидуальной упаковки'],
    redFlags: ['не подтверждён материал спиц/купола', 'нет веса с упаковкой', 'механизм заедает', 'UPF50+ заявлен без подтверждения', 'нет фото упаковки'],
    seoAllowed: ['складной формат', 'автоматический механизм, если подтверждён', 'чехол, если в комплекте', 'цвета и сценарии использования'],
    seoForbidden: ['UPF50+ без документов', 'ветроустойчивый без теста', '100% защита от дождя', 'премиальный без подтверждения'],
    infographic: ['Зонт складной автоматический', 'Крючок и ручка крупно', 'Размер в сложенном и раскрытом виде', 'Цвета и купол', 'Чехол и упаковка'],
    forbiddenCategoryWords: ['подошва', 'стелька', 'размерная сетка', 'срок годности', 'консистенция', 'мощность', 'напряжение', 'тип вилки'],
  },
  footwear: {
    mustAskSupplier: ['Подтвердите цену выбранного SKU.', 'Укажите вес пары с упаковкой.', 'Пришлите размерную сетку и длину стельки.', 'Подтвердите материал верха и подошвы.', 'Укажите размеры коробки одной пары.', 'Есть ли запах EVA/PU после распаковки?', 'Пришлите реальные фото пары и упаковки.', 'Можно ли заказать 1–2 образца?'],
    beforeSample: ['подтвердить размер и цену SKU', 'получить размерную сетку', 'получить вес пары и габариты коробки', 'запросить фото пары и упаковки'],
    onSample: ['соответствие размеру', 'длину стельки', 'материал верха', 'материал подошвы', 'запах EVA/PU', 'качество декора', 'склейку/литьё', 'вес пары с упаковкой', 'упаковку'],
    cargo: ['вес пары с упаковкой', 'размеры коробки одной пары'],
    redFlags: ['нет размерной сетки', 'сильный запах', 'скользкая подошва', 'плохая склейка/литьё', 'нет реальных фото'],
    seoAllowed: ['EVA, если подтверждено', 'несколько цветов/размеров', 'для дома/пляжа/дачи, если подходит по товару'],
    seoForbidden: ['ортопедический без документов', 'медицинский без документов', 'антибактериальный без документов'],
    infographic: ['Сабо/обувь крупно', 'Материал и подошва', 'Размерная сетка', 'Цвета', 'Упаковка'],
    forbiddenCategoryWords: ['мощность', 'напряжение', 'тип вилки', 'аккумулятор', 'рукав', 'усадка после стирки'],
  },
  sleep_mask: {
    mustAskSupplier: ['Подтвердите цену выбранного SKU.', 'Укажите вес с упаковкой.', 'Укажите размер маски.', 'Подтвердите материал лицевой и внутренней части.', 'Какой тип упаковки: OPP или коробка?', 'Регулируется ли ремешок?', 'Подтвердите 3D-форму и затемнение.', 'Пришлите реальные фото выбранного цвета и упаковки.'],
    beforeSample: ['подтвердить материал', 'получить вес и упаковку', 'уточнить ремешок', 'запросить фото выбранного цвета'],
    onSample: ['мягкость материала', 'форму 3D-углублений', 'не давит ли на глаза', 'не давит ли на нос', 'качество резинки/ремешка', 'затемнение на свету', 'запах после распаковки', 'швы и края', 'комфорт 10–15 минут', 'упаковку OPP/коробка'],
    cargo: ['вес с упаковкой', 'габариты индивидуальной упаковки', 'тип упаковки'],
    redFlags: ['давит на глаза/нос', 'резкий запах', 'слабое затемнение', 'плохие швы', 'не подтверждён материал'],
    seoAllowed: ['мягкая маска', '3D-форма, если подтверждена', 'регулируемый ремешок, если подтверждён'],
    seoForbidden: ['лечебный сон', 'гипоаллергенный без документов', '100% затемнение без теста'],
    infographic: ['Маска для сна', '3D-углубления', 'Ремешок', 'Затемнение', 'Упаковка'],
    forbiddenCategoryWords: ['срок годности', 'консистенция', 'подошва', 'тип вилки', 'мощность', 'напряжение'],
  },
  mini_washer: {
    mustAskSupplier: ['Подтвердите цену выбранного SKU.', 'Укажите мощность и напряжение.', 'Какой тип вилки?', 'Укажите длину кабеля.', 'Какой реальный объём?', 'Какие режимы работы?', 'Есть ли слив?', 'Пришлите видео работы, инструкцию и фото упаковки.'],
    beforeSample: ['подтвердить вилку/напряжение', 'получить видео работы', 'уточнить слив', 'получить вес и габариты', 'запросить инструкцию'],
    onSample: ['включается ли от нужного напряжения', 'не течёт ли корпус', 'как работает слив', 'шум и вибрацию', 'качество пластика', 'фактический объём', 'режимы работы', 'длину кабеля', 'комплектацию', 'инструкцию', 'упаковку после доставки'],
    cargo: ['вес с упаковкой', 'габариты упаковки', 'есть ли батарейка/аккумулятор', 'тип вилки', 'напряжение', 'сертификаты'],
    redFlags: ['нет данных по напряжению/вилке', 'нет видео работы', 'протечки', 'сильный шум/вибрация', 'нет инструкции'],
    seoAllowed: ['портативная стиральная машина', 'режимы работы, если подтверждены', 'объём, если подтверждён'],
    seoForbidden: ['дезинфекция без документов', 'стерилизация без документов', 'безопасна для детей без документов', 'профессиональная без подтверждения'],
    infographic: ['Мини-стиральная машина', 'Панель/режимы', 'Слив', 'Комплектация', 'Упаковка'],
    forbiddenCategoryWords: ['подошва', 'стелька', 'рукав', 'состав ткани в процентах', 'срок годности', 'консистенция'],
  },
  clothing: {
    mustAskSupplier: ['Подтвердите цену выбранного SKU.', 'Укажите состав ткани.', 'Пришлите размерную сетку.', 'Укажите замеры изделия.', 'Есть ли усадка после стирки?', 'Укажите вес с упаковкой.', 'Пришлите реальные фото ткани, бирки и упаковки.', 'Можно ли заказать 1–2 образца?'],
    beforeSample: ['подтвердить состав', 'получить размерную сетку', 'получить замеры', 'запросить фото ткани/бирки'],
    onSample: ['состав и плотность ткани', 'посадку', 'швы', 'цветопередачу', 'усадку после стирки', 'бирки', 'упаковку'],
    cargo: ['вес с упаковкой', 'габариты упаковки', 'количество в коробке'],
    redFlags: ['нет состава', 'нет размерной сетки', 'сильная усадка', 'плохие швы'],
    seoAllowed: ['состав, если подтверждён', 'сезонность', 'сценарии носки'],
    seoForbidden: ['лечебный', 'сертифицированный без документов'],
    infographic: ['Одежда общий вид', 'Ткань крупно', 'Размеры', 'Детали', 'Упаковка'],
    forbiddenCategoryWords: ['мощность', 'напряжение', 'тип вилки', 'аккумулятор', 'подошва'],
  },
  towel_kilt: {
    mustAskSupplier: ['Подтвердите цену выбранного SKU.', 'Укажите состав ткани.', 'Укажите плотность/вес изделия.', 'Укажите размеры.', 'Как фиксируется изделие?', 'Пришлите реальные фото ткани и упаковки.', 'Укажите вес с упаковкой.', 'Можно ли заказать образец?'],
    beforeSample: ['подтвердить состав', 'получить размеры', 'получить вес', 'запросить фото ткани'],
    onSample: ['мягкость ткани', 'впитываемость', 'качество фиксации', 'швы', 'размер', 'упаковку'],
    cargo: ['вес с упаковкой', 'габариты упаковки', 'количество в коробке'],
    redFlags: ['нет состава ткани', 'плохая фиксация', 'тонкая ткань'],
    seoAllowed: ['полотенце-килт', 'для душа/бани, если подходит'],
    seoForbidden: ['мужская юбка-полотенце', 'антибактериальный без документов'],
    infographic: ['Полотенце-килт', 'Материал', 'Фиксация', 'Размер', 'Упаковка'],
    forbiddenCategoryWords: ['мужская юбка-полотенце', 'подошва', 'тип вилки', 'мощность'],
  },
  passive_insect_trap: {
    mustAskSupplier: ['Подтвердите цену выбранного SKU.', 'Укажите количество штук в комплекте.', 'Укажите размер одной ловушки.', 'Подтвердите материал.', 'Есть ли приманка в комплекте?', 'Как крепится или размещается товар?', 'Укажите вес и габариты упаковки.', 'Пришлите реальные фото товара и упаковки.'],
    beforeSample: ['подтвердить комплектацию', 'получить размер', 'получить вес', 'запросить фото упаковки'],
    onSample: ['размер и материал', 'комплектацию', 'крепление/размещение', 'поверхность/липкость, если применимо', 'упаковку'],
    cargo: ['вес выбранной комплектации', 'габариты упаковки', 'количество штук в комплекте', 'количество комплектов в коробке', 'фото упаковки'],
    redFlags: ['непонятная комплектация', 'нет размера/материала', 'появились электрические claims у пассивной ловушки'],
    seoAllowed: ['пассивная ловушка', 'комплектация', 'способ размещения'],
    seoForbidden: ['электрическая без подтверждения', 'ультразвуковая без подтверждения', '100% избавляет от насекомых'],
    infographic: ['Пассивная ловушка', 'Как использовать', 'Комплектация', 'Материал', 'Упаковка'],
    forbiddenCategoryWords: ['мощность', 'напряжение', 'тип вилки', 'аккумулятор', 'лампа'],
  },
  usb_device: genericRules('USB-товар'),
  small_appliance: electricalRules('малая техника'),
  food_warmer: electricalRules('прибор для подогрева еды'),
  heating_appliance: electricalRules('нагревательный прибор'),
  kitchen_tool: genericRules('кухонный товар'),
  tool_kit: {
    mustAskSupplier: [
      'Подтвердите цену выбранного SKU.',
      'Укажите точное количество предметов в наборе и пришлите список комплектации.',
      'Укажите вес набора с индивидуальной упаковкой.',
      'Укажите габариты кейса/индивидуальной упаковки.',
      'Подтвердите материал металлических частей и материал ручек.',
      'Пришлите фото раскрытого кейса и всех инструментов крупно.',
      'Пришлите фото упаковки, маркировки и штрихкода, если есть.',
      'Есть ли условия замены при браке?',
      'Можно ли заказать 1–2 образца перед партией?',
    ],
    beforeSample: ['подтвердить цену SKU', 'получить список комплектации', 'получить вес и габариты упаковки', 'запросить фото раскрытого кейса', 'запросить фото всех инструментов и упаковки'],
    onSample: ['фактическое количество предметов', 'соответствие комплектации заявленной', 'качество металла', 'качество ручек', 'люфты/зазоры', 'качество кейса', 'фиксаторы кейса', 'запах пластика/резины', 'отсутствие ржавчины/сколов', 'удобство извлечения инструментов из кейса', 'упаковку после доставки'],
    cargo: ['вес набора с упаковкой', 'габариты кейса/упаковки', 'количество наборов в транспортной коробке', 'вес транспортной коробки', 'габариты транспортной коробки', 'фото индивидуальной упаковки', 'фото транспортной коробки', 'есть ли острые предметы', 'как зафиксированы инструменты в кейсе', 'нужна ли усиленная упаковка'],
    redFlags: ['непонятная комплектация', 'неизвестен вес', 'неизвестны габариты', 'неподтверждён материал', 'нет фото раскрытого кейса', 'нет фото всех инструментов', 'низкое число заказов/слабый поставщик', 'риск несоответствия количества предметов'],
    seoAllowed: ['набор инструментов для дома', 'набор инструментов в кейсе', 'для бытового ремонта', 'для сборки мебели', 'для дачи/гаража, если подходит', 'комплектация зависит от выбранного SKU'],
    seoForbidden: ['профессиональный', 'сверхпрочный', 'неубиваемый', 'гарантия качества', 'закалённая сталь', 'сертифицированный', 'лучший', 'премиальный', ...DANGEROUS_CLAIMS],
    infographic: ['Набор инструментов общий вид', 'Кейс раскрытый', 'Инструменты крупно', 'Комплектация', 'Упаковка'],
    forbiddenCategoryWords: ['подошва', 'стелька', 'напряжение', 'мощность', 'тип вилки', 'срок годности', 'состав ткани'],
  },
  bag_accessory: genericRules('аксессуар'),
  home_textile: {
    mustAskSupplier: ['Подтвердите цену выбранного SKU.', 'Укажите состав ткани/наполнителя в процентах.', 'Пришлите размерную сетку/габариты изделия.', 'Укажите плотность/плотность наполнителя.', 'Есть ли усадка после стирки?', 'Укажите вес с упаковкой.', 'Пришлите реальные фото ткани, шва и упаковки.', 'Можно ли заказать 1–2 образца?'],
    beforeSample: ['подтвердить состав ткани/наполнителя', 'получить размеры', 'получить вес и упаковку', 'запросить фото ткани и шва'],
    onSample: ['состав и плотность ткани/наполнителя', 'швы и строчку', 'усадку после стирки', 'цветопередачу', 'запах после распаковки', 'упаковку'],
    cargo: ['вес с упаковкой', 'габариты индивидуальной упаковки', 'количество в транспортной коробке', 'материал/наполнитель для маркировки груза'],
    redFlags: ['не подтверждён состав ткани/наполнителя', 'нет размеров', 'сильная усадка', 'плохие швы', 'нет реальных фото'],
    seoAllowed: ['домашний текстиль', 'состав, если подтверждён', 'размер/комплект, если подтверждён'],
    seoForbidden: ['гипоаллергенный без документов', 'антибактериальный без документов', 'ортопедический без документов', ...DANGEROUS_CLAIMS],
    infographic: ['Домашний текстиль общий вид', 'Ткань/наполнитель крупно', 'Размер/комплект', 'Цвета', 'Упаковка'],
    forbiddenCategoryWords: ['мощность', 'напряжение', 'тип вилки', 'аккумулятор', 'подошва', 'стелька'],
  },
  beauty_accessory: {
    mustAskSupplier: ['Подтвердите цену выбранного SKU.', 'Подтвердите материал и покрытие изделия.', 'Контактирует ли изделие с кожей/волосами напрямую?', 'Укажите комплектацию.', 'Укажите вес с упаковкой.', 'Укажите габариты индивидуальной упаковки.', 'Пришлите реальные фото изделия и упаковки.', 'Можно ли заказать 1–2 образца?'],
    beforeSample: ['подтвердить материал/покрытие', 'уточнить контакт с кожей/волосами', 'получить вес и габариты', 'запросить фото изделия и упаковки'],
    onSample: ['качество материала/покрытия', 'острые края/заусенцы', 'запах после распаковки', 'комплектацию', 'вес и упаковку'],
    cargo: ['вес одной единицы с упаковкой', 'габариты индивидуальной упаковки', 'количество в транспортной коробке', 'материал для маркировки груза'],
    redFlags: ['не подтверждён материал/покрытие', 'острые края/заусенцы', 'резкий запах', 'нет реальных фото'],
    seoAllowed: ['аксессуар для красоты', 'материал, если подтверждён', 'сценарии использования'],
    seoForbidden: ['гипоаллергенный без документов', 'безопасный для кожи без документов', 'сертифицированный без документов', ...DANGEROUS_CLAIMS],
    infographic: ['Аксессуар общий вид', 'Материал/покрытие крупно', 'Комплектация', 'Цвета', 'Упаковка'],
    forbiddenCategoryWords: ['мощность', 'напряжение', 'тип вилки', 'подошва', 'стелька'],
  },
  pet_product: {
    mustAskSupplier: ['Подтвердите цену выбранного SKU.', 'Подтвердите материал и безопасность материала для животного.', 'Укажите размер/подходящий вес животного.', 'Укажите вес с упаковкой.', 'Укажите габариты индивидуальной упаковки.', 'Есть ли мелкие съёмные детали, которые животное может проглотить?', 'Пришлите реальные фото товара и упаковки.', 'Можно ли заказать 1–2 образца?'],
    beforeSample: ['подтвердить материал', 'уточнить размер/вес животного', 'получить вес и габариты', 'уточнить мелкие детали/риск проглатывания', 'запросить фото товара и упаковки'],
    onSample: ['прочность материала', 'мелкие детали и риск проглатывания', 'запах после распаковки', 'соответствие заявленному размеру', 'упаковку'],
    cargo: ['вес одной единицы с упаковкой', 'габариты индивидуальной упаковки', 'количество в транспортной коробке', 'материал для маркировки груза'],
    redFlags: ['не подтверждён материал', 'есть мелкие съёмные детали без подтверждения безопасности', 'нет размера/веса животного', 'нет реальных фото'],
    seoAllowed: ['товар для животных', 'материал, если подтверждён', 'размер/вес животного, если подтверждён'],
    seoForbidden: ['ветеринарный без документов', 'гипоаллергенный без документов', 'безопасный для животных без документов', ...DANGEROUS_CLAIMS],
    infographic: ['Товар для животных общий вид', 'Материал крупно', 'Размер/вес животного', 'Комплектация', 'Упаковка'],
    forbiddenCategoryWords: ['мощность', 'напряжение', 'тип вилки', 'подошва', 'стелька'],
  },
  toy: {
    mustAskSupplier: ['Подтвердите цену выбранного SKU.', 'Укажите рекомендуемый возраст.', 'Подтвердите материал.', 'Есть ли мелкие съёмные детали (риск проглатывания)?', 'Есть ли сертификаты безопасности игрушки?', 'Укажите вес с упаковкой.', 'Укажите габариты индивидуальной упаковки.', 'Пришлите реальные фото товара и упаковки.'],
    beforeSample: ['подтвердить материал', 'уточнить возрастную маркировку', 'уточнить мелкие детали/риск проглатывания', 'получить сертификаты безопасности', 'запросить фото товара и упаковки'],
    onSample: ['прочность материала', 'мелкие детали и риск проглатывания', 'острые края/заусенцы', 'запах после распаковки', 'возрастную маркировку', 'упаковку'],
    cargo: ['вес одной единицы с упаковкой', 'габариты индивидуальной упаковки', 'количество в транспортной коробке', 'батарейки/аккумулятор — уточнить'],
    redFlags: ['нет сертификатов безопасности', 'мелкие детали без подтверждения безопасности для возраста', 'нет возрастной маркировки', 'нет реальных фото'],
    seoAllowed: ['игрушка', 'материал, если подтверждён', 'рекомендуемый возраст, если подтверждён'],
    seoForbidden: ['безопасно для детей без документов', 'сертифицировано без документов', 'гипоаллергенный без документов', ...DANGEROUS_CLAIMS],
    infographic: ['Игрушка общий вид', 'Материал крупно', 'Возрастная маркировка', 'Комплектация', 'Упаковка'],
    forbiddenCategoryWords: ['мощность', 'напряжение', 'тип вилки', 'подошва', 'стелька'],
  },
  generic_product: genericRules('товар'),
};

function electricalRules(label: string): typeof KIND_RULES[ProductKind] {
  return {
    mustAskSupplier: [
      'Подтвердите цену выбранного SKU.',
      'Укажите напряжение (В) выбранного SKU.',
      'Укажите мощность (Вт) выбранного SKU.',
      'Какой тип вилки у выбранного SKU?',
      'Подтвердите совместимость с электросетью РФ/ЕАЭС.',
      'Есть ли сертификаты/декларации соответствия?',
      'Пришлите видео работы выбранного SKU.',
      'Пришлите инструкцию и фото маркировки/шильдика.',
      'Укажите вес и габариты упаковки выбранного SKU.',
    ],
    beforeSample: ['подтвердить напряжение/мощность/тип вилки', 'получить сертификаты/декларации', 'получить видео работы', 'запросить инструкцию и фото маркировки'],
    onSample: ['включается ли от нужного напряжения', 'реальную мощность', 'нагрев и наличие защиты от перегрева, если заявлена', 'запах при первом включении', 'качество кабеля и вилки', 'маркировку и шильдик', 'инструкцию', 'упаковку после доставки'],
    cargo: ['вес с упаковкой', 'габариты упаковки', 'напряжение', 'тип вилки/кабеля', 'аккумулятор или батарейка — уточнить', 'сертификаты для техники'],
    redFlags: ['нет данных по напряжению/мощности/вилке', 'нет сертификатов', 'нет видео работы', 'сильный запах при включении', 'защита от перегрева заявлена без подтверждения'],
    seoAllowed: [label, 'мощность и напряжение, если подтверждены', 'режимы работы, если подтверждены'],
    seoForbidden: ['защита от перегрева', 'быстрый нагрев', 'равномерный нагрев', 'энергосберегающий', 'влагозащищённый', ...DANGEROUS_CLAIMS],
    infographic: [label, 'Панель/режимы', 'Напряжение и мощность', 'Комплектация', 'Упаковка'],
    forbiddenCategoryWords: ['подошва', 'стелька', 'размерная сетка', 'срок годности', 'консистенция', 'состав ткани в процентах'],
  };
}

function genericRules(label: string) {
  return {
    mustAskSupplier: ['Подтвердите цену выбранного SKU.', 'Укажите вес с упаковкой.', 'Укажите габариты индивидуальной упаковки.', 'Подтвердите материал.', 'Подтвердите комплектацию.', 'Пришлите реальные фото товара и упаковки.', 'Укажите MOQ и срок отгрузки.', 'Можно ли заказать 1–2 образца?'],
    beforeSample: ['подтвердить цену SKU', 'получить вес и габариты', 'уточнить материал и комплектацию', 'запросить фото товара и упаковки'],
    onSample: ['соответствие выбранному SKU', 'качество материала', 'комплектацию', 'размеры', 'вес и упаковку', 'заявленные свойства'],
    cargo: ['вес одной единицы с упаковкой', 'габариты индивидуальной упаковки', 'количество в транспортной коробке', 'вес транспортной коробки', 'габариты транспортной коробки'],
    redFlags: ['нет веса/габаритов', 'не подтверждён материал', 'нет реальных фото', 'непонятная комплектация'],
    seoAllowed: [label, 'материал, если подтверждён', 'сценарии применения'],
    seoForbidden: DANGEROUS_CLAIMS,
    infographic: ['Главное фото товара', 'Материал и детали', 'Размер/формат', 'Комплектация', 'Упаковка'],
    forbiddenCategoryWords: [],
  };
}

function isBalaclavaProduct(product: any, intelligence?: any): boolean {
  const raw = `${product?.titleRu ?? ''} ${product?.titleEn ?? ''} ${product?.titleCn ?? ''} ${product?.categoryName ?? ''} ${JSON.stringify(product?.attributes ?? [])} ${JSON.stringify(intelligence ?? {})}`.toLowerCase();
  return /балаклав|подшлемник|balaclava|face\s*mask|面罩|头套|防晒面罩/.test(raw);
}

function productSpecificRules(kind: ProductKind, product: any, intelligence?: any): typeof KIND_RULES[ProductKind] {
  const base = KIND_RULES[kind] ?? KIND_RULES.generic_product;
  if (kind === 'clothing' && isBalaclavaProduct(product, intelligence)) {
    return {
      ...base,
      mustAskSupplier: [
        'Подтвердите цену выбранного SKU.',
        'Укажите вес одной балаклавы с индивидуальной упаковкой.',
        'Укажите размеры индивидуальной упаковки.',
        'Подтвердите состав ткани в процентах.',
        'Укажите точные размеры балаклавы: длина, ширина, растяжимость.',
        'Подтвердите, есть ли сетчатая зона для дыхания.',
        'Если заявлена УФ-защита, есть ли подтверждение или тест?',
        'Пришлите реальные фото выбранного цвета, фото на модели и фото упаковки.',
        'Можно ли заказать 1–2 образца перед партией?',
      ],
      beforeSample: ['подтвердить цену SKU', 'получить вес и габариты', 'подтвердить состав ткани в процентах', 'уточнить размеры и растяжимость', 'запросить фото на модели, бирки и упаковки'],
      onSample: ['комфорт дыхания через сетчатую зону', 'качество швов', 'растяжимость ткани', 'посадку на голове и лице', 'не давит ли в зоне носа и ушей', 'состав и плотность ткани', 'качество бирки/маркировки', 'упаковку'],
      cargo: ['вес одной балаклавы с упаковкой', 'габариты индивидуальной упаковки', 'количество штук в транспортной коробке', 'вес транспортной коробки', 'габариты транспортной коробки', 'фото индивидуальной и транспортной упаковки'],
      redFlags: ['не подтверждён состав ткани', 'нет размеров и растяжимости', 'сетчатая зона мешает дыханию', 'нет фото на модели', 'УФ-защита заявлена без подтверждения'],
      seoAllowed: ['для велосипеда, туризма и активного отдыха', 'закрывает голову, лицо и шею', 'сетчатая зона для дыхания, если подтверждена', 'несколько цветов'],
      seoForbidden: ['UPF50+ без документов', 'медицинская защита', 'профессиональная защита без подтверждения', '100% защита от солнца/пыли'],
      infographic: ['Балаклава для велосипеда и активного отдыха', 'Сетчатая зона для дыхания', 'Закрывает лицо и шею', 'Цвета', 'Размеры и упаковка'],
      forbiddenCategoryWords: ['подошва', 'стелька', 'тип вилки', 'мощность', 'напряжение', 'срок годности'],
    };
  }
  return base;
}

function array<T = any>(v: unknown): T[] { return Array.isArray(v) ? v as T[] : []; }
function record(v: unknown): Record<string, any> { return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {}; }
function clean(v: unknown): string { return String(v ?? '').replace(/\b(?:undefined|null|NaN|Infinity|-Infinity)\b/gi, '—').replace(/\s+/g, ' ').trim(); }
function safeRu(v: unknown): string { return clean(normalizeMixedProductText(v)).replace(/[一-鿿]+/g, '').replace(/\s+/g, ' ').trim(); }
function num(v: unknown): number | null { if (typeof v === 'number' && Number.isFinite(v)) return v; const n = Number(String(v ?? '').replace(',', '.').replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : null; }
function pos(v: unknown): number | null { const n = num(v); return n && n > 0 ? Math.round(n * 100) / 100 : null; }
function cny(v: number | null | undefined): string { return v && Number.isFinite(v) && v > 0 ? `${String(Math.round(v * 100) / 100).replace('.', ',')} ¥` : 'нужно уточнить'; }
function cnyDot(v: number | null | undefined): string { return v && Number.isFinite(v) && v > 0 ? `${String(Math.round(v * 100) / 100)} 元` : '需要确认'; }
function rub(v: number | null | undefined): string { return v && Number.isFinite(v) && v > 0 ? `${Math.round(v).toLocaleString('ru-RU')} ₽` : 'нужно уточнить'; }

const LATIN_TO_CYRILLIC_LOOKALIKE: Record<string, string> = {
  p: 'р', c: 'с', e: 'е', o: 'о', a: 'а', x: 'х', y: 'у', k: 'к', m: 'м', t: 'т',
  H: 'Н', B: 'В', C: 'С',
};

function fixMixedRuTypos(text: string): string {
  return String(text ?? '')
    .replace(/поставщpику/g, 'поставщику')
    .replace(/поставщpик/g, 'поставщик')
    .replace(/[pceoaxykmtHBC]/g, (m, offset, full) => {
      const before = full[offset - 1] || '';
      const after = full[offset + 1] || '';
      const cyrillicAround = /[А-Яа-яЁё]/.test(before) && /[А-Яа-яЁё]/.test(after);
      return cyrillicAround ? LATIN_TO_CYRILLIC_LOOKALIKE[m] ?? m : m;
    });
}

export function detectMixedCyrillicLatinInRussianText(text: string): boolean {
  const value = String(text ?? '');
  return /[А-Яа-яЁё][pceoaxykmtHBC][А-Яа-яЁё]/.test(value) || /[pceoaxykmtHBC][А-Яа-яЁё]{2,}|[А-Яа-яЁё]{2,}[pceoaxykmtHBC]/.test(value);
}

function normalizeDedupKey(value: string): string {
  let key = fixMixedRuTypos(value).toLowerCase()
    .replace(/[«»"'`]/g, '')
    .replace(/[?.!,:;]+$/g, '')
    .replace(/^\s*(?:[-•]|\d+[.)])\s*/, '')
    .replace(/ё/g, 'е')
    .replace(/sku|выбранного sku|одной единицы|товара|изделия|точный|точные|именно/gi, '')
    .replace(/индивидуальн(?:ой|ая|ую)\s+упаковк(?:и|а|у)/gi, 'упаковка')
    .replace(/транспортн(?:ой|ая|ую)\s+коробк(?:и|а|у)/gi, 'транспортная коробка')
    .replace(/с\s+упаковк(?:ой|и)/gi, 'с упаковкой')
    .replace(/габариты|размеры|размер/gi, 'габариты')
    .replace(/сертификаты|сертификатов|документы|документов/gi, 'сертификаты')
    .replace(/швы|качество швов/gi, 'швы')
    .replace(/\s+/g, ' ')
    .trim();
  if (/вес.*упаков|упаков.*вес/.test(key)) return 'вес одной единицы с упаковкой';
  if (/габарит.*упаков|упаков.*габарит/.test(key)) return 'габариты индивидуальной упаковки';
  if (/количеств.*транспорт.*короб|штук.*короб/.test(key)) return 'количество в транспортной коробке';
  if (/состав.*ткан/.test(key)) return 'состав ткани';
  if (/фото.*раскрыт.*кейс|раскрыт.*кейс.*фото/.test(key)) return 'фото раскрытого кейса';
  if (/реальн.*фото|фото.*модел|фото.*упаков|фото.*инструмент/.test(key)) return 'реальные фото выбранного sku и упаковки';
  if (/комплектац/.test(key)) return 'точный состав комплектации';
  if (/^материал\s*$/.test(key)) return 'материал товара';
  if (/уф|uv|upf/.test(key)) return 'подтверждение уф защиты';
  return key;
}

export function dedupNormalizedList(list: Array<string | null | undefined>, limit = 30): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const text = fixMixedRuTypos(clean(raw)).replace(/^\s*(?:[-•]|\d+[.)])\s*/, '').trim();
    if (!text || text === '—') continue;
    const key = normalizeDedupKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key); out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function uniq(list: Array<string | null | undefined>, limit = 30): string[] {
  return dedupNormalizedList(list, limit);
}

export function supplierTypeDisplay(value: unknown): string {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw || /unknown|неизвест|не указан/.test(raw)) return 'не указан';
  if (/factory|фабрик|工厂|厂家/.test(raw)) return 'фабрика';
  if (/merchant|провер|实力|供应商/.test(raw)) return 'проверенный продавец';
  if (/seller|store|shop|продав/.test(raw)) return 'продавец';
  return safeRu(value) || 'продавец';
}


function normalizeProductKind(value: unknown): ProductKind | null {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  const direct = raw.match(/footwear|clothing|towel_kilt|umbrella|sleep_mask|mini_washer|passive_insect_trap|usb_device|small_appliance|food_warmer|heating_appliance|kitchen_tool|tool_kit|bag_accessory|home_textile|beauty_accessory|pet_product|toy|generic_product/)?.[0];
  if (direct && direct in KIND_RULES) return direct as ProductKind;
  if (/зонт|umbrella|雨伞|雨傘|伞|傘/.test(raw)) return 'umbrella';
  if (/маск[аи]\s+для\s+сна|sleep\s*mask|眼罩|睡眠/.test(raw)) return 'sleep_mask';
  if (/мини[ -]?стирал|стиральн[а-яё ]*машин|washing\s*machine|洗衣机/.test(raw)) return 'mini_washer';
  if (/подогреватель\s+еды|грелка\s+для\s+еды|food\s*warmer|lunch\s*box.*(?:нагрев|heat)|暖菜|热饭|加热饭盒/.test(raw)) return 'food_warmer';
  if (/обогреватель|грелка|нагреватель|heating\s*pad|heater|电热|加热器|暖手/.test(raw)) return 'heating_appliance';
  if (/сабо|shoe|footwear|обув|тапоч|шл[её]пан|сандал|鞋|拖鞋|凉鞋/.test(raw)) return 'footwear';
  if (/полотенц[еа][ -]?килт|towel[_ -]?kilt/.test(raw)) return 'towel_kilt';
  if (/плед|одеял|подушк|постельн|шторы|home\s*textile|blanket|pillow|bedding/.test(raw)) return 'home_textile';
  if (/косметичк|для\s+макияжа|beauty|маникюр|расчёск|расческ/.test(raw)) return 'beauty_accessory';
  if (/для\s+животн|для\s+собак|для\s+кошек|pet\s*product|dog|cat\b/.test(raw)) return 'pet_product';
  if (/игрушк|toy\b|детск.*игр/.test(raw)) return 'toy';
  if (/балаклав|подшлемник|face\s*mask|одежд|clothing|clothes|плать|брюк|футбол|衣|裤|面罩|头套|防晒面罩/.test(raw)) return 'clothing';
  if (/usb|type-c|type c/.test(raw)) return 'usb_device';
  if (/насеком|insect|ловуш|粘虫|捕虫/.test(raw)) return 'passive_insect_trap';
  if (/набор\s+инструмент|hand\s*tool\s*set|tool\s*kit|工具套装|工具组|多功能工具/.test(raw)) return 'tool_kit';
  if (/кухон|kitchen/.test(raw)) return 'kitchen_tool';
  if (/сумк|bag|кошел|брелок/.test(raw)) return 'bag_accessory';
  if (/электр|220v|вилка|мощность|appliance|прибор/.test(raw)) return 'small_appliance';
  return null;
}

function detectKindByRules(product: any): ProductKind {
  const text = `${product?.titleRu ?? ''} ${product?.titleEn ?? ''} ${product?.titleCn ?? ''} ${product?.categoryName ?? ''} ${JSON.stringify(product?.attributes ?? [])}`.toLowerCase();
  return normalizeProductKind(text) ?? 'generic_product';
}

export function classifyProductKindConsensus(product: any, intelligence?: ProductIntelligence | any): ProductKindDecision {
  const rulesKind = detectKindByRules(product);
  const visionKind = normalizeProductKind(
    intelligence?.productIdentity?.productKind ??
    intelligence?.productIdentity?.categoryType ??
    intelligence?.identity?.productType ??
    intelligence?.identity?.productKind ??
    product?.productContext?.identity?.productType
  );
  const textKind = normalizeProductKind(
    `${intelligence?.cleanTitles?.titleForReport ?? ''} ${intelligence?.cleanTitles?.titleRuClean ?? ''} ${intelligence?.productIdentity?.coreObject ?? ''} ${product?.productContext?.titles?.cleanRu ?? ''}`
  );
  const votes = [visionKind, textKind, rulesKind].filter(Boolean) as ProductKind[];
  const tally = votes.reduce<Record<string, number>>((acc, k) => { acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
  const winner = (Object.entries(tally).sort((a,b) => b[1] - a[1])[0]?.[0] as ProductKind) || rulesKind;
  const agree = tally[winner] ?? 1;
  const disagreement = new Set(votes).size > 1;
  const confidence = Math.max(0.35, Math.min(0.98, agree >= 3 ? 0.96 : agree === 2 ? 0.86 : winner === rulesKind ? 0.72 : 0.68));
  return {
    productKind: winner,
    confidence,
    confidenceLabel: confidence >= 0.9 ? 'high' : confidence >= 0.75 ? 'medium' : 'low',
    visionKind,
    textKind,
    rulesKind,
    evidence: uniq([
      visionKind ? `vision/text LLM: ${visionKind}` : '',
      textKind ? `title/context: ${textKind}` : '',
      `rules: ${rulesKind}`,
      disagreement ? 'есть расхождение классификаторов' : 'классификаторы согласованы',
    ], 6),
    disagreement,
  };
}

function detectKind(product: any, intelligence?: ProductIntelligence | any): ProductKind {
  return classifyProductKindConsensus(product, intelligence).productKind;
}


const MATERIAL_MARKETING_ADJECTIVES = /\b(?:высококачественн(?:ая|ый|ое|ые|ой)|премиальн(?:ая|ый|ое|ые)|элитн(?:ая|ый|ое|ые)|супер|улучшенн(?:ая|ый|ое|ые))\s+/gi;

function stripMaterialMarketing(value: string): string {
  return clean(value.replace(MATERIAL_MARKETING_ADJECTIVES, '')).replace(/^./, c => c.toUpperCase());
}

function collectMaterials(product: any, intelligence: any, kind: ProductKind): string[] {
  const fromIntel = [...array<string>(intelligence?.productIdentity?.material), ...array<string>(intelligence?.productIdentity?.materials)];
  const attrs = array<any>(product?.attributes ?? product?.normalized1688?.attributes);
  const fromAttrs = attrs.filter(a => /материал|材质|面料|成分|material/i.test(String(a?.name ?? ''))).map(a => safeRu(a?.value));
  let items = uniq([...fromIntel, ...fromAttrs].map(safeRu).map(stripMaterialMarketing), 6).slice(0, 3);
  if (kind === 'umbrella') {
    const joined = items.join(' ').toLowerCase();
    const hasMetal = /желез|сплав|металл|iron|alloy|钢|铁|合金/i.test(joined + ' ' + JSON.stringify(product?.attributes ?? ''));
    items = ['ткань купола', hasMetal ? 'железо/сплав — подтвердить' : 'материал спиц — подтвердить'];
  }
  if (kind === 'tool_kit') {
    const joined = items.join(' ').toLowerCase();
    const metalMatch = /углеродист\w*\s+сталь|нержавеющ\w*\s+сталь|сплав|сталь/i.exec(joined);
    items = [metalMatch ? metalMatch[0] : 'металл'];
  }
  return items.length ? items : ['уточнить у поставщика'];
}

function collectSkuVariants(product: any): any[] {
  return array(product?.skus).length ? array(product.skus) : array(product?.normalized1688?.skuVariants);
}

function skuName(s: any): string {
  return safeRu(s?.name ?? s?.label ?? s?.skuName ?? s?.propertiesName ?? s?.raw ?? '').replace(/;\s*/g, ' · ');
}

function skuRawText(s: any): string {
  return String(s?.name ?? s?.label ?? s?.skuName ?? s?.propertiesName ?? s?.raw ?? '');
}

function skuPrice(s: any): number | null { return pos(s?.priceYuan ?? s?.price ?? s?.discountPrice ?? s?.salePrice); }

function extractColors(labels: string[]): string[] {
  const colors = ['чёрный','черный','белый','синий','голубой','зелёный','зеленый','жёлтый','желтый','розовый','красный','серый','фиолетовый','хаки','бежевый','коричневый','оранжевый'];
  return uniq(labels.flatMap(l => colors.filter(c => new RegExp(`(^|[^а-яё])${c}([^а-яё]|$)`, 'i').test(l))).map(c => c === 'черный' ? 'чёрный' : c === 'зеленый' ? 'зелёный' : c === 'желтый' ? 'жёлтый' : c), 12);
}

const PLUG_STANDARD_PATTERNS: Array<[RegExp, string]> = [
  [/韩规|韩国|корейский\s+стандарт|для\s+кореи/i, 'стандарт питания/вилка: Корея'],
  [/欧规|европейский\s+стандарт|eu\s*plug/i, 'стандарт питания/вилка: EU'],
  [/美规|американский\s+стандарт|us\s*plug/i, 'стандарт питания/вилка: US'],
  [/英规|британский\s+стандарт|uk\s*plug/i, 'стандарт питания/вилка: UK'],
  [/澳规|австралийский\s+стандарт|au\s*plug/i, 'стандарт питания/вилка: AU'],
  [/国标|китайский\s+стандарт|cn\s*plug/i, 'стандарт питания/вилка: CN'],
];

function extractPlugStandards(labels: string[]): string[] {
  const found = new Set<string>();
  for (const label of labels) {
    for (const [rx, value] of PLUG_STANDARD_PATTERNS) {
      if (rx.test(label)) found.add(value);
    }
  }
  return Array.from(found);
}

function extractAmbiguousParams(labels: string[], kind: ProductKind): string[] {
  if (kind === 'footwear') return [];
  const nums = labels.flatMap(l => Array.from(l.matchAll(/\b(?:8|16|40|120|\d{1,3})\b/g)).map(m => m[0]));
  return uniq(nums.filter(n => !/^20\d{2}$/.test(n)), 10);
}

function buildSkuProfile(product: any, kind: ProductKind, sourceUrl?: string): ProductProcurementProfile['sku'] {
  const variants = collectSkuVariants(product);
  const labels = variants.map(skuName).filter(Boolean);
  const rawLabels = variants.map(skuRawText).filter(Boolean);
  const colors = extractColors(labels);
  const plugStandards = extractPlugStandards(rawLabels);
  const ambiguousParams = extractAmbiguousParams(labels, kind);
  const sizeMatches = kind === 'footwear'
    ? uniq(labels.flatMap(l => Array.from(l.matchAll(/\b(?:3[5-9]|4[0-9])(?:[–-](?:3[5-9]|4[0-9]))?\b/g)).map(m => m[0])), 12)
    : [];
  const packageTypes = uniq(labels.filter(l => /opp|пакет|короб|box|袋|盒/i.test(l)).map(l => l.replace(/.*?(OPP|пакет|коробка|box|袋|盒).*/i, '$1')), 8);
  const packCounts = uniq(labels.flatMap(l => Array.from(l.matchAll(/\b\d+\s*(?:шт|pcs|件|个)\b/gi)).map(m => m[0])), 8);
  const dims: string[] = [];
  if (colors.length) dims.push('цвет');
  if (sizeMatches.length) dims.push('размер');
  if (plugStandards.length) dims.push('стандарт питания/вилка');
  if (ambiguousParams.length) dims.push(kind === 'tool_kit' ? 'комплектация/модель' : 'параметр SKU');
  if (!dims.length && variants.length > 1) dims.push('вариант');
  const count = variants.length || labels.length;
  const skuSummary = count
    ? `${count} ${pluralRu(count, 'вариант', 'варианта', 'вариантов')} · ${dims.join(' × ') || 'вариант'}`
    : 'SKU нужно уточнить';
  const normalizedExamples = labels.slice(0, 5).map(l => ambiguousParams.length ? l.replace(/\b(8|16|40|120)\b/g, kind === 'tool_kit' ? 'Комплектация $1' : 'Параметр $1') : l);
  const selected = makeSelectedSkuDecision(product, variants, sourceUrl);
  return {
    skuSummary,
    selectedSkuText: selected.selectedSkuText,
    selectedSkuReliable: selected.reliable,
    selectedSkuDecision: selected,
    dimensions: dims,
    colors,
    sizes: sizeMatches,
    models: [],
    plugStandards,
    packageTypes,
    packCounts,
    skuRisk: selected.reliable ? 'ok' : count > 1 ? 'needs_selection' : 'unknown',
    skuWarnings: uniq([
      !selected.reliable && count > 1 ? 'выбранный SKU не определён' : '',
      ambiguousParams.length
        ? (kind === 'tool_kit'
          ? `комплектации/параметры ${ambiguousParams.join(' / ')} — уточнить точный состав`
          : `значение параметров SKU ${ambiguousParams.join(' / ')} нужно уточнить`)
        : '',
    ], 4),
    normalizedExamples,
    ambiguousParams,
  };
}

export function makeSelectedSkuDecision(product: any, variants = collectSkuVariants(product), sourceUrl?: string): SelectedSkuDecision {
  const url = String(sourceUrl ?? product?.sourceUrl ?? product?.inputUrl ?? product?.url ?? '');
  const urlSku = url.match(/[?&](?:skuId|skuid|sku|specId)=([^&#]+)/i)?.[1];
  if (urlSku) {
    const found = variants.find((s: any) => String(s?.skuId ?? s?.id ?? s?.specId ?? s?.offerSkuId ?? '') === urlSku);
    if (found) return { selectedSkuText: skuName(found) || `SKU ${urlSku}`, selectedPriceYuan: skuPrice(found), reliable: true, reason: 'SKU взят из URL и найден в API.' };
  }
  if (variants.length === 1) return { selectedSkuText: skuName(variants[0]) || 'единственный SKU', selectedPriceYuan: skuPrice(variants[0]), reliable: true, reason: 'В карточке один SKU.' };
  const explicit = product?.selectedSku ?? product?.selectedSkuText ?? product?.selectedSkuName ?? product?.normalized1688?.pricing?.selectedSkuName;
  const explicitPrice = pos(product?.selectedSkuPriceYuan ?? product?.selectedSkuPrice ?? product?.normalized1688?.pricing?.selectedSkuPriceYuan);
  if (explicit) return { selectedSkuText: safeRu(explicit), selectedPriceYuan: explicitPrice, reliable: true, reason: 'SKU передан явно после выбора пользователя/URL.' };
  return { selectedSkuText: null, selectedPriceYuan: null, reliable: false, reason: variants.length > 1 ? 'В карточке несколько SKU, но выбранный SKU не подтверждён.' : 'SKU не найден в данных.' };
}

function buildPricing(product: any, selected: SelectedSkuDecision): ProductProcurementProfile['pricing'] {
  const variants = collectSkuVariants(product);
  const skuPrices = variants.map(skuPrice).filter((v): v is number => !!v);
  const min = pos(product?.priceRange?.min ?? product?.minPriceYuan) ?? (skuPrices.length ? Math.min(...skuPrices) : pos(product?.priceYuan ?? product?.price));
  const max = pos(product?.priceRange?.max ?? product?.maxPriceYuan) ?? (skuPrices.length ? Math.max(...skuPrices) : min);
  const selectedPrice = selected.selectedPriceYuan ?? (selected.reliable ? pos(product?.priceYuan ?? product?.price) : null);
  const displayPriceText = selectedPrice
    ? `${cny(selectedPrice)} ≈ ${rub(Math.round(selectedPrice * YUAN_TO_RUB))}`
    : min && max && min !== max
      ? `${String(min).replace('.', ',')}–${String(max).replace('.', ',')} ¥`
      : min
        ? cny(min)
        : 'нужно уточнить';
  return {
    displayPriceText,
    selectedPriceYuan: selectedPrice,
    minPriceYuan: min,
    maxPriceYuan: max,
    priceSource: selectedPrice ? 'selected_sku' : skuPrices.length ? 'sku_range' : min ? 'price_range' : 'missing',
    priceReliable: !!selectedPrice || (!!min && !!max),
    priceWarnings: uniq([!selected.reliable ? 'цена выбранного SKU требует подтверждения' : '', !min ? 'нет цены в данных' : ''], 4),
  };
}

function buildQuestions(profileBase: Pick<ProductProcurementProfile, 'identity'|'sku'|'pricing'>, rules: typeof KIND_RULES[ProductKind]): string[] {
  const priceText = profileBase.sku.selectedSkuReliable && profileBase.pricing.selectedPriceYuan ? cny(profileBase.pricing.selectedPriceYuan) : 'цену выбранного SKU';
  const params = profileBase.sku.ambiguousParams;
  const base = rules.mustAskSupplier.map(q => q
    .replace('Подтвердите цену выбранного SKU.', priceText.includes('¥') ? `Подтвердите цену выбранного SKU: ${priceText}.` : 'Подтвердите цену выбранного SKU.')
    .replace('Укажите вес с упаковкой.', 'Укажите вес с упаковкой выбранного SKU.')
  );
  const alreadyAsksComposition = rules.mustAskSupplier.some(q => /комплектац/i.test(q));
  const merged = params.length && !alreadyAsksComposition ? [
    ...base.filter(q => !/Что означает параметр|параметр SKU/i.test(q)),
    `Что означают параметры SKU ${params.join(' / ')}: диаметр, длина, размер, комплектация или другой параметр?`,
  ] : base;
  const priority: Array<RegExp> = [/цен(?:а|у|ы|е|ой|у выбранного)/i, /вес/i, /габарит|размер.*упаков|упаков.*размер/i, /состав/i, /точн.*размер|длина|ширина|растяж/i, /сетчат|дыхани/i, /уф|uv|upf/i, /фото/i, /образец/i, /параметр/i, /диаметр/i, /спиц/i, /чехол/i, /материал/i, /комплектац/i, /moq/i];
  const rank = (q: string) => { const i = priority.findIndex(rx => rx.test(q)); return i < 0 ? 999 : i; };
  return uniq(merged, 14).sort((a, b) => rank(a) - rank(b)).slice(0, 9);
}


function buildKindVerdict(kind: ProductKind, product: any, needsSupplierData: boolean): string {
  if (kind === 'clothing' && isBalaclavaProduct(product)) {
    return 'Товар можно рассматривать для образца, но партию закупать рано. Сначала подтвердите состав ткани, размеры, посадку, упаковку и заявленную УФ-защиту. На образце важно проверить комфорт дыхания, швы, растяжимость и посадку на голове/лице.';
  }
  if (kind === 'umbrella') {
    return 'Товар можно рассматривать для образца, но партию закупать рано. Сначала подтвердите механизм, спицы, материал купола, наличие чехла, размер в сложенном/раскрытом виде и заявленную UPF-защиту.';
  }
  if (kind === 'footwear') {
    return 'Товар можно рассматривать для образца, но партию закупать рано. Сначала подтвердите длину стельки, размерность, материал, запах EVA/PU, качество литья/склейки и упаковку.';
  }
  if (kind === 'sleep_mask') {
    return 'Товар можно рассматривать для образца, но партию закупать рано. Сначала подтвердите материал, 3D-форму, затемнение, ремешок, упаковку и комфорт при носке.';
  }
  if (kind === 'mini_washer') {
    return 'Товар можно рассматривать для образца, но партию закупать рано. Сначала подтвердите мощность, напряжение, тип вилки, слив, режимы работы, инструкцию и видео работы.';
  }
  if (kind === 'small_appliance' || kind === 'food_warmer' || kind === 'heating_appliance') {
    return 'Товар можно рассматривать только после проверки технических характеристик. Перед образцом нужно подтвердить напряжение, мощность, тип вилки, сертификаты и видео работы. Партию закупать рано.';
  }
  if (kind === 'home_textile') {
    return 'Товар можно рассматривать для образца, но партию закупать рано. Сначала подтвердите состав ткани/наполнителя, размеры, вес и упаковку. На образце проверить швы, усадку после стирки и запах.';
  }
  if (kind === 'beauty_accessory') {
    return 'Товар можно рассматривать для образца, но партию закупать рано. Сначала подтвердите материал/покрытие, контакт с кожей/волосами, вес и упаковку. На образце проверить края, покрытие и запах.';
  }
  if (kind === 'pet_product') {
    return 'Товар можно рассматривать для образца, но партию закупать рано. Сначала подтвердите материал, размер/вес животного и безопасность мелких деталей. На образце проверить прочность и риск проглатывания деталей.';
  }
  if (kind === 'toy') {
    return 'Товар нельзя закупать партией без проверки безопасности. Перед образцом нужно подтвердить возрастную маркировку, сертификаты безопасности и мелкие детали. На образце проверить прочность, острые края и запах.';
  }
  if (kind === 'tool_kit') {
    return 'Товар нельзя закупать партией без проверки образца. Сначала подтвердите точный состав комплектации, материал металлических частей и ручек, вес и габариты кейса. На образце проверьте фактическую комплектацию, качество металла, ручек, кейса и фиксаторов.';
  }
  return needsSupplierData
    ? 'Товар можно рассматривать для образца, но партию закупать рано. Сначала подтвердите выбранный SKU, цену, вес, упаковку, материал и реальные фото.'
    : 'Можно готовить заказ образца. Партию закупать только после проверки образца и упаковки.';
}

export function buildProductProcurementProfile(product: any, opts: { sourceUrl?: string; intelligence?: ProductIntelligence | any } = {}): ProductProcurementProfile {
  const intelligence = opts.intelligence ?? product?.procurementProfileSourceIntelligence ?? product?.productIntelligence ?? product?.intelligence ?? product?.productContext?.productIntelligence ?? {};
  const aiDraft = record(product?.productProcurementProfileDraft ?? product?.procurementProfileDraft ?? product?.productContext?.procurementProfileDraft ?? product?.productContext?.profileDraft);
  const classifier = classifyProductKindConsensus(product, intelligence);
  const draftKind = normalizeProductKind(record(aiDraft.identity).productKind ?? aiDraft.productKind);
  const kind = draftKind ?? classifier.productKind;
  const rules = productSpecificRules(kind, product, intelligence);
  const sourceUrl = opts.sourceUrl ?? product?.sourceUrl ?? product?.inputUrl;
  const sku = buildSkuProfile(product, kind, sourceUrl);
  const pricing = buildPricing(product, sku.selectedSkuDecision);
  const materials = collectMaterials(product, intelligence, kind);
  const identity = record(intelligence?.productIdentity);
  const cleanTitles = record(intelligence?.cleanTitles);
  const draftIdentity = record(aiDraft.identity);
  const titleForReport = safeRu(draftIdentity.titleForReport || cleanTitles.titleForReport || cleanTitles.titleRuClean || identity.shortNameRu || identity.marketNameRu || product?.titleRu || product?.titleEn || product?.titleCn || 'Товар 1688');
  const titleForSeo = safeSeoTitle(safeRu(draftIdentity.titleForSeo || cleanTitles.titleForWb || product?.seoContent?.titleRu || titleForReport), kind);
  const missing = uniq([...(pricing.priceReliable ? [] : ['цена выбранного SKU']), ...(product?.weightKg ? [] : ['вес с упаковкой']), ...(sku.selectedSkuReliable ? [] : ['выбранный SKU']), ...array<string>(intelligence?.dataQuality?.missingCriticalFields)], 8);
  const baseProfile = {
    identity: {
      productKind: kind,
      categoryType: safeRu(identity.categoryType || product?.categoryType || kind),
      subCategoryType: safeRu(identity.subCategoryType || ''),
      titleForReport,
      titleForSeo,
      shortTitle: safeRu(identity.shortNameRu || titleForReport),
      coreObject: safeRu(identity.coreObject || titleForReport),
      formFactor: safeRu(draftIdentity.formFactor || identity.formFactor || ''),
      audience: safeRu(draftIdentity.audience || identity.audience || ''),
      gender: safeRu(draftIdentity.gender || identity.gender || ''),
      season: safeRu(draftIdentity.season || identity.season || ''),
      useCases: uniq([...array<string>(draftIdentity.useCases), ...array<string>(identity.useCases)].map(safeRu), 6),
      materials: uniq([...array<string>(draftIdentity.materials).map(safeRu), ...materials], 6),
      visibleFeatures: uniq([...array<string>(draftIdentity.visibleFeatures), ...array<string>(identity.visibleFeatures)].map(safeRu), 8),
      claimedFeatures: uniq([...array<string>(draftIdentity.claimedFeatures), ...array<string>(identity.importantFeatures), ...array<string>(intelligence?.claimsPolicy?.claimedButNeedProof)].map(safeRu), 8),
      unconfirmedFeatures: uniq([...array<string>(draftIdentity.unconfirmedFeatures), ...array<string>(identity.notConfirmedFeatures), ...array<string>(identity.unconfirmedFeatures)].map(safeRu), 8),
    },
    sku,
    pricing,
  } as Pick<ProductProcurementProfile, 'identity'|'sku'|'pricing'>;
  const draftProcurement = record(aiDraft.procurement);
  const mustAskSupplier = uniq([...array<string>(draftProcurement.mustAskSupplier).map(safeRu), ...buildQuestions(baseProfile, rules)], 10).slice(0, 9);
  const images = collectProductIntelligenceImages(product, 3);
  const supplierRaw = product?.supplierType ?? product?.normalized1688?.supplierType ?? product?.normalized1688?.debug?.sellerType;
  return {
    ...baseProfile,
    supplier: {
      displayType: supplierTypeDisplay(supplierRaw),
      rating: clean(product?.supplierRating ?? product?.rating ?? '—') || '—',
      orders: clean(product?.sold ?? product?.orders ?? '—') || '—',
      name: safeRu(product?.supplierName || ''),
    },
    procurement: {
      status: missing.length ? '🟡 Нужны данные поставщика' : '🟢 Готов к заказу образца',
      verdict: buildKindVerdict(kind, product, missing.length > 0),
      nextAction: 'Отправьте вопросы поставщику и скачайте закупочный пакет.',
      mustAskSupplier,
      mustCheckBeforeSample: uniq([...array<string>(draftProcurement.mustCheckBeforeSample).map(safeRu), ...rules.beforeSample], 8),
      mustCheckOnSample: uniq([...array<string>(draftProcurement.mustCheckOnSample).map(safeRu), ...rules.onSample], 12),
      redFlags: uniq([...array<string>(draftProcurement.redFlags).map(safeRu), ...rules.redFlags, ...array<string>(intelligence?.reportRules?.riskFlags).map(safeRu)], 12),
    },
    cargo: {
      mustAsk: uniq(['вес одной единицы с упаковкой', 'габариты индивидуальной упаковки', 'количество в транспортной коробке', 'вес транспортной коробки', 'габариты транспортной коробки', 'фото индивидуальной упаковки', 'фото транспортной коробки', 'материал товара', 'ограничения по перевозке', ...rules.cargo], 14),
      likelySensitiveCargoIssues: uniq(kind === 'mini_washer' || kind === 'small_appliance' || kind === 'usb_device' ? ['питание/вилка/напряжение', 'аккумулятор или батарейка — уточнить', 'сертификаты для техники'] : [], 6),
    },
    content: {
      seoAllowedClaims: uniq([...array<string>(record(aiDraft.content).seoAllowedClaims).map(safeRu), ...rules.seoAllowed, ...array<string>(intelligence?.reportRules?.seoAllowedClaims).map(safeRu)], 12),
      seoForbiddenClaims: uniq([...array<string>(record(aiDraft.content).seoForbiddenClaims).map(safeRu), ...rules.seoForbidden, ...array<string>(intelligence?.reportRules?.seoForbiddenClaims).map(safeRu), ...DANGEROUS_CLAIMS], 18),
      titleWarnings: dangerousClaims(titleForSeo).map(c => `Не писать в названии без подтверждения: ${c}`),
      infographicIdeas: uniq([...array<string>(record(aiDraft.content).infographicIdeas).map(safeRu), ...rules.infographic, ...array<string>(intelligence?.reportRules?.infographicIdeas).map(safeRu)], 7),
    },
    dataQuality: {
      missingCriticalFields: missing,
      contradictions: uniq([...(sku.selectedSkuReliable ? [] : ['выбранный SKU не подтверждён']), ...array<any>(product?.productContext?.conflicts).map((c: any) => safeRu(c.field || c.message || c))], 8),
      confidence: (['high','medium','low'].includes(String(intelligence?.dataQuality?.overallConfidence)) ? intelligence.dataQuality.overallConfidence : missing.length > 3 ? 'low' : 'medium') as any,
      reason: safeRu(intelligence?.dataQuality?.reason || `Профиль собран из Product Intelligence v2, selected SKU, цены, поставщика, атрибутов и ${images.length ? 'фото' : 'текстовых данных'} 1688. Уверенность классификации: ${classifier.confidenceLabel}.`),
    },
    classifier,
    intelligenceImages: images,
    supplierQuestionsCn: array<string>(record(draftProcurement).supplierQuestionsCn).map(safeRu),
    supplierQuestionsCnValid: false,
  };
}

export function ensureProductProcurementProfile(product: any, opts: { sourceUrl?: string } = {}): ProductProcurementProfile {
  const existing = product?.productProcurementProfile ?? product?.procurementProfile;
  if (existing?.identity?.productKind && existing?.procurement?.mustAskSupplier?.length) return existing as ProductProcurementProfile;
  const profile = buildProductProcurementProfile(product, opts);
  if (product && typeof product === 'object') {
    product.productProcurementProfile = profile;
    product.procurementProfile = profile;
  }
  return profile;
}

export function collectProductIntelligenceImages(product: any, limit = 3): ProductIntelligenceImage[] {
  const variants = collectSkuVariants(product);
  const selectedName = String(product?.selectedSkuName ?? product?.selectedSkuText ?? product?.normalized1688?.pricing?.selectedSkuName ?? '').trim();
  const selectedVariant = selectedName
    ? variants.find((s: any) => skuName(s).toLowerCase() === selectedName.toLowerCase() || String(s?.name ?? '').toLowerCase() === selectedName.toLowerCase())
    : null;
  const selectedImage = clean(product?.selectedSkuImage ?? product?.selectedSkuImageUrl ?? selectedVariant?.image ?? selectedVariant?.imageUrl ?? '');
  const rawImages = array<string>(product?.images ?? product?.imageUrls ?? product?.normalized1688?.images).filter(Boolean);
  const mainImage = clean(product?.mainImageUrl) || rawImages[0] || '';
  const candidates: ProductIntelligenceImage[] = [];
  if (selectedImage) candidates.push({ url: selectedImage, role: 'selected_sku_image', note: 'Фото выбранного SKU; использовать только для типа товара, формы и видимых деталей.' });
  if (mainImage) candidates.push({ url: mainImage, role: 'main_product_image', note: 'Главное фото карточки; цена, MOQ, остатки и SKU берутся только из API.' });
  for (const url of rawImages) {
    if (!url || candidates.some(img => img.url === url)) continue;
    candidates.push({ url, role: candidates.length < 2 ? 'detail_image' : 'package_image', note: 'Дополнительное фото карточки для проверки видимых деталей.' });
    if (candidates.length >= limit) break;
  }
  const seen = new Set<string>();
  return candidates.filter(img => { if (!img.url || seen.has(img.url)) return false; seen.add(img.url); return true; }).slice(0, limit);
}

export function preprocessMainImageForProductIntelligence(product: any): { url: string | null; role: string; note: string; images: ProductIntelligenceImage[] } {
  const images = collectProductIntelligenceImages(product, 3);
  const first = images[0];
  return { url: first?.url ?? null, role: first?.role ?? 'main_product_image', note: first?.note ?? 'Главное фото не найдено.', images };
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function safeSeoTitle(title: string, kind: ProductKind): string {
  let out = fixMixedRuTypos(title || KIND_RULES[kind]?.seoAllowed?.[0] || 'Товар 1688');
  for (const claim of DANGEROUS_CLAIMS) out = out.replace(new RegExp(escapeRegExp(claim), 'gi'), '').trim();
  if (/балаклав|подшлемник/i.test(out)) return 'Балаклава защитная от солнца и ветра для велосипеда и активного отдыха';
  if (kind === 'umbrella' && /зонт/i.test(out) && !/крюч|чехол/i.test(out)) out = 'Зонт автоматический складной с крючком и чехлом';
  if (kind === 'tool_kit') out = 'Набор инструментов для дома в кейсе';
  return out.replace(/\s{2,}/g, ' ').trim() || 'Товар 1688';
}

function dangerousClaims(text: string): string[] { return DANGEROUS_CLAIMS.filter(c => new RegExp(escapeRegExp(c), 'i').test(text)); }
function pluralRu(n: number, one: string, few: string, many: string): string { const v = Math.abs(n) % 100; const v1 = v % 10; if (v > 10 && v < 20) return many; if (v1 > 1 && v1 < 5) return few; if (v1 === 1) return one; return many; }

const MATERIAL_SUFFIX_BY_KIND: Partial<Record<ProductKind, string>> = {
  tool_kit: 'подтвердить марку стали и материал ручек',
};

function materialsDisplayLine(p: Pick<ProductProcurementProfile, 'identity'>): string {
  const joined = p.identity.materials.slice(0, 3).join(', ');
  if (!joined || /уточнить/i.test(joined)) return 'уточнить у поставщика';
  if (/подтверд/i.test(joined)) return joined;
  return `${joined} — ${MATERIAL_SUFFIX_BY_KIND[p.identity.productKind] ?? 'подтвердить'}`;
}

function formatPriceLine(pricing: ProductProcurementProfile['pricing']): string {
  if (pricing.selectedPriceYuan) {
    return `${cny(pricing.selectedPriceYuan)} ≈ ${rub(Math.round(pricing.selectedPriceYuan * YUAN_TO_RUB))}`;
  }
  if (pricing.minPriceYuan && pricing.maxPriceYuan && pricing.minPriceYuan !== pricing.maxPriceYuan) {
    return `${String(pricing.minPriceYuan).replace('.', ',')}–${String(pricing.maxPriceYuan).replace('.', ',')} ¥`;
  }
  if (pricing.minPriceYuan) return cny(pricing.minPriceYuan);
  return 'нужно уточнить';
}

export function formatSelectedSkuLine(kind: ProductKind, sku: ProductProcurementProfile['sku'], pricing: ProductProcurementProfile['pricing']): string {
  if (!sku.selectedSkuText) {
    return sku.selectedSkuReliable
      ? 'не определён'
      : `не определён. ${pricing.minPriceYuan && pricing.maxPriceYuan ? `Цена по SKU: ${String(pricing.minPriceYuan).replace('.', ',')}${pricing.maxPriceYuan !== pricing.minPriceYuan ? `–${String(pricing.maxPriceYuan).replace('.', ',')}` : ''} ¥.` : 'Нужен выбор SKU.'}`;
  }
  if (kind === 'tool_kit') {
    const modelNumber = sku.selectedSkuText.match(/\d{2,5}/)?.[0];
    return `набор ${modelNumber ?? sku.selectedSkuText} — состав нужно подтвердить`;
  }
  return pricing.selectedPriceYuan ? `${sku.selectedSkuText} — ${cny(pricing.selectedPriceYuan)}` : sku.selectedSkuText;
}

function selectedSkuShortLabel(kind: ProductKind, sku: ProductProcurementProfile['sku']): string {
  if (!sku.selectedSkuText) return 'самый массовый/целевой SKU после подтверждения у поставщика';
  if (kind === 'tool_kit') {
    const modelNumber = sku.selectedSkuText.match(/\d{2,5}/)?.[0];
    return modelNumber ? `набор ${modelNumber}` : sku.selectedSkuText;
  }
  return sku.selectedSkuText;
}

export function buildMainReportFromProfile(product: any, statusInfo?: { creditsRemaining?: number }, opts: { sourceUrl?: string } = {}): string {
  const p = ensureProductProcurementProfile(product, opts);
  const priceYuan = p.pricing.selectedPriceYuan ?? p.pricing.minPriceYuan;
  const purchaseRub = priceYuan ? Math.round(priceYuan * YUAN_TO_RUB) : null;
  const costWithoutCargo = purchaseRub ? Math.round(purchaseRub * (1 + BANK_MARKUP) + FULFILLMENT_RUB) : null;
  const moq = pos(product?.moq ?? product?.normalized1688?.moq);
  const weight = pos(product?.weightKg ?? product?.packedWeightKg);
  const lines = [
    `📦 <b>${escapeHtml(p.identity.titleForReport)}</b>`,
    '',
    'Источник: 1688',
    `Поставщик: ${escapeHtml(p.supplier.displayType)}${p.supplier.rating && p.supplier.rating !== '—' ? ` · рейтинг ${escapeHtml(p.supplier.rating)}` : ''}${p.supplier.orders && p.supplier.orders !== '—' ? ` · заказов ${escapeHtml(p.supplier.orders)}` : ''}`,
    '',
    '📌 <b>Товар</b>',
    `• Цена: ${escapeHtml(p.pricing.displayPriceText)}`,
    `• Выбранный SKU: ${escapeHtml(formatSelectedSkuLine(p.identity.productKind, p.sku, p.pricing))}`,
    `• MOQ: ${moq ? `${Math.round(moq)} шт` : 'уточнить'}`,
    `• SKU: ${escapeHtml(p.sku.skuSummary)}`,
    p.sku.colors.length ? `• Цвета: ${escapeHtml(p.sku.colors.join(', '))}` : '',
    p.sku.sizes.length ? `• Размеры: ${escapeHtml(p.sku.sizes.join(', '))}` : (p.sku.ambiguousParams.length ? (p.identity.productKind === 'tool_kit' ? `• Комплектации/параметры: ${escapeHtml(p.sku.ambiguousParams.join(' / '))} — уточнить точный состав` : `• Параметры: ${escapeHtml(p.sku.ambiguousParams.join(' / '))} — значение нужно уточнить`) : ''),
    p.sku.plugStandards.length ? `• Стандарт питания/вилка: ${escapeHtml(p.sku.plugStandards.join(', '))}` : '',
    `• Материал: ${escapeHtml(materialsDisplayLine(p))}`,
    `• Вес: ${weight ? `${weight} кг` : 'не указан'}`,
    '',
    '<b>🟡 Статус: нужны данные поставщика</b>',
    '',
    '⚠️ <b>Что уточнить</b>',
    ...p.procurement.mustAskSupplier.slice(0, 5).map(q => `• ${escapeHtml(q)}`),
    '',
    '💸 <b>Предварительная себестоимость</b>',
    `• Закупка: ${priceYuan ? `${cny(priceYuan)} ≈ ${rub(purchaseRub)}` : 'нужно уточнить'}`,
    `• Без карго: ${costWithoutCargo ? `~${rub(costWithoutCargo)}` : 'нужно уточнить'}`,
    '• Карго: нужен вес с упаковкой',
    '',
    '📁 <b>Закупочный пакет готов</b>',
    '• вопросы поставщику',
    '• ТЗ байеру',
    '• ТЗ карго',
    '• чек-лист образца',
    '• SEO-черновик',
    '• фото товара',
    '',
    '🎯 <b>Вывод</b>',
    escapeHtml(p.procurement.verdict),
    '',
    '<b>Что сделать:</b>',
    '1. Нажмите «💬 Вопросы поставщику».',
    '2. Отправьте текст поставщику в чат 1688.',
    '3. Скачайте закупочный пакет.',
  ].filter(Boolean);
  return lines.join('\n');
}

function escapeHtml(v: unknown): string { return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

export function validateProfile(profile: ProductProcurementProfile): { ok: boolean; errors: string[]; fixedProfile: ProductProcurementProfile } {
  const errors: string[] = [];
  if (!profile.identity.titleForReport) errors.push('titleForReport empty');
  if (!profile.identity.productKind) errors.push('productKind empty');
  if (!profile.procurement.mustAskSupplier.length) errors.push('mustAskSupplier empty');
  if (!profile.procurement.mustCheckOnSample.length) errors.push('mustCheckOnSample empty');
  const ruFields = JSON.stringify([profile.identity, profile.procurement, profile.cargo, profile.content]);
  if (/[一-鿿]/.test(ruFields)) errors.push('raw Chinese in RU fields');
  if (dangerousClaims(profile.identity.titleForSeo).length) errors.push('dangerous claim in titleForSeo');
  return { ok: errors.length === 0, errors, fixedProfile: profile };
}

export function validateMainReport(text: string): { ok: boolean; errors: string[]; fixedText: string } {
  const errors: string[] = [];
  let fixed = fixMixedRuTypos(text);
  if (/Product Intelligence|AI-черновик|debug/i.test(fixed)) errors.push('internal text');
  if (/[一-鿿]/.test(fixed)) errors.push('raw Chinese');
  if (/0(?:[,.]0+)?\s*[₽¥￥]/.test(fixed)) errors.push('zero money');
  if (/\b(?:seller|factory|merchant)\b/i.test(fixed)) errors.push('english supplier type');
  if (/ориентир\s+0[,.]\d+\s*кг|category default/i.test(fixed)) errors.push('category default weight');
  if (/Цена:\s*Выбранный SKU/i.test(fixed)) errors.push('price mixed with selected sku line');
  if (/черновик карточки на основе данных 1688/i.test(fixed)) errors.push('internal seo boilerplate');
  fixed = fixed.replace(/\bseller\b/gi, 'продавец').replace(/\bmerchant\b/gi, 'проверенный продавец').replace(/\bfactory\b/gi, 'фабрика');
  fixed = fixed.replace(/0(?:[,.]0+)?\s*[₽¥￥]/g, 'нужно уточнить');
  fixed = fixed.replace(/Цена:\s*Выбранный SKU:\s*/gi, 'Цена: ');
  return { ok: errors.length === 0, errors, fixedText: fixed };
}

export function validateCnQuestions(ru: string[], cn: string[]): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!cn.length) errors.push('CN empty');
  if (cn.length !== ru.length) errors.push('CN count differs');
  if (cn.length > 10) errors.push('too many CN questions');
  const joined = cn.join('\n');
  if (/[А-Яа-яЁё]/.test(joined)) errors.push('Cyrillic in CN');
  if (/file:\/\//i.test(joined)) errors.push('file url');
  if (/\b(?:material|размерная сетка|вес|габарит|цвет|поставщик)\b/i.test(joined)) errors.push('language mix');
  if (/\d+,\d+\s*元/.test(joined)) errors.push('comma decimal');
  if (/\d+[.)]\s*\d+[.)]/.test(joined)) errors.push('nested numbering');
  return { ok: errors.length === 0, errors };
}

function translateQuestionToCn(q: string): string {
  const lower = q.toLowerCase();
  const price = q.match(/(\d+(?:[,.]\d+)?)\s*¥/)?.[1]?.replace(',', '.');
  const params = q.match(/SKU\s+([\d\s/]+)/i)?.[1]?.replace(/\s+/g, ' ').trim();
  if (/цен/.test(lower)) return `请确认所选SKU的价格${price ? `：${price} 元` : ''}。`;
  if (/напряжени/.test(lower)) return '请提供所选SKU的电压（V）。';
  if (/мощност/.test(lower)) return '请提供所选SKU的功率（W）。';
  if (/тип вилки|вилк/.test(lower)) return '请说明所选SKU的插头类型。';
  if (/электросет|еаэс|рф/.test(lower)) return '请确认产品是否兼容俄罗斯/欧亚经济联盟电网标准。';
  if (/сертификат|декларац/.test(lower)) return '是否有产品合格证书或声明？请提供。';
  if (/видео/.test(lower)) return '请发送所选SKU的实际使用视频。';
  if (/маркировк|шильдик|инструкц/.test(lower)) return '请发送产品说明书和铭牌标签的实拍图。';
  if (/вес/.test(lower)) return '请提供所选SKU含包装的重量。';
  if (/габарит|размер.*упаков/.test(lower)) return '请提供单件包装尺寸。';
  if (/состав ткан/.test(lower)) return '请确认面料成分百分比。';
  if (/усадк/.test(lower)) return '请确认洗涤后是否会缩水。';
  if (/размерн(?:ая|ую) сетк/.test(lower)) return '请提供尺码表。';
  if (/возраст/.test(lower)) return '请确认产品适用的儿童年龄段。';
  if (/съёмные детали|проглат/.test(lower)) return '产品是否有可拆卸小零件（存在误吞风险）？';
  if (/животн/.test(lower)) return '请确认产品适合的宠物体型/体重。';
  if (/параметр/.test(lower)) return `请说明SKU参数${params ? ` ${params}` : ''}分别代表什么：伞面直径、折叠长度、数量规格还是其他参数？`;
  if (/длин/.test(lower)) return '请提供产品折叠后的长度。';
  if (/диаметр/.test(lower)) return '请提供展开后的尺寸或直径。';
  if (/материал/.test(lower)) return '请确认产品材料和关键部件材料。';
  if (/спиц/.test(lower)) return '请确认所选SKU的伞骨数量。';
  if (/чехол/.test(lower)) return '是否包含收纳套？请发送产品打开、折叠状态和包装的实拍图。';
  if (/раскрыт.*кейс|кейс.*раскрыт/.test(lower)) return '请发送打开的工具箱和所有工具的实拍图（近景）。';
  if (/штрихкод/.test(lower)) return '请发送包装、标签和条形码的实拍图（如有）。';
  if (/замен\w*.*брак|брак\w*.*замен/.test(lower)) return '如果产品有质量问题，是否可以更换？';
  if (/фото/.test(lower)) return '请发送产品实拍图（含包装）。';
  if (/комплектац/.test(lower)) return '请确认所选SKU的完整配置。';
  if (/moq|минимальн/.test(lower)) return '请确认最小起订量和发货时间。';
  if (/образц|образец/.test(lower)) return '是否可以先购买1-2件样品？';
  return '请确认该问题中的相关产品信息。';
}

export function buildSupplierQuestionsFromProfile(product: any, opts: { sourceUrl?: string } = {}): SupplierQuestionsProfileResult {
  const profile = ensureProductProcurementProfile(product, opts);
  const ru = uniq(profile.procurement.mustAskSupplier, 10).slice(0, 10);
  const savedCn = profile.supplierQuestionsCnValid && Array.isArray(profile.supplierQuestionsCn) ? profile.supplierQuestionsCn : [];
  const cn = savedCn.length === ru.length ? savedCn : ru.map(translateQuestionToCn);
  const cnCheck = validateCnQuestions(ru, cn);
  const label = cnCheck.ok ? '💬 Вопросы поставщику RU/CN' : '💬 Вопросы поставщику RU';
  const lines = ['# Вопросы поставщику', '', '## Русская версия', '', 'Здравствуйте. Хотим уточнить товар перед заказом:', '', ...ru.map((q, i) => `${i + 1}. ${q}`), ''];
  if (cnCheck.ok) lines.push('## Китайская версия', '', '您好。下单前想确认以下产品信息：', '', ...cn.map((q, i) => `${i + 1}. ${q}`));
  else lines.push('## Китайская версия', '', 'Китайская версия не сформирована. Используйте русскую версию или переведите через байера.');
  return { ru, cn: cnCheck.ok ? cn : [], cnValid: cnCheck.ok, text: lines.join('\n'), label, errors: cnCheck.errors };
}


export function formatSupplierQuestionsText(ru: string[], cn: string[]): SupplierQuestionsProfileResult {
  const cleanRu = uniq(ru, 10).slice(0, 10);
  const cnCheck = validateCnQuestions(cleanRu, cn);
  const lines = ['# Вопросы поставщику', '', '## Русская версия', '', 'Здравствуйте. Хотим уточнить товар перед заказом:', '', ...cleanRu.map((q, i) => `${i + 1}. ${q}`), ''];
  if (cnCheck.ok) lines.push('## Китайская версия', '', '您好。下单前想确认以下产品信息：', '', ...cn.map((q, i) => `${i + 1}. ${q}`));
  else lines.push('## Китайская версия', '', 'Китайская версия не сформирована. Используйте русскую версию или переведите через байера.');
  return { ru: cleanRu, cn: cnCheck.ok ? cn : [], cnValid: cnCheck.ok, text: lines.join('\n'), label: cnCheck.ok ? '💬 Вопросы поставщику RU/CN' : '💬 Вопросы поставщику RU', errors: cnCheck.errors };
}

export async function translateSupplierQuestionsRuToCn(ru: string[]): Promise<string[]> {
  const cleanRu = uniq(ru, 10).slice(0, 10);
  const fallback = cleanRu.map(translateQuestionToCn);
  const g: any = globalThis as any;
  const apiKey = g.process?.env?.OPENROUTER_API_KEY;
  if (!apiKey || typeof g.fetch !== 'function' || !g.AbortSignal) return fallback;

  try {
    const res = await g.fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: g.process?.env?.CARDZIP_CN_TRANSLATOR_MODEL || 'google/gemini-2.5-flash-lite',
        max_tokens: 900,
        temperature: 0,
        messages: [
          { role: 'system', content: 'Ты переводчик закупочных вопросов RU→CN для 1688. Верни строго JSON: {"questionsCn":[""]}. Не добавляй и не удаляй вопросы. Не используй русский. Десятичные числа пиши через точку: 12.5 元.' },
          { role: 'user', content: JSON.stringify({ questionsRu: cleanRu }) },
        ],
      }),
      signal: g.AbortSignal.timeout(12_000),
    });
    if (!res.ok) return fallback;
    const data = await res.json() as any;
    const raw = String(data.choices?.[0]?.message?.content ?? '').replace(/```json\s*/i, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(raw);
    const cn = Array.isArray(parsed?.questionsCn) ? parsed.questionsCn.map(String) : [];
    return validateCnQuestions(cleanRu, cn).ok ? cn : fallback;
  } catch {
    return fallback;
  }
}

export function validateSupplierQuestions(text: string): { ok: boolean; errors: string[]; fixedText: string } {
  const errors: string[] = [];
  if (/file:\/\//i.test(text)) errors.push('file url');
  const ruLines = text.split('\n').filter(l => /^\d+[.)]\s/.test(l) && /[А-Яа-яЁё]/.test(l));
  if (uniq(ruLines.map(l => l.replace(/^\d+[.)]\s*/, ''))).length !== ruLines.length) errors.push('duplicates');
  if (ruLines.length > 10) errors.push('too many questions');
  if (ruLines.some(l => /\bвес\b/i.test(l) && !/с упаковкой/i.test(l))) errors.push('weight question without packaging');
  if (/['‘’]\s*\d/.test(text)) errors.push('stray quote before sku number');
  return { ok: errors.length === 0, errors, fixedText: text };
}

function list(items: string[], limit = 12): string[] { return uniq(items, limit).map(v => `- ${v}`); }

export function buildBuyerBriefFromProfile(product: any, opts: { sourceUrl?: string } = {}): string {
  const p = ensureProductProcurementProfile(product, opts);
  return [
    '# ТЗ байеру', '',
    '## 1. Товар',
    `Название: ${p.identity.titleForReport}`,
    `Ссылка: ${opts.sourceUrl ?? product?.sourceUrl ?? '—'}`,
    `Цена: ${p.pricing.displayPriceText}`,
    `Выбранный SKU: ${formatSelectedSkuLine(p.identity.productKind, p.sku, p.pricing)}`,
    `SKU в карточке: ${p.sku.skuSummary}`,
    `Цвета: ${p.sku.colors.length ? p.sku.colors.join(', ') : 'уточнить'}`,
    `Материал: ${materialsDisplayLine(p)}`,
    `MOQ: ${pos(product?.moq) ? `${Math.round(pos(product?.moq)!)} шт.` : 'уточнить'}`,
    '', '## 2. Поставщик',
    `Название: ${p.supplier.name || 'не указано'}`,
    `Тип: ${p.supplier.displayType}`,
    `Рейтинг: ${p.supplier.rating || '—'}`,
    `Заказы: ${p.supplier.orders || '—'}`,
    '', '## 3. Что подтвердить у поставщика',
    ...list(p.procurement.mustAskSupplier, 10),
    '', '## 4. Что проверить на образце',
    ...list(p.procurement.mustCheckOnSample, 10),
    '', '## 5. Фото, которые нужно запросить',
    '- общий вид выбранного SKU', '- крупно материал и важные детали', '- упаковка и маркировка', '- комплектация в одном кадре', '- фото рядом с линейкой, если размер важен',
    '', '## 6. Риски',
    ...list(p.procurement.redFlags, 10),
    '', '## 7. Решение',
    p.procurement.verdict,
  ].join('\n');
}

export function buildCargoBriefFromProfile(product: any, opts: { sourceUrl?: string } = {}): string {
  const p = ensureProductProcurementProfile(product, opts);
  const weight = pos(product?.weightKg ?? product?.packedWeightKg);
  return [
    '# ТЗ карго', '',
    '## Товар',
    `Название: ${p.identity.titleForReport}`,
    `Ссылка: ${opts.sourceUrl ?? product?.sourceUrl ?? '—'}`,
    `Выбранный SKU: ${formatSelectedSkuLine(p.identity.productKind, p.sku, p.pricing)}`,
    `Цена: ${p.pricing.displayPriceText}`,
    '', '## Что нужно запросить для доставки',
    ...list(p.cargo.mustAsk, 16),
    '', '## Дополнительно по этому товару',
    ...(p.cargo.likelySensitiveCargoIssues.length ? list(p.cargo.likelySensitiveCargoIssues, 8) : ['- специальных ограничений не найдено, но ограничения по перевозке нужно подтвердить у карго']),
    '', '## Текущий статус',
    `Вес: ${weight ? `${weight} кг` : 'не указан'}`,
    'Габариты: не указаны',
    `Выбранный SKU: ${formatSelectedSkuLine(p.identity.productKind, p.sku, p.pricing)}`,
    '', '## Важно',
    'Карго не рассчитывается точно без веса и габаритов выбранного SKU.',
  ].join('\n');
}

export function buildSampleChecklistFromProfile(product: any, opts: { sourceUrl?: string } = {}): string {
  const p = ensureProductProcurementProfile(product, opts);
  const measure = uniq([
    p.identity.productKind === 'tool_kit' ? 'вес набора с упаковкой' : 'вес с упаковкой',
    p.identity.productKind === 'tool_kit' ? 'габариты кейса/упаковки' : 'габариты индивидуальной упаковки',
    ...(p.identity.productKind === 'tool_kit' ? ['размеры ключевых инструментов'] : []),
    ...p.cargo.mustAsk.filter(v => /длина|диаметр|размер|объ[её]м|вес|габарит/i.test(v)),
  ], 8);
  return [
    '# Чек-лист образца', '',
    '## До заказа образца',
    ...list(p.procurement.mustCheckBeforeSample, 8),
    '', '## Какой SKU взять',
    `- ${selectedSkuShortLabel(p.identity.productKind, p.sku)}`,
    '- Количество: 1–2 единицы, не партия',
    '', '## Что проверить на образце',
    ...list(p.procurement.mustCheckOnSample, 12),
    '', '## Что измерить',
    ...list(measure, 8),
    '', '## Какие фото сделать',
    '- общий вид выбранного SKU', '- товар крупно с разных сторон', '- важные детали/механизм/материал', '- комплектация', '- индивидуальная упаковка и маркировка',
    '', '## Красные флаги',
    ...list(p.procurement.redFlags, 10),
    '', '## Решение после образца',
    '- брать в тестовую партию', '- доработать SKU/упаковку/контент', '- не брать',
  ].join('\n');
}

export function buildSeoDraftFromProfile(product: any, opts: { sourceUrl?: string } = {}): string {
  const p = ensureProductProcurementProfile(product, opts);
  const title = safeSeoTitle(p.identity.titleForSeo, p.identity.productKind);
  const useCases = p.identity.useCases.length ? p.identity.useCases.join(', ') : 'повседневного использования';
  const material = p.identity.materials.join(', ');
  const balaclava = p.identity.productKind === 'clothing' && /балаклав|подшлемник/i.test(`${p.identity.titleForReport} ${p.identity.titleForSeo} ${p.identity.coreObject}`);
  const toolKit = p.identity.productKind === 'tool_kit';
  const bullets = balaclava ? [
    'Лёгкая балаклава для велосипеда, туризма и активного отдыха',
    'Закрывает голову, лицо и шею от ветра, пыли и солнца',
    'Сетчатая зона для более комфортного дыхания',
    p.sku.colors.length ? `Несколько цветов в карточке 1688: ${p.sku.colors.join(', ')}` : 'Несколько вариантов в карточке 1688',
    'Перед продажей подтвердите состав, размер и УФ-защиту',
  ] : toolKit ? [
    'Набор инструментов для бытового ремонта и сборки мебели',
    'Комплектация зависит от выбранного SKU — подтвердите состав набора',
    'Кейс помогает хранить инструменты в одном месте',
    'Материал металлических частей нужно подтвердить у поставщика',
    'Перед продажей проверьте образец, вес, упаковку и комплектацию',
  ] : uniq([
    `${p.identity.shortTitle || title} для ${useCases}`,
    material && !/уточнить/.test(material) ? `Материал: ${material}${/подтверд/i.test(material) ? '' : ' — подтвердите у поставщика'}` : 'Материал нужно подтвердить у поставщика',
    p.sku.colors.length ? `Доступные цвета: ${p.sku.colors.join(', ')}` : 'Цвет и SKU выберите по карточке 1688',
    p.sku.skuSummary ? `SKU в карточке: ${p.sku.skuSummary}` : 'SKU нужно уточнить перед закупкой',
    'Перед продажей проверьте образец, вес и упаковку',
  ], 5).slice(0, 5);
  while (bullets.length < 5) bullets.push('Характеристику нужно подтвердить перед публикацией');
  const characteristics = seoCharacteristics(p);
  return [
    '# SEO-черновик WB/Ozon', '',
    '## Название', title, '',
    '## Описание',
    seoDescription(p, title),
    '', '## Буллеты',
    ...bullets.map((b, i) => `${i + 1}. ${b}`),
    '', '## Характеристики',
    '| Параметр | Значение | Статус |', '|---|---|---|',
    ...characteristics.map(c => `| ${c.name} | ${c.value} | ${c.status} |`),
    '', '## Ключевые слова',
    uniq([title, p.identity.coreObject, p.identity.shortTitle, ...p.identity.useCases, ...p.sku.colors.map(c => `${p.identity.coreObject} ${c}`)], 12).join(', '),
    '', '## Что уточнить перед публикацией',
    ...list([...p.procurement.mustAskSupplier.slice(0, 6), ...p.dataQuality.missingCriticalFields], 10),
    '', '## Нельзя писать как факт',
    ...list(p.content.seoForbiddenClaims, 12),
    '', '## Идеи для инфографики',
    ...p.content.infographicIdeas.slice(0, 6).map((idea, i) => `${i + 1}. ${idea}`),
  ].join('\n');
}


function seoDescription(p: ProductProcurementProfile, title: string): string {
  if (p.identity.productKind === 'clothing' && /балаклав|подшлемник/i.test(`${p.identity.titleForReport} ${p.identity.titleForSeo} ${p.identity.coreObject}`)) {
    return 'Лёгкая балаклава из полиэстера подходит для поездок на велосипеде, туризма, прогулок и защиты лица от ветра, пыли и солнца. Сетчатая зона помогает легче дышать при активном движении. Перед публикацией подтвердите состав ткани, размеры, упаковку и заявленную УФ-защиту у поставщика.';
  }
  if (p.identity.productKind === 'umbrella') {
    return 'Складной автоматический зонт с крючком и чехлом подходит для повседневного использования в дороге, на прогулке и в поездках. Перед публикацией подтвердите размер, материал купола и спиц, механизм, комплектацию и заявленную защиту от солнца.';
  }
  if (p.identity.productKind === 'tool_kit') {
    return 'Набор инструментов в кейсе подходит для бытового ремонта, сборки мебели и мелких работ дома, на даче или в гараже. Комплектация зависит от выбранного SKU, поэтому перед публикацией нужно подтвердить состав набора, материал инструментов, вес, размеры кейса и реальные фото упаковки у поставщика.';
  }
  return `${title} подходит для использования по назначению. Перед публикацией подтвердите материал, выбранный SKU, вес, упаковку и реальные фото у поставщика. Неподтверждённые свойства не указывайте как факт.`;
}

function seoCharacteristics(p: ProductProcurementProfile): Array<{ name: string; value: string; status: string }> {
  const balaclava = p.identity.productKind === 'clothing' && /балаклав|подшлемник/i.test(`${p.identity.titleForReport} ${p.identity.titleForSeo} ${p.identity.coreObject}`);
  const toolKit = p.identity.productKind === 'tool_kit';
  const rows = toolKit ? [
    { name: 'Тип', value: 'набор инструментов в кейсе', status: 'подтвердить состав' },
    { name: 'Комплектация', value: p.sku.skuSummary, status: 'уточнить точный состав по SKU' },
    { name: 'Материал', value: materialsDisplayLine(p), status: 'подтвердить марку стали и материал ручек' },
    { name: 'Вес', value: 'не указан', status: 'нужен вес набора с упаковкой' },
    { name: 'Кейс', value: 'пластиковый/металлический — уточнить', status: 'проверить фиксаторы на образце' },
  ] : balaclava ? [
    { name: 'Тип', value: 'балаклава защитная', status: 'подтвердить назначение' },
    ...(p.sku.colors.length ? [{ name: 'Цвета', value: p.sku.colors.join(', '), status: 'по SKU карточки' }] : []),
    { name: 'Материал', value: p.identity.materials.join(', ') || 'полиэстер/ткань', status: 'подтвердить состав в процентах' },
    { name: 'Размер', value: p.sku.sizes.length ? p.sku.sizes.join(', ') : 'один размер / уточнить', status: 'нужны замеры и растяжимость' },
    { name: 'Сетчатая зона', value: 'заявлена/видна по фото', status: 'проверить дыхание на образце' },
    { name: 'УФ-защита', value: 'если заявлена', status: 'не писать без подтверждения' },
    { name: 'Вес', value: 'не указан', status: 'нужен вес с упаковкой' },
  ] : [
    { name: 'Тип', value: p.identity.productKind === 'umbrella' ? 'складной автоматический зонт' : p.identity.coreObject || p.identity.shortTitle, status: 'уточнить/подтвердить' },
    ...(p.sku.colors.length ? [{ name: 'Цвета', value: p.sku.colors.join(', '), status: 'по SKU карточки' }] : []),
    { name: p.identity.productKind === 'umbrella' ? 'Материал купола' : 'Материал', value: p.identity.productKind === 'umbrella' ? 'уточнить' : p.identity.materials.join(', '), status: 'подтвердить у поставщика' },
    ...(p.identity.productKind === 'umbrella' ? [{ name: 'Материал спиц', value: 'железо/сплав', status: 'подтвердить у поставщика' }, { name: 'Механизм', value: 'автоматический', status: 'проверить на образце' }, { name: 'Защита от солнца', value: 'UPF50+ заявлено', status: 'не писать без подтверждения' }] : []),
    { name: 'Вес', value: 'не указан', status: 'нужен вес с упаковкой' },
    { name: 'SKU', value: p.sku.skuSummary, status: p.sku.selectedSkuReliable ? 'выбран' : 'уточнить выбранный SKU' },
  ];
  const seen = new Set<string>();
  return rows.filter(r => { const k = r.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return !!r.value; }).slice(0, 8);
}

export function buildReadmeFromProfile(product: any, opts: { sourceUrl?: string } = {}): string {
  return [
    'CardZip — закупочный пакет', '',
    'Что внутри:',
    '1. 01_Вопросы_поставщику.txt — вопросы поставщику на русском и китайском.',
    '2. 02_ТЗ_байеру.md — что закупаем, какой SKU выбран и что проверить.',
    '3. 03_ТЗ_карго.md — вес, габариты, упаковка и ограничения для доставки.',
    '4. 04_Чеклист_образца.md — что проверить до образца, на образце и перед партией.',
    '5. 05_SEO_черновик.md — черновик карточки WB/Ozon и идеи инфографики.',
    '6. 06_Фото_товара.zip — фото товара с 1688, если удалось скачать.',
    '', 'Рекомендуемый порядок:',
    '1. Отправьте 01_Вопросы_поставщику.txt поставщику.',
    '2. Получите вес, габариты, фото и подтверждение SKU.',
    '3. Передайте 02_ТЗ_байеру.md байеру.',
    '4. Передайте 03_ТЗ_карго.md карго.',
    '5. Закажите 1–2 образца.',
    '6. Проверьте образец по 04_Чеклист_образца.md.',
    '7. Используйте 05_SEO_черновик.md как черновик карточки.',
  ].join('\n');
}



function dedupMarkdownBulletLines(text: string): string {
  const seenBySection = new Map<string, Set<string>>();
  let section = 'root';
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const h = line.match(/^#{1,3}\s+(.+)/);
    if (h) { section = h[1].toLowerCase(); out.push(line); continue; }
    const m = line.match(/^\s*(?:[-•]|\d+[.)])\s+(.+)/);
    if (!m) { out.push(line); continue; }
    const key = normalizeDedupKey(m[1]);
    const scoped = `${section}:${key}`;
    if (!key) { out.push(line); continue; }
    if (!seenBySection.has(section)) seenBySection.set(section, new Set<string>());
    const set = seenBySection.get(section)!;
    if (set.has(scoped) || set.has(key)) continue;
    set.add(scoped); set.add(key); out.push(line);
  }
  return out.join('\n');
}

export function validateDocuments(docs: Array<{ filename: string; text: string }>, profile?: ProductProcurementProfile): { ok: boolean; errors: string[]; fixedDocs: Array<{ filename: string; text: string }> } {
  const errors: string[] = [];
  const rules = profile ? KIND_RULES[profile.identity.productKind] : undefined;
  const fixedDocs = docs.map(doc => {
    let text = doc.text;
    if (/Product Intelligence|AI-черновик|debug/i.test(text)) { errors.push(`${doc.filename}: internal text`); text = text.replace(/Product Intelligence|AI-черновик|debug/gi, 'данные анализа'); }
    if (/0(?:[,.]0+)?\s*[₽¥￥]/.test(text)) { errors.push(`${doc.filename}: zero money`); text = text.replace(/0(?:[,.]0+)?\s*[₽¥￥]/g, 'нужно уточнить'); }
    for (const claim of DANGEROUS_CLAIMS) {
      const rx = new RegExp(`\\b${claim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      if (rx.test(text) && !/нельзя писать|не писать|без документов|подтвердить/i.test(text)) errors.push(`${doc.filename}: dangerous claim ${claim}`);
    }
    if (rules?.forbiddenCategoryWords?.length) {
      for (const word of rules.forbiddenCategoryWords) {
        const rx = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        if (rx.test(text)) { errors.push(`${doc.filename}: чужая категория ${word}`); text = text.split('\n').filter(l => !rx.test(l)).join('\n'); }
      }
    }
    if (/seo/i.test(doc.filename)) {
      const bulletSection = text.match(/## Буллеты\n([\s\S]*?)(?:\n## |$)/)?.[1] ?? '';
      const bullets = bulletSection.match(/^\d+\.\s+/gm)?.length ?? 0;
      if (bullets !== 5) errors.push(`${doc.filename}: bullets not 5`);
      if (/черновик карточки на основе данных 1688/i.test(text)) { errors.push(`${doc.filename}: internal seo boilerplate`); text = text.replace(/\s*—?\s*черновик карточки для WB\/Ozon на основе данных 1688\.?/gi, '.'); }
      if (/для ремонт(?!а)\b/i.test(text)) { errors.push(`${doc.filename}: bad russian grammar`); text = text.replace(/для ремонт(?!а)\b/gi, 'для ремонта'); }
    }
    return { ...doc, text: text.replace(/\n{3,}/g, '\n\n').trim() + '\n' };
  });
  return { ok: errors.length === 0, errors, fixedDocs };
}

const REQUIRED_ZIP_DOC_NAMES = [
  '00_Инструкция.txt',
  '01_Вопросы_поставщику.txt',
  '02_ТЗ_байеру.md',
  '03_ТЗ_карго.md',
  '04_Чеклист_образца.md',
  '05_SEO_черновик.md',
];

export function validateZip(docs: Array<{ filename: string; text: string }>, hasPhotosEntry: boolean): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const byName = new Map(docs.map(d => [d.filename, d]));
  for (const name of REQUIRED_ZIP_DOC_NAMES) {
    const doc = byName.get(name);
    if (!doc) { errors.push(`missing ${name}`); continue; }
    if (!doc.text || !doc.text.trim()) errors.push(`empty ${name}`);
  }
  if (!hasPhotosEntry) errors.push('missing 06_Фото_товара.zip entry (or README fallback)');
  return { ok: errors.length === 0, errors };
}

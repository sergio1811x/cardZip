import type { RawProduct1688 } from '../types';
import { cleanChineseTitle, normalizeSkuText, normalizeMixedProductText, detectPackCount, extractShoeSize, extractLetterSize, extractSkuComponents } from './cnNormalize';
import { ensureProductProcurementProfile } from './procurementProfile';
import { cleanRawAttributes, isMaterialLikeSupplierName, stripRawSourceLabels } from './rawAttributeCleaner';
import { sanitizeUserFacingText } from './userFacingSanitizer';

export type DecisionConfidence = 'high' | 'medium' | 'low';

export type PriceDecision = {
  displayPriceText: string;
  calculationPriceYuan: number | null;
  minPriceYuan: number | null;
  maxPriceYuan: number | null;
  selectedSkuName?: string;
  selectedSkuPriceYuan?: number;
  priceSource: 'direct' | 'promotion' | 'selected_sku' | 'sku_range' | 'price_range' | 'fallback_min' | 'missing' | 'sku';
  isEstimated: boolean;
  isSkuDependent: boolean;
  isPackDependent: boolean;
  canCalculateCost: boolean;
  canCalculateRoi: false;
  needsSkuConfirmation: boolean;
  reason: string;
};

export type WeightDecision = {
  weightKg: number | null;
  displayText: string;
  source: 'provider' | 'manual' | 'category_default' | 'missing';
  isEstimated: boolean;
  canUseForCargo: boolean;
  canUseForRoi: false;
  reason: string;
};

export type SkuDecision = {
  skuDimensions: string[];
  skuSummary: string;
  skuCount: number;
  shownSkuCount: number;
  skuVariantsNormalized: Array<{ raw: string; label: string; priceYuan: number | null; packCount?: number; size?: string; color?: string; components?: string[]; parameter?: string }>;
  ambiguousParams?: string[];
  colorOptions?: string[];
  sizeOptions?: string[];
  componentOptions?: string[];
  isMultiPack: boolean;
  needsSelection: boolean;
  priceText?: string;
  recommendedSampleSku?: string;
  skuRisks: string[];
};

export type ReadinessDecision = {
  score: number;
  status: 'ready_for_sample' | 'needs_supplier_confirmation' | 'needs_market_check' | 'high_risk' | 'not_ready';
  label: '🟢 Можно заказывать образец' | '🟡 Нужны данные' | '🟡 Нужно подтвердить данные' | '🔴 Высокий риск' | '🔴 Не готово к закупке';
  positiveSignals: string[];
  blockers: string[];
  risks: string[];
  missingData: string[];
  nextActions: string[];
  canRecommendSample: boolean;
  canRecommendBatch: false;
  reason: string;
};

export type MarketDecision = {
  status: 'manual_only' | 'not_required' | 'confirmed' | 'weak' | 'not_confirmed' | 'rate_limited';
  rawCandidatesCount: number;
  confirmedDirectCount: number;
  similarLocalCount: number;
  crossBorderCount: number;
  categoryOnlyCount: number;
  medianPriceRub: number | null;
  p25PriceRub: number | null;
  p75PriceRub: number | null;
  canShowMedianPrice: boolean;
  canCalculateRoi: boolean;
  confidence: DecisionConfidence;
  reason: string;
};

export type CostDecision = {
  status: 'not_calculated_no_price' | 'cost_without_cargo' | 'cost_with_manual_weight' | 'scenario_by_manual_sale_price';
  canShowPurchaseRub: boolean;
  canShowCostWithoutCargo: boolean;
  canShowCargo: boolean;
  canShowRoi: boolean;
  purchaseRub: number | null;
  costWithoutCargoRub: number | null;
  cargoRub: number | null;
  totalCostRub: number | null;
  manualSalePriceRub?: number | null;
  scenarioProfitRub?: number | null;
  scenarioRoiPercent?: number | null;
  breakEvenPriceRub?: number | null;
  warnings: string[];
  nextAction: string;
};

export type EconomyDecision = {
  status: 'not_calculated_no_price' | 'cost_without_cargo' | 'cost_with_manual_weight' | 'scenario_by_manual_sale_price' | 'preliminary_no_weight' | 'preliminary_sku' | 'cost_only_no_market' | 'estimated_weight' | 'weak_market_data' | 'full';
  canShowCost: boolean;
  canShowCargo: boolean;
  canShowMargin: boolean;
  canShowRoi: boolean;
  costRub: number | null;
  costWithoutCargoRub: number | null;
  cargoRub: number | null;
  profitRub: number | null;
  roiPercent: number | null;
  warnings: string[];
  nextAction: string;
};

export type ProductIntelligenceLike = {
  productIdentity?: {
    marketNameRu?: string; shortNameRu?: string; productKind?: string; categoryType?: string; subCategoryType?: string; categoryPath?: string[]; coreObject?: string; formFactor?: string; audience?: string; gender?: string; season?: string; useCases?: string[]; materials?: any[]; material?: any[]; powerType?: string[]; visibleFeatures?: string[]; importantFeatures?: any[]; notConfirmedFeatures?: string[]; possibleConfusions?: string[]; notThis?: string[];
  };
  cleanTitles?: { titleCnClean?: string; titleRuClean?: string; titleForReport?: string; titleForWb?: string };
  wbSearch?: { wbCoreQuery?: string; queryCandidates?: string[]; negativeSearchTerms?: string[]; tooBroadQueries?: string[]; tooNarrowQueries?: string[] };
  matchingRules?: { mustHaveForDirectAnalog?: string[]; allowedDifferences?: string[]; directAnalogBlockers?: string[]; similarOnlyIf?: string[]; rejectIf?: string[] };
  claimsPolicy?: { allowedClaims?: string[]; claimedButNeedProof?: string[]; forbiddenAsFact?: string[]; safeRewrites?: Array<{ original: string; safe: string }> };
  reportRules?: { buyerMustCheck?: string[]; buyerMustNotAsk?: string[]; cargoMustCheck?: string[]; seoAllowedClaims?: string[]; seoForbiddenClaims?: string[]; importantAttributesToShow?: string[]; attributesToHide?: string[]; sampleCheckList?: string[]; photoBriefItems?: string[]; infographicIdeas?: string[]; riskFlags?: string[] };
  supplierQuestions?: { ru?: string[]; cn?: string[] };
  dataQuality?: { missingCriticalFields?: string[]; skuRisk?: string; priceRisk?: string; weightRisk?: string; claimsRisk?: string; supplierRisk?: string; marketRisk?: string; visionConfidence?: DecisionConfidence; textConfidence?: DecisionConfidence; overallConfidence?: DecisionConfidence | string; reason?: string };
};

const YUAN_FALLBACK = 11.8;
const BANK_MARKUP = 0.03;
const DEFAULT_FULFILLMENT_RUB = 80;
const DEFAULT_CARGO_RUB_PER_KG = 400;
const DEFAULT_MARKETPLACE_COST_RATE = 0.28; // commission + acquiring + tax + logistics baseline for manual scenario

const CATEGORY_DEFAULT_WEIGHT: Record<string, number> = { shoes: 0.8, clothing: 0.3, clothes: 0.3, electronics: 0.5, accessory: 0.2, kitchen: 0.45, home: 0.4, beauty: 0.25, fishing: 0.25, tools: 0.7, other: 0.4 };

const CATEGORY_BUYER_CHECKS: Record<string, string[]> = {
  shoes: ['размерная сетка', 'длина стельки по каждому размеру', 'материал верха', 'материал подошвы', 'вес пары с упаковкой', 'размеры индивидуальной коробки', 'запах материала после распаковки', 'реальные фото пары, подошвы, стельки и упаковки', 'MOQ по цветам и размерам', 'образец'],
  clothing: ['состав ткани', 'плотность/сезонность материала', 'размерная сетка', 'замеры изделия', 'усадка после стирки', 'цветопередача', 'реальные фото, бирки и упаковка'],
  clothes: ['состав ткани', 'плотность/сезонность материала', 'размерная сетка', 'замеры изделия', 'усадка после стирки', 'цветопередача', 'реальные фото, бирки и упаковка'],
  electronics: ['точная модель/SKU', 'тип питания/разъём', 'комплектация', 'мощность/напряжение, если товар электрический', 'батарея, если есть', 'инструкция и сертификаты', 'вес с упаковкой'],
  small_appliance: ['напряжение', 'мощность', 'тип вилки', 'питание от сети или аккумулятор', 'реальный объём/ёмкость', 'режимы работы', 'есть ли слив воды', 'длина кабеля', 'комплектация', 'инструкция', 'сертификаты/декларации', 'гарантия', 'видео работы'],
  sleep_accessory: ['материал и мягкость', 'форма 3D-углублений', 'не давит ли на глаза', 'затемнение на свету', 'качество резинки/ремешка', 'запах после распаковки', 'швы и края', 'упаковка OPP/коробка', 'вес и габариты упаковки'],
  umbrella: ['вес с упаковкой', 'длина в сложенном виде', 'диаметр купола в раскрытом виде', 'количество спиц', 'материал купола', 'материал спиц', 'тип механизма: автоматическое открытие или открытие+закрытие', 'есть ли чехол в комплекте', 'подтвердить UPF50+, если заявлено', 'реальные фото открытого и закрытого зонта', 'фото упаковки'],
  beauty: ['состав', 'срок годности', 'документы/декларации', 'маркировка', 'упаковка', 'запах и консистенция образца'],
  kids: ['сертификаты', 'возрастная маркировка', 'мелкие детали', 'безопасность материалов документально', 'упаковка и инструкция'],
  passive_insect_trap: ['точная комплектация выбранного SKU', 'материал корпуса', 'размер одной ловушки', 'вес упаковки выбранной комплектации', 'есть ли приманка в комплекте', 'способ крепления/подвешивания', 'реальные фото товара и упаковки'],
  other: ['точная комплектация выбранного SKU', 'материал', 'размеры', 'вес с упаковкой', 'реальные фото товара и упаковки', 'MOQ и срок отгрузки'],
};

const CATEGORY_MUST_NOT_ASK: Record<string, string[]> = {
  shoes: ['рукав', 'мощность', 'напряжение', 'аккумулятор', 'тип вилки', 'усадка после стирки'],
  clothing: ['мощность', 'напряжение', 'аккумулятор', 'тип вилки', 'длина стельки'],
  clothes: ['мощность', 'напряжение', 'аккумулятор', 'тип вилки', 'длина стельки'],
  electronics: ['рукав', 'длина стельки', 'размерная сетка одежды', 'состав ткани'],
  small_appliance: ['рукав', 'длина стельки', 'подошва', 'стелька', 'состав ткани в процентах', 'размерная сетка одежды', 'консистенция', 'срок годности'],
  sleep_accessory: ['срок годности', 'консистенция', 'подошва', 'дно', 'корпус', 'герметичность упаковки как обязательное', 'мощность', 'напряжение', 'тип вилки', 'аккумулятор'],
  umbrella: ['длина стельки', 'подошва', 'стелька', 'рукав', 'мощность', 'напряжение', 'аккумулятор', 'тип вилки', 'срок годности', 'консистенция'],
  passive_insect_trap: ['мощность', 'напряжение', '220V', 'тип вилки', 'аккумулятор', 'зарядка', 'тип лампы', 'электрическая лампа', 'ультразвуковая'],
};


type ProcurementRules = {
  productKind: string;
  buyerMustCheck: string[];
  sampleMustCheck: string[];
  cargoMustAsk: string[];
  seoAllowedClaims: string[];
  seoForbiddenClaims: string[];
  infographicSlides: Array<{ title: string; text: string; visual: string }>;
  redFlags: string[];
};

const GENERIC_PROCUREMENT_RULES: ProcurementRules = {
  productKind: 'generic_product',
  buyerMustCheck: ['цена выбранного SKU', 'вес с упаковкой', 'габариты упаковки', 'материал', 'комплектация', 'реальные фото выбранного SKU и упаковки', 'MOQ и срок отгрузки'],
  sampleMustCheck: ['соответствие выбранному SKU', 'качество материала', 'комплектация', 'упаковка', 'вес и габариты', 'запах/дефекты после распаковки', 'заявленные свойства на образце'],
  cargoMustAsk: ['вес одной единицы с упаковкой', 'габариты индивидуальной упаковки', 'количество в транспортной коробке', 'вес транспортной коробки', 'габариты транспортной коробки', 'фото индивидуальной и транспортной упаковки', 'материал товара', 'код ТН ВЭД, если поставщик знает', 'есть ли батарейка / жидкость / порошок / магнит / стекло'],
  seoAllowedClaims: ['тип товара', 'назначение', 'цвета/SKU', 'материал после подтверждения', 'комплектация после подтверждения'],
  seoForbiddenClaims: ['сертифицированный без документов', '100% эффект без теста', 'безопасный без документов', 'оригинальный бренд без подтверждения'],
  infographicSlides: [
    { title: 'главный', text: 'Показать товар и основной сценарий применения', visual: 'товар крупно на чистом фоне' },
    { title: 'сценарии применения', text: 'Где и зачем использовать товар', visual: '3–4 иконки или фото сценариев применения' },
    { title: 'конструкция/детали', text: 'Материал и важные элементы — подтвердить на образце', visual: 'крупные детали товара' },
    { title: 'SKU', text: 'Выберите нужный цвет, размер или комплектацию', visual: 'варианты SKU из карточки' },
    { title: 'упаковка', text: 'Упаковку, вес и габариты подтвердить у поставщика', visual: 'фото упаковки и комплектации' },
  ],
  redFlags: ['поставщик не подтверждает вес', 'не даёт реальные фото', 'цена меняется после уточнения', 'SKU на фото отличается от выбранного', 'материал не подтверждается', 'заявленные свойства без тестов/документов'],
};

const PROCUREMENT_RULES: Record<string, ProcurementRules> = {
  umbrella: {
    productKind: 'umbrella',
    buyerMustCheck: ['вес с упаковкой', 'длина в сложенном виде', 'диаметр купола в раскрытом виде', 'количество спиц', 'материал купола', 'материал спиц', 'тип механизма: автоматическое открытие или открытие+закрытие', 'есть ли чехол в комплекте', 'подтвердить UPF50+/защиту от солнца, если заявлено', 'реальные фото открытого и закрытого зонта', 'фото упаковки'],
    sampleMustCheck: ['работает ли кнопка', 'не заедает ли механизм открытия/закрытия', 'прочность спиц', 'люфт ручки', 'качество швов купола', 'водоотталкивание на образце', 'размер в раскрытом виде', 'длина в сложенном виде', 'наличие чехла', 'качество упаковки'],
    cargoMustAsk: ['вес с упаковкой', 'габариты упаковки', 'длина в сложенном виде', 'диаметр купола', 'количество спиц', 'материал купола и спиц', 'наличие чехла', 'фото открытого/закрытого зонта и упаковки'],
    seoAllowedClaims: ['автоматический механизм после проверки образца', 'складной формат', 'цвет/дизайн', 'дождь/солнце как сценарий применения'],
    seoForbiddenClaims: ['100% защита от дождя без теста', 'UPF50+ без документов', 'ветроустойчивый без теста', 'премиальный без подтверждения'],
    infographicSlides: [
      { title: 'главный', text: 'Автоматический зонт от дождя и солнца', visual: 'раскрытый купол, ручка и общий вид' },
      { title: 'компактный формат', text: 'Складной зонт удобно брать с собой', visual: 'зонт в сложенном виде рядом с сумкой' },
      { title: 'механизм', text: 'Кнопка автоматического открытия', visual: 'крупно кнопка и ручка; проверить механизм на образце' },
      { title: 'купол и цвета', text: 'Градиентный купол и варианты цвета', visual: 'раскрытый купол + цвета/SKU' },
      { title: 'чехол и упаковка', text: 'Чехол и упаковку подтвердить у поставщика', visual: 'чехол, упаковка, размеры и вес' },
    ],
    redFlags: ['нет веса/габаритов', 'не подтверждён механизм', 'нет фото открытого зонта', 'нет чехла, хотя он заявлен', 'UPF/ветроустойчивость без документов или теста', 'слабая упаковка для доставки'],
  },
  sleep_mask: {
    productKind: 'sleep_mask',
    buyerMustCheck: ['материал лицевой части', 'материал внутренней части', 'размер маски', 'вес с упаковкой', 'тип упаковки: OPP или коробка', 'регулируется ли ремешок', 'реальные фото выбранного цвета и упаковки', 'подтверждение 3D-формы', 'подтверждение затемнения'],
    sampleMustCheck: ['мягкость материала', 'форма 3D-углублений', 'не давит ли на глаза', 'не давит ли на нос', 'качество резинки/ремешка', 'затемнение на свету', 'запах после распаковки', 'швы и края', 'комфорт при носке 10–15 минут', 'упаковка OPP/коробка'],
    cargoMustAsk: ['вес с упаковкой', 'габариты упаковки', 'тип упаковки OPP/коробка', 'количество в транспортной коробке', 'вес/габариты коробки', 'фото упаковки выбранного SKU'],
    seoAllowedClaims: ['3D-форма после проверки образца', 'для сна дома и в поездках', 'мягкий материал после подтверждения', 'несколько цветов/упаковок'],
    seoForbiddenClaims: ['100% затемнение без теста', 'лечебный эффект', 'гипоаллергенная без документов', 'полностью безопасна для детей без документов'],
    infographicSlides: [
      { title: 'главный', text: 'Мягкая 3D-маска для сна', visual: 'маска на лице или рядом с подушкой' },
      { title: 'сценарии применения', text: 'Для дома, поездок, самолёта и дневного отдыха', visual: 'иконки дом / поезд / самолёт / отдых' },
      { title: '3D-форма', text: 'Не давит на глаза и ресницы', visual: 'крупно углубления для глаз' },
      { title: 'затемнение', text: 'Помогает закрыть глаза от света', visual: 'сравнение свет/темнота без обещания 100%' },
      { title: 'цвета и упаковка', text: 'Выберите цвет и вариант упаковки', visual: 'цвета/SKU и упаковка OPP/коробка' },
    ],
    redFlags: ['сильный запах', 'давит на глаза/нос', 'плохая резинка', 'швы царапают кожу', 'не подтверждён материал', 'упаковка отличается от выбранного SKU'],
  },
  mini_washer: {
    productKind: 'mini_washer',
    buyerMustCheck: ['мощность', 'напряжение', 'тип вилки', 'длина кабеля', 'реальный объём 4 л', 'режимы работы', 'есть ли слив воды', 'комплектация', 'инструкция', 'сертификаты/декларации', 'гарантия', 'видео работы', 'вес с упаковкой', 'габариты упаковки'],
    sampleMustCheck: ['включается ли от нужного напряжения', 'не течёт ли корпус', 'как работает слив воды', 'шум и вибрация', 'качество пластика', 'фактический объём', 'отстирывает ли носки/бельё', 'длина кабеля', 'комплектация', 'инструкция', 'упаковка после доставки'],
    cargoMustAsk: ['вес с упаковкой', 'габариты упаковки', 'вес/габариты транспортной коробки', 'напряжение, мощность и тип вилки', 'есть ли аккумулятор или питание только от сети', 'фото комплектации', 'инструкция и документы', 'видео работы'],
    seoAllowedClaims: ['портативный формат', 'для небольших вещей', 'объём 4 л после подтверждения', 'несколько цветов/моделей'],
    seoForbiddenClaims: ['дезинфекция без документов', 'стерилизация без документов', 'безопасна для детей без документов', 'профессиональная без подтверждения', 'синий свет как доказанная дезинфекция без документов'],
    infographicSlides: [
      { title: 'главный', text: 'Портативная мини-стиральная машина 4 л', visual: 'товар крупно рядом с носками/бельём для масштаба' },
      { title: 'для небольших вещей', text: 'Для белья, носков и детских вещей', visual: 'иконки бельё / носки / детские вещи / дача' },
      { title: 'управление и питание', text: 'Проверьте мощность, напряжение и тип вилки', visual: 'кнопки управления, кабель питания и вилка' },
      { title: 'ёмкость и слив', text: 'Объём и слив воды подтвердить у поставщика', visual: 'крышка, ёмкость/барабан, слив' },
      { title: 'комплектация', text: 'Проверьте комплектацию и инструкцию', visual: 'коробка, кабель, инструкция, аксессуары' },
    ],
    redFlags: ['нет видео работы', 'не подтверждено напряжение/вилка', 'нет информации о сливе', 'нет инструкции', 'заявлена дезинфекция без документов', 'корпус течёт или сильная вибрация', 'нет гарантий/условий замены'],
  },
  footwear: {
    productKind: 'footwear',
    buyerMustCheck: ['размерная сетка', 'длина стельки', 'материал верха', 'материал подошвы', 'вес пары с упаковкой', 'размеры упаковки одной пары', 'запах EVA/PU после распаковки', 'реальные фото пары', 'упаковка', 'MOQ по цветам и размерам', 'можно ли заказать образец'],
    sampleMustCheck: ['соответствие размеру', 'длина стельки', 'удобство посадки', 'запах материала', 'качество клея/швов', 'скользкость подошвы', 'вес пары', 'упаковка', 'дефекты на паре', 'соответствие фото поставщика'],
    cargoMustAsk: ['вес пары с коробкой/упаковкой', 'габариты коробки одной пары', 'количество пар в транспортной коробке', 'вес/габариты транспортной коробки', 'фото упаковки'],
    seoAllowedClaims: ['тип обуви', 'материал после подтверждения', 'размеры из SKU', 'цвета из SKU', 'сценарии носки'],
    seoForbiddenClaims: ['ортопедические без документов', 'лечебные свойства', 'антибактериальные без документов', 'противоскользящие как факт без теста'],
    infographicSlides: [
      { title: 'главный', text: 'Показать пару и назначение', visual: 'обувь на ноге или пара на чистом фоне' },
      { title: 'материал и подошва', text: 'Материал и подошву проверить на образце', visual: 'крупно верх, подошва и фактура' },
      { title: 'размеры', text: 'Размерную сетку подтвердить по длине стельки', visual: 'таблица размеров после подтверждения' },
      { title: 'цвета', text: 'Доступные цвета из SKU', visual: 'цветовые варианты' },
      { title: 'упаковка', text: 'Фото упаковки запросить у поставщика', visual: 'коробка/пакет, маркировка' },
    ],
    redFlags: ['нет длины стельки', 'нет веса пары', 'сильный запах', 'скользкая подошва', 'поставщик не даёт реальные фото', 'цвет/размер отличается от SKU'],
  },
  passive_insect_trap: {
    productKind: 'passive_insect_trap',
    buyerMustCheck: ['размер одной ловушки', 'материал', 'вес выбранной комплектации', 'количество штук в комплекте', 'есть ли приманка в комплекте', 'способ крепления/подвешивания', 'реальные фото товара и упаковки'],
    sampleMustCheck: ['размер и материал', 'комплектация', 'как крепится/подвешивается', 'есть ли приманка', 'запах/липкость/качество поверхности, если применимо', 'упаковка', 'вес и габариты'],
    cargoMustAsk: ['вес выбранной комплектации', 'габариты упаковки', 'количество штук в комплекте', 'количество комплектов в коробке', 'фото упаковки'],
    seoAllowedClaims: ['пассивная ловушка', 'материал', 'комплектация', 'способ крепления'],
    seoForbiddenClaims: ['электрическая без подтверждения', 'ультразвуковая без подтверждения', 'безопасна для детей/животных без документов', '100% избавляет от насекомых'],
    infographicSlides: [
      { title: 'главный', text: 'Пассивная ловушка для насекомых', visual: 'товар крупно + сценарий размещения' },
      { title: 'как использовать', text: 'Поставить, подвесить или закрепить — уточнить по модели', visual: 'варианты размещения' },
      { title: 'комплектация', text: 'Количество штук в наборе', visual: 'все элементы комплекта' },
      { title: 'материал', text: 'Материал и размер подтвердить', visual: 'крупный план поверхности/крепления' },
      { title: 'упаковка', text: 'Запросите фото упаковки', visual: 'индивидуальная упаковка и коробка' },
    ],
    redFlags: ['появились электрические характеристики у пассивной ловушки', 'непонятная комплектация', 'нет размера/материала', 'нет фото упаковки'],
  },
};

function asArray<T = any>(v: unknown): T[] { return Array.isArray(v) ? v as T[] : []; }
function asRecord(v: unknown): Record<string, any> { return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {}; }
function num(value: unknown): number | null { if (typeof value === 'number' && Number.isFinite(value)) return value; if (typeof value === 'string') { const n = Number(value.replace(',', '.').replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : null; } return null; }
function positive(value: unknown): number | null { const n = num(value); return n !== null && n > 0 ? Math.round(n * 100) / 100 : null; }
function cny(value: number | null | undefined): string { if (!value || !Number.isFinite(value) || value <= 0) return 'нужно уточнить'; return `${String(Math.round(value * 100) / 100).replace('.', ',')} ¥`; }
function cnyCn(value: number | null | undefined): string { if (!value || !Number.isFinite(value) || value <= 0) return '需要确认'; return `${String(Math.round(value * 100) / 100)} 元`; }
function supplierTypeRu(value: unknown): string {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return 'продавец';
  if (/factory|фабрик|工厂|厂家/.test(raw)) return 'фабрика';
  if (/merchant|провер|实力|供应商/.test(raw)) return 'проверенный продавец';
  if (/seller|store|shop|продав/.test(raw)) return 'продавец';
  return normalizeFact(value) || 'продавец';
}
function money(value: number | null | undefined): string { if (!value || !Number.isFinite(value) || value <= 0) return '—'; return `${Math.round(value).toLocaleString('ru-RU')} ₽`; }
function rangeText(min: number | null, max: number | null): string { if (!min && !max) return 'нужно уточнить'; if (min && max && min !== max) return `${cny(min).replace(' ¥', '')}–${cny(max).replace(' ¥', '')} ¥`; return cny(min ?? max); }
function html(value: unknown): string { return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function clean(value: unknown): string { return String(value ?? '').replace(/\b(?:undefined|null|NaN|Infinity|-Infinity)\b/gi, '—').replace(/0(?:[,.]0+)?\s*[¥￥₽]/gi, 'цена уточняется').replace(/0(?:[,.]0+)?\s*(?:кг|kg)\b/gi, 'вес уточняется').replace(/\s+/g, ' ').trim(); }
function normalizeFact(value: unknown): string { return clean(normalizeMixedProductText(value)); }
function uniq(list: string[], limit = 20): string[] { const seen = new Set<string>(); const out: string[] = []; for (const raw of list) { const text = clean(raw); if (!text || /^[-—]$/.test(text)) continue; const key = text.toLowerCase(); if (seen.has(key)) continue; seen.add(key); out.push(text); if (out.length >= limit) break; } return out; }
function stripNumber(v: unknown): string { return normalizeFact(v).replace(/^\s*(?:\d+[.)]|[-•])\s*/g, '').trim(); }

function displaySkuSummary(summary: string): string { return clean(summary).replace(/^SKU:\s*/i, ''); }
function displayMainSkuSummary(x: ReturnType<typeof buildDecisionContext>): string {
  if (x.sku.ambiguousParams?.length) {
    const dims = x.sku.skuDimensions.length ? describeSkuDimensions(x.sku.skuDimensions) : 'параметр SKU';
    return `${x.sku.skuCount || x.sku.shownSkuCount || 0} ${pluralRu(x.sku.skuCount || x.sku.shownSkuCount || 0, 'вариант', 'варианта', 'вариантов')} · ${dims}`;
  }
  return displaySkuSummary(x.sku.skuSummary);
}
function displayPriceSummary(text: string): string { return clean(text).replace(/^Цена выбранного SKU:\s*/i, 'выбранный SKU: ').replace(/^Цена по SKU:\s*/i, 'по SKU: ').replace(/^Цена:\s*/i, ''); }

function pluralRu(n: number, one: string, few: string, many: string): string {
  const v = Math.abs(n) % 100;
  const v1 = v % 10;
  if (v > 10 && v < 20) return many;
  if (v1 > 1 && v1 < 5) return few;
  if (v1 === 1) return one;
  return many;
}



function cautiousClaim(value: unknown): string {
  const t = normalizeFact(value);
  const lower = t.toLowerCase();
  const parts: string[] = [];
  if (/антибактер|抗菌/.test(lower)) parts.push('заявленное антибактериальное свойство — подтвердить документами/испытаниями');
  if (/противоскольз|防滑/.test(lower)) parts.push('заявленное противоскользящее свойство — проверить на образце');
  if (/防臭|не вызывает запах|защит[а-яё]* от запах|不臭脚/.test(lower)) parts.push('заявленная защита от запаха — проверить на образце');
  if (/водонепрониц|влагозащит|防水/.test(lower)) parts.push('заявленная влагозащита — подтвердить у поставщика');
  if (/лечебн|ортопед|гипоаллерген/.test(lower)) parts.push('регулируемое спецсвойство — только при документах');
  if (parts.length) return uniq(parts, 4).join('; ');
  return t;
}

function getIntel(product: any): ProductIntelligenceLike {
  return asRecord(product?.intelligence ?? product?.productIntelligence ?? product?.productContext?.productIntelligence) as ProductIntelligenceLike;
}
function getIdentity(product: any, intel = getIntel(product)) { return asRecord(intel.productIdentity ?? product?.productContext?.identity); }
function categoryType(product: any, intel = getIntel(product)): string {
  const raw0 = String(getIdentity(product, intel).categoryType ?? product?.categoryType ?? product?.productContext?.identity?.categoryType ?? '').toLowerCase();
  const raw = raw0 === 'clothes' ? 'clothing' : raw0;
  const text = `${product?.titleCn ?? ''} ${product?.titleRu ?? ''} ${product?.categoryName ?? ''} ${getIdentity(product, intel).productKind ?? ''} ${getIdentity(product, intel).coreObject ?? ''}`.toLowerCase();
  // High-confidence overrides: these categories often get mislabeled as beauty/home/electronics by LLM.
  if (/мини[ -]?стирал|стиральн[а-яё ]*машин|портативн[а-яё ]*стирал|washing\s*machine|洗衣机|内衣洗衣/i.test(text)) return 'small_appliance';
  if (/маск[аи]\s+для\s+сна|3d[ -]?маск|sleep\s*mask|眼罩|睡眠眼罩|遮光眼罩/i.test(text)) return 'sleep_accessory';
  if (/зонт|umbrella|雨伞|伞|傘/i.test(text)) return 'umbrella';
  if (raw) return raw;
  if (/鞋|сабо|сандал|тапоч|шл[её]пан|обув/.test(text)) return 'shoes';
  if (/плать|брюк|леггинс|футбол|одежд|衣|裤/.test(text)) return 'clothing';
  if (/usb|аккумулятор|электр|电|220v|type-c|зарядк/.test(text)) return 'electronics';
  if (/космет|cream|beauty/.test(text)) return 'beauty';
  if (/детск|孩子|儿童/.test(text)) return 'kids';
  return 'other';
}
function titleForReport(product: any, intel = getIntel(product)): string {
  return clean(intel.cleanTitles?.titleForReport || intel.productIdentity?.shortNameRu || intel.productIdentity?.marketNameRu || product?.titleRu || product?.seoContent?.titleRu || product?.titleEn || normalizeMixedProductText(product?.titleCn) || 'Товар 1688');
}
function imagesCount(product: any): number { for (const src of [product?.images, product?.imageUrls, product?.normalized1688?.images]) { const a = asArray(src); if (a.length) return a.length; } return positive(product?.normalized1688?.imageCount ?? product?.photosCount) ?? (product?.mainImageUrl ? 1 : 0); }

function collectSku(product: any): any[] { return asArray(product?.skus).length ? asArray(product.skus) : asArray(product?.normalized1688?.skuVariants); }
function skuPrice(s: any): number | null { return positive(s?.priceYuan ?? s?.price ?? s?.discountPrice ?? s?.salePrice); }

function valueFromLabel(label: string, prefix: string): string | undefined {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = label.match(new RegExp(`${escaped}:\\s*([^;]+)`, 'i'));
  return m?.[1]?.trim();
}

function describeSkuDimensions(dims: string[]): string {
  return dims.map(d => ({ color: 'цвет', size: 'размер', model: 'модель', packCount: 'количество штук', details: 'комплектация', parameter: 'параметр SKU' } as Record<string, string>)[d] ?? d).join(' × ');
}

function ambiguousUmbrellaSkuParam(raw: string, label: string, category: string): string | undefined {
  if (category !== 'umbrella') return undefined;
  const rawText = String(raw ?? '').trim();
  const labelText = String(label ?? '').trim();
  const direct = rawText.match(/^\D*(\d{1,3})\D*$/)?.[1];
  const fromLabel = labelText.match(/Размер:\s*(\d{1,3})(?:\b|\s|;|$)/i)?.[1];
  const value = direct || fromLabel;
  if (!value) return undefined;
  if (/см|cm|мм|mm|диаметр|купол|длина|размер\s+купола/i.test(rawText)) return undefined;
  return value;
}

function normalizeSkuLabelForCategory(raw: string, label: string, category: string): { label: string; size?: string; parameter?: string } {
  const parameter = ambiguousUmbrellaSkuParam(raw, label, category);
  if (!parameter) return { label };
  const cleaned = String(label || raw)
    .replace(/(?:^|;\s*)Размер:\s*\d{1,3}(?=\s*;|$)/i, '')
    .replace(/;{2,}/g, ';')
    .replace(/^;\s*|;\s*$/g, '')
    .trim();
  const paramText = `Параметр SKU: ${parameter} — уточнить у поставщика`;
  return { label: cleaned ? `${cleaned}; ${paramText}` : paramText, parameter };
}


export function buildSkuDecision(product: RawProduct1688 | any, intelligence?: ProductIntelligenceLike): SkuDecision {
  const variantsRaw = collectSku(product);
  const skuCategory = categoryType(product, intelligence);
  const variants = variantsRaw.map((s, i) => {
    const raw = String(s?.name ?? s?.label ?? s?.skuName ?? s?.propertiesName ?? `SKU ${i + 1}`);
    const baseLabel = normalizeSkuText(raw) || normalizeFact(raw) || `SKU ${i + 1}`;
    const fixed = normalizeSkuLabelForCategory(raw, baseLabel, skuCategory);
    const label = fixed.label;
    const color = valueFromLabel(label, 'Цвет');
    const size = fixed.parameter ? undefined : (extractShoeSize(raw) || extractLetterSize(raw) || valueFromLabel(label, 'Размер'));
    const components = uniq([...(extractSkuComponents(raw) ?? []), ...(valueFromLabel(label, 'Комплектация/детали')?.split(',').map(v => v.trim()) ?? [])], 8);
    return { raw, label, priceYuan: skuPrice(s), packCount: detectPackCount(raw), size, color, components, parameter: fixed.parameter };
  }).filter(v => v.raw || v.label);

  const prices = variants.map(v => v.priceYuan).filter((p): p is number => !!p);
  const rawText = variants.map(v => `${v.raw} ${v.label}`).join(' ');
  const colorOptions = uniq(variants.map(v => v.color || '').filter(Boolean), 20);
  const sizeOptions = uniq(variants.map(v => v.size || '').filter(Boolean), 30);
  const componentOptions = uniq(variants.flatMap(v => v.components ?? []), 20);
  const ambiguousParams = uniq(variants.map(v => v.parameter || '').filter(Boolean), 20).sort((a, b) => { const na = Number(a); const nb = Number(b); return Number.isFinite(na) && Number.isFinite(nb) ? na - nb : a.localeCompare(b, 'ru'); });

  const dims: string[] = [];
  if (colorOptions.length || /цвет|color|白|黑|红|蓝|绿|黄|粉|хаки|бел|черн|чёрн|розов/i.test(rawText)) dims.push('color');
  if (sizeOptions.length || (/размер|size|尺码|码|\b(?:XS|S|M|L|XL|XXL|XXXL|2XL|3XL)\b|\b3[5-9]\b|\b4[0-9]\b/i.test(rawText) && !ambiguousParams.length) || categoryType(product, intelligence) === 'shoes') dims.push('size');
  if (ambiguousParams.length) dims.push('parameter');
  if (/модель|version|款|型号|经典|普通|基础|高版本/i.test(rawText)) dims.push('model');
  const isMultiPack = variants.some(v => !!v.packCount);
  if (isMultiPack) dims.push('packCount');
  if (componentOptions.length) dims.push('details');
  const uniqueDims = uniq(dims, 6);

  const numericSizes = sizeOptions.map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
  const letterSizes = sizeOptions.filter(s => !/^\d+$/.test(s));
  const parts = variants.length ? [`SKU: ${variants.length} ${pluralRu(variants.length, 'вариант', 'варианта', 'вариантов')}`] : ['SKU: не указаны'];
  if (uniqueDims.length) parts.push(describeSkuDimensions(uniqueDims));
  if (colorOptions.length) parts.push(`цвета: ${colorOptions.slice(0, 6).join(', ')}${colorOptions.length > 6 ? '…' : ''}`);
  if (numericSizes.length) parts.push(`размеры ${numericSizes[0]}–${numericSizes[numericSizes.length - 1]}`);
  else if (letterSizes.length) parts.push(`размеры ${letterSizes.slice(0, 8).join(', ')}`);
  if (ambiguousParams.length) parts.push(`параметры: ${ambiguousParams.slice(0, 8).join(' / ')} — значение нужно уточнить`);
  if (componentOptions.length) parts.push(`детали: ${componentOptions.slice(0, 4).join(', ')}`);
  if (/маломер|偏小一码/.test(rawText)) parts.push('маломерит на 1 размер');
  if (prices.length) parts.push(`цена по SKU ${rangeText(Math.min(...prices), Math.max(...prices))}`);
  if (variants.length > 15) parts.push('показаны первые 15');

  const safeVariants = variants.slice(0, 15);
  const rec = safeVariants.find(v => /бел|черн|чёрн|хаки|40|39|38|\bM\b|\bL\b/.test(v.label))?.label ?? safeVariants[0]?.label;
  const skuRisks = uniq([
    ...(variants.length > 1 ? ['нужно выбрать конкретный SKU перед расчётом'] : []),
    ...(isMultiPack ? ['цена и вес зависят от комплектации'] : []),
    ...(uniqueDims.includes('details') ? ['проверить комплектацию/детали выбранного SKU'] : []),
    ...(ambiguousParams.length ? [`уточнить значение параметра SKU: ${ambiguousParams.slice(0, 4).join(', ')}`] : []),
    ...(/маломер|偏小一码/.test(rawText) ? ['поставщик указывает риск маломерности'] : []),
  ], 8);
  return {
    skuDimensions: uniqueDims,
    skuSummary: parts.join(' · '),
    skuCount: variants.length,
    shownSkuCount: safeVariants.length,
    skuVariantsNormalized: safeVariants,
    colorOptions,
    sizeOptions,
    componentOptions,
    ambiguousParams,
    isMultiPack,
    needsSelection: variants.length > 1,
    priceText: prices.length ? `Цена по SKU: ${rangeText(Math.min(...prices), Math.max(...prices))}` : undefined,
    recommendedSampleSku: rec,
    skuRisks,
  };
}

export function buildPriceDecision(product: RawProduct1688 | any, sku = buildSkuDecision(product)): PriceDecision {
  const pricing = asRecord(product?.normalized1688?.pricing);
  const selectedSkuName = pricing.selectedSkuName || product?.selectedSkuName;
  const selectedSkuPrice = positive(pricing.selectedSkuPriceYuan ?? product?.selectedSkuPriceYuan);
  if (selectedSkuPrice) return { displayPriceText: `Цена выбранного SKU: ${cny(selectedSkuPrice)}${selectedSkuName ? ` · ${normalizeSkuText(selectedSkuName) || normalizeFact(selectedSkuName)}` : ''}`, calculationPriceYuan: selectedSkuPrice, minPriceYuan: selectedSkuPrice, maxPriceYuan: selectedSkuPrice, selectedSkuName, selectedSkuPriceYuan: selectedSkuPrice, priceSource: 'selected_sku', isEstimated: false, isSkuDependent: false, isPackDependent: sku.isMultiPack, canCalculateCost: true, canCalculateRoi: false, needsSkuConfirmation: false, reason: 'Выбран конкретный SKU с положительной ценой.' };
  const skuPrices = sku.skuVariantsNormalized.map(v => v.priceYuan).filter((p): p is number => !!p);
  if (skuPrices.length) { const sorted = skuPrices.slice().sort((a,b)=>a-b); const min = sorted[0]; const max = sorted[sorted.length - 1]; const calc = sorted[Math.floor(sorted.length / 2)]; return { displayPriceText: `${sku.isMultiPack ? 'Цена зависит от комплектации' : 'Цена по SKU'}: ${rangeText(min, max)}. Для точного расчёта выберите цвет/размер/модель.`, calculationPriceYuan: calc, minPriceYuan: min, maxPriceYuan: max, priceSource: 'sku_range', isEstimated: min !== max, isSkuDependent: true, isPackDependent: sku.isMultiPack, canCalculateCost: true, canCalculateRoi: false, needsSkuConfirmation: true, reason: 'Цена взята из диапазона SKU; для точного расчёта нужен выбранный SKU.' }; }
  const ranges = asArray<any>(product?.priceRange ?? pricing.priceRanges).map(r => ({ minQty: positive(r?.minQty ?? r?.min_quantity) ?? 1, maxQty: positive(r?.maxQty ?? r?.max_quantity), price: positive(r?.price ?? r?.priceYuan) })).filter(r => !!r.price) as Array<{ minQty: number; maxQty: number | null; price: number }>;
  if (ranges.length) { const prices = ranges.map(r => r.price); const min = Math.min(...prices); const max = Math.max(...prices); const uniqueQty = new Set(ranges.map(r => r.minQty)).size; const details = ranges.slice(0,4).map(r => `${r.minQty}+ шт — ${cny(r.price)}`).join('; '); return { displayPriceText: uniqueQty > 1 ? `Оптовые цены: ${rangeText(min,max)}; ${details}` : `Цена по вариантам: ${rangeText(min,max)}. Оптовые пороги не найдены.`, calculationPriceYuan: min, minPriceYuan: min, maxPriceYuan: max, priceSource: uniqueQty > 1 ? 'price_range' : 'fallback_min', isEstimated: true, isSkuDependent: uniqueQty === 1 || min !== max, isPackDependent: sku.isMultiPack, canCalculateCost: true, canCalculateRoi: false, needsSkuConfirmation: true, reason: uniqueQty > 1 ? 'Есть priceRange с порогами количества.' : 'priceRange похож на цены вариантов, а не на скидки.' }; }
  const promo = positive(pricing.promotionPriceYuan ?? product?.promotionPrice ?? product?.promotion_price); if (promo) return { displayPriceText: `Цена: ${cny(promo)}`, calculationPriceYuan: promo, minPriceYuan: promo, maxPriceYuan: promo, priceSource: 'promotion', isEstimated: false, isSkuDependent: sku.needsSelection, isPackDependent: sku.isMultiPack, canCalculateCost: true, canCalculateRoi: false, needsSkuConfirmation: sku.needsSelection || sku.isMultiPack, reason: 'Использована промо-цена поставщика.' };
  const direct = positive(pricing.directPriceYuan ?? product?.priceYuan ?? product?.price); if (direct) return { displayPriceText: `Цена: ${cny(direct)}`, calculationPriceYuan: direct, minPriceYuan: direct, maxPriceYuan: direct, priceSource: 'direct', isEstimated: false, isSkuDependent: sku.needsSelection, isPackDependent: sku.isMultiPack, canCalculateCost: true, canCalculateRoi: false, needsSkuConfirmation: sku.needsSelection || sku.isMultiPack, reason: 'Использована витринная цена поставщика.' };
  return { displayPriceText: '—', calculationPriceYuan: null, minPriceYuan: null, maxPriceYuan: null, priceSource: 'missing', isEstimated: false, isSkuDependent: sku.needsSelection, isPackDependent: sku.isMultiPack, canCalculateCost: false, canCalculateRoi: false, needsSkuConfirmation: sku.needsSelection, reason: 'Нет положительной цены в direct/promotion/SKU/priceRange.' };
}

export function buildWeightDecision(product: RawProduct1688 | any, intelligence?: ProductIntelligenceLike, sku = buildSkuDecision(product, intelligence)): WeightDecision {
  const manual = positive(product?.manualWeightKg ?? product?.supplierAnswer?.weightKg ?? product?.confirmedWeightKg);
  if (manual) return { weightKg: manual, displayText: `Вес: ${manual} кг, введён вручную`, source: 'manual', isEstimated: false, canUseForCargo: true, canUseForRoi: false, reason: 'Вес введён/подтверждён вручную.' };
  const cat = categoryType(product, intelligence);
  const provider = positive(product?.normalized1688?.weightKg ?? product?.weightKg ?? product?.shipping_info?.weight);
  if (provider) {
    if (skipCategoryDefaultWeight(product, cat) && provider < 1 && !product?.supplierAnswer?.weightKg && !product?.confirmedWeightKg) {
      return { weightKg: null, displayText: 'Вес: не указан. Ориентир по категории не применён — товар объёмный/технический; вес нужно уточнить у поставщика.', source: 'missing', isEstimated: false, canUseForCargo: false, canUseForRoi: false, reason: 'Подозрительно малый вес для объёмной техники не используем в расчётах.' };
    }
    return { weightKg: provider, displayText: `Вес: ${provider} кг`, source: 'provider', isEstimated: false, canUseForCargo: true, canUseForRoi: false, reason: 'Вес получен от поставщика/провайдера.' };
  }
  if (sku.isMultiPack) return { weightKg: null, displayText: 'Вес: нужно уточнить для выбранной комплектации', source: 'missing', isEstimated: false, canUseForCargo: false, canUseForRoi: false, reason: 'Вес не указан; у товара разные комплектации, средний вес категории не применён.' };
  if (skipCategoryDefaultWeight(product, cat)) {
    return { weightKg: null, displayText: 'Вес: не указан. Ориентир по категории не применён — товар объёмный/технический; вес нужно уточнить у поставщика.', source: 'missing', isEstimated: false, canUseForCargo: false, canUseForRoi: false, reason: 'Для объёмной техники категорийный вес может вводить в заблуждение.' };
  }
  return { weightKg: null, displayText: 'Вес: не указан', source: 'missing', isEstimated: false, canUseForCargo: false, canUseForRoi: false, reason: 'Вес не указан; для точного карго нужен вес выбранного SKU.' };
}

export function buildMarketDecision(_product: any): MarketDecision { return { status: 'not_required', rawCandidatesCount: 0, confirmedDirectCount: 0, similarLocalCount: 0, crossBorderCount: 0, categoryOnlyCount: 0, medianPriceRub: null, p25PriceRub: null, p75PriceRub: null, canShowMedianPrice: false, canCalculateRoi: false, confidence: 'low', reason: 'CardZip готовит закупочный пакет по данным карточки и вопросам к поставщику.' }; }

export function buildCostDecision(input: { priceDecision: PriceDecision; weightDecision: WeightDecision; yuanRate?: number; manualSalePriceRub?: number | null }): CostDecision {
  const { priceDecision: price, weightDecision: weight } = input;
  const yuanRate = input.yuanRate && input.yuanRate > 0 ? input.yuanRate : YUAN_FALLBACK;
  if (!price.canCalculateCost || !price.calculationPriceYuan) return { status: 'not_calculated_no_price', canShowPurchaseRub: false, canShowCostWithoutCargo: false, canShowCargo: false, canShowRoi: false, purchaseRub: null, costWithoutCargoRub: null, cargoRub: null, totalCostRub: null, manualSalePriceRub: input.manualSalePriceRub ?? null, scenarioProfitRub: null, scenarioRoiPercent: null, breakEvenPriceRub: null, warnings: ['Себестоимость не рассчитана — нет цены товара.'], nextAction: 'Уточнить цену выбранного SKU у поставщика.' };
  const purchaseRub = Math.round(price.calculationPriceYuan * yuanRate);
  const bankRub = Math.round(purchaseRub * BANK_MARKUP);
  const costWithoutCargoRub = purchaseRub + bankRub + DEFAULT_FULFILLMENT_RUB;
  const cargoRub = weight.canUseForCargo && weight.weightKg ? Math.round(weight.weightKg * DEFAULT_CARGO_RUB_PER_KG) : null;
  const totalCostRub = cargoRub ? costWithoutCargoRub + cargoRub : null;
  const warnings = uniq([...(price.needsSkuConfirmation ? ['цена зависит от выбранного SKU/комплектации'] : []), ...(!weight.canUseForCargo ? ['карго не рассчитано — нужен вес с упаковкой'] : []), ...(weight.isEstimated ? ['вес только ориентировочный по категории'] : [])], 10);
  return { status: cargoRub ? 'cost_with_manual_weight' : 'cost_without_cargo', canShowPurchaseRub: true, canShowCostWithoutCargo: true, canShowCargo: !!cargoRub, canShowRoi: false, purchaseRub, costWithoutCargoRub, cargoRub, totalCostRub, manualSalePriceRub: null, scenarioProfitRub: null, scenarioRoiPercent: null, breakEvenPriceRub: null, warnings, nextAction: weight.canUseForCargo ? 'Себестоимость предварительно рассчитана. Перед партией подтвердите SKU, упаковку и образец.' : 'Уточните вес с упаковкой, затем пересчитаю себестоимость.' };
}

export function buildEconomyDecision(priceDecision: PriceDecision, weightDecision: WeightDecision, _marketDecision?: MarketDecision, opts: { yuanToRub?: number; manualSalePriceRub?: number | null } = {}): EconomyDecision {
  const cost = buildCostDecision({ priceDecision, weightDecision, yuanRate: opts.yuanToRub, manualSalePriceRub: opts.manualSalePriceRub });
  return { status: cost.status, canShowCost: cost.canShowCostWithoutCargo, canShowCargo: cost.canShowCargo, canShowMargin: false, canShowRoi: false, costRub: cost.totalCostRub ?? cost.costWithoutCargoRub, costWithoutCargoRub: cost.costWithoutCargoRub, cargoRub: cost.cargoRub, profitRub: null, roiPercent: null, warnings: cost.warnings, nextAction: cost.nextAction };
}

function looksLikeFeature(value: string): boolean {
  return /заявлен|противоскольз|антибактер|влагозащит|защит[а-яё ]*от запах|молни|шнурок|манжет|комплектац|размер|подошв|материал|PVC|ПВХ/i.test(value);
}
function looksLikeColor(value: string): boolean {
  return /^(?:хаки|зел[её]ный|ч[её]рный|черный|белый|молочно-белый|розовый|красный|ж[её]лтый|синий|серый|оранжевый|фиолетовый)(?:[,/ ]|$)/i.test(value.trim());
}
function normalizeAttributePair(nameRaw: unknown, valueRaw: unknown): { name: string; value: string; status: string } | null {
  let name = normalizeFact(nameRaw);
  let value = cautiousClaim(valueRaw);
  if (!name || !value || /^(id|url|debug|raw)$/i.test(name)) return null;
  const nameLower = name.toLowerCase();
  if (/^(?:цвет|颜色|colour|color)$/i.test(nameLower) && !looksLikeColor(value)) {
    if (looksLikeFeature(value)) name = 'Особенность';
    else return null;
  }
  if (/^(?:производитель|место производства|провинция|страна производства)$/i.test(nameLower) && /китай|провинц/i.test(value)) {
    return null;
  }
  if (/бренд/i.test(nameLower) && value.length <= 2) return null;
  const status = /заявлен|подтверд|проверить|уточнить|документ|испытан/i.test(value) ? 'нужно подтвердить' : 'из карточки 1688';
  return { name, value, status };
}

function collectRawAttributes(product: any, limit = 24): Array<{ name: string; value: string; status: string }> {
  const attrs = asArray<any>(product?.normalized1688?.attributes ?? product?.attributes ?? product?.raw1688?.attributesRaw);
  const out: Array<{ name: string; value: string; status: string }> = [];
  for (const a of attrs) {
    const normalized = normalizeAttributePair(a?.name ?? a?.key ?? a?.attrName, a?.value ?? a?.val ?? a?.attrValue);
    if (!normalized) continue;
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}
function collectIntelFacts(product: any, intel = getIntel(product), limit = 20): Array<{ name: string; value: string; status: string }> {
  const id = getIdentity(product, intel); const facts = asRecord((intel as any).facts ?? product?.productContext?.facts);
  const pairs: Array<[string, unknown]> = [['Тип', id.productKind || id.coreObject || titleForReport(product, intel)], ['Форм-фактор', id.formFactor], ['Аудитория', id.audience], ['Пол', id.gender], ['Сезон', id.season], ['Материалы', asArray(id.materials ?? id.material).map((m:any)=> typeof m === 'string' ? m : m?.value).join(', ')], ['Сценарии использования', asArray(id.useCases).join(', ')], ['Видимые особенности', asArray(id.visibleFeatures).join(', ')], ['Важные особенности', asArray(id.importantFeatures).map((v:any)=> typeof v === 'string' ? v : v?.value).join(', ')], ...Object.entries(facts)];
  const out: Array<{ name: string; value: string; status: string }> = [];
  for (const [n, v] of pairs) {
    const normalized = normalizeAttributePair(n, v);
    if (!normalized) continue;
    // Do not expose internal source labels like Product Intelligence to user files.
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}
function mergeFacts(...groups: Array<Array<{ name: string; value: string; status?: string }>>): Array<{ name: string; value: string; status: string }> { const seen = new Set<string>(); const out: Array<{ name: string; value: string; status: string }> = []; for (const g of groups) for (const f of g) { const normalized = normalizeAttributePair(f.name, f.value); if (!normalized) continue; const key = `${normalized.name.toLowerCase()}:${normalized.value.toLowerCase()}`; if (seen.has(key)) continue; seen.add(key); out.push({ ...normalized, status: f.status && !/Product Intelligence|AI-черновик/i.test(f.status) ? f.status : normalized.status }); } return out; }

export function buildReadinessDecision(input: { product: any; intelligence: ProductIntelligenceLike; priceDecision: PriceDecision; weightDecision: WeightDecision; skuDecision?: SkuDecision }): ReadinessDecision {
  const { product, intelligence, priceDecision: price, weightDecision: weight } = input; const sku = input.skuDecision ?? buildSkuDecision(product, intelligence); const facts = mergeFacts(collectIntelFacts(product, intelligence, 8), collectRawAttributes(product, 8));
  let score = 20; const positiveSignals: string[] = []; const blockers: string[] = []; const risks: string[] = []; const missingData: string[] = [];
  if (price.canCalculateCost) { score += 15; positiveSignals.push('цена товара распознана'); } else { score -= 20; blockers.push('нет цены товара'); missingData.push('цена выбранного SKU'); }
  if (positive(product?.moq ?? product?.normalized1688?.moq)) { score += 10; positiveSignals.push('MOQ понятен'); } else { missingData.push('MOQ'); }
  if (sku.skuCount > 0) { score += 15; positiveSignals.push('SKU разобраны'); } else if (sku.needsSelection) { score -= 20; blockers.push('SKU не разобраны'); }
  if (product?.supplierName || product?.supplierType) { score += 10; positiveSignals.push('есть данные поставщика'); } else risks.push('поставщик не описан');
  if (positive(product?.sold ?? product?.normalized1688?.salesCount)) { score += 10; positiveSignals.push('есть продажи/заказы на 1688'); }
  if (imagesCount(product) > 0) { score += 10; positiveSignals.push('есть фото товара'); } else missingData.push('фото товара');
  if (facts.length >= 3) { score += 10; positiveSignals.push('есть характеристики/особенности товара'); } else risks.push('мало характеристик в карточке');
  if (weight.canUseForCargo) { score += 10; positiveSignals.push('есть вес для расчёта карго'); } else { score -= 15; missingData.push('вес с упаковкой'); risks.push('карго нельзя рассчитать точно без веса'); }
  const claimRisk = uniq([...(intelligence.claimsPolicy?.claimedButNeedProof ?? []), ...(intelligence.reportRules?.seoForbiddenClaims ?? []), ...facts.filter(f => /заявлен|документ|испытан|сертифик|спецсвойств/i.test(f.value)).map(f => `${f.name}: ${f.value}`)], 8);
  if (claimRisk.length) { score -= 15; risks.push('есть свойства, которые нужно подтвердить документами/образцом'); } else score += 10;
  if (sku.isMultiPack && !weight.canUseForCargo) { score -= 10; blockers.push('у multi-pack товара нужен вес выбранной комплектации'); }
  score = Math.max(0, Math.min(100, score));
  let status: ReadinessDecision['status'] = 'needs_supplier_confirmation'; let label: ReadinessDecision['label'] = '🟡 Нужны данные';
  if (!price.canCalculateCost) { status = 'not_ready'; label = '🔴 Не готово к закупке'; }
  else if (score >= 75 && weight.canUseForCargo && !claimRisk.length) { status = 'ready_for_sample'; label = '🟢 Можно заказывать образец'; }
  else if (score < 45 || blockers.length >= 2) { status = 'high_risk'; label = '🔴 Высокий риск'; }
  else if (!weight.canUseForCargo || price.needsSkuConfirmation) { status = 'needs_supplier_confirmation'; label = '🟡 Нужны данные'; }
  else { status = 'needs_supplier_confirmation'; label = '🟡 Нужно подтвердить данные'; }
  const nextActions = uniq([...(missingData.length ? ['отправить вопросы поставщику и закрыть недостающие данные'] : []), ...(weight.canUseForCargo ? ['проверить образец и упаковку перед партией'] : ['уточнить вес с упаковкой']), 'подготовить SEO/ТЗ байеру и запросить данные у поставщика', ...(score >= 55 ? ['рассмотреть заказ 1 образца после подтверждения SKU'] : [])], 5);
  return { score, status, label, positiveSignals: uniq(positiveSignals, 8), blockers: uniq(blockers, 8), risks: uniq(risks, 10), missingData: uniq([...missingData, ...(intelligence.dataQuality?.missingCriticalFields ?? [])], 12), nextActions, canRecommendSample: score >= 55 && price.canCalculateCost, canRecommendBatch: false, reason: `${label}. Готовность ${score}/100: ${nextActions[0] ?? 'нужно уточнить данные'}.` };
}

export function buildDecisionContext(product: any) { const intelligence = getIntel(product); const sku = buildSkuDecision(product, intelligence); const price = buildPriceDecision(product, sku); const weight = buildWeightDecision(product, intelligence, sku); const market = buildMarketDecision(product); const economy = buildEconomyDecision(price, weight, market, { yuanToRub: product?.economics?.yuanToRub, manualSalePriceRub: product?.manualSalePriceRub ?? product?.manualSalePrice ?? product?.scenarioSalePriceRub }); const cost = buildCostDecision({ priceDecision: price, weightDecision: weight, yuanRate: product?.economics?.yuanToRub, manualSalePriceRub: product?.manualSalePriceRub ?? product?.manualSalePrice ?? product?.scenarioSalePriceRub }); const readiness = buildReadinessDecision({ product, intelligence, priceDecision: price, weightDecision: weight, skuDecision: sku }); return { intelligence, sku, price, weight, market, economy, cost, readiness, status: readiness.label, title: titleForReport(product, intelligence), categoryType: categoryType(product, intelligence) }; }

export function buildStatusLine(price: PriceDecision, weight: WeightDecision, _market: MarketDecision, _economy: EconomyDecision): string { const readinessLike = (!price.canCalculateCost) ? '🔴 Не готово к закупке' : (!weight.canUseForCargo || price.needsSkuConfirmation) ? '🟡 Нужны данные' : '🟡 Нужно подтвердить данные'; return readinessLike; }

function topQuestions(product: any, x = buildDecisionContext(product), n = 7): string[] { return buildSupplierQuestions(product, x).ru.slice(0, n); }

export function buildMainReport(product: any, statusInfo?: { creditsRemaining?: number }, _wbCategory?: any): string {
  const x = buildDecisionContext(product);
  const source = String(product?.platform ?? '1688').toUpperCase();
  const supplierType = supplierTypeRu(product?.supplierType || product?.normalized1688?.supplierType || 'продавец');
  const supplierRating = normalizeFact(product?.supplierRating ?? product?.normalized1688?.supplierRating);
  const sold = positive(product?.normalized1688?.salesCount ?? product?.sold);
  const moq = positive(product?.normalized1688?.moq ?? product?.moq);
  const materials = materialsLine(x, product);
  const colorLine = x.sku.colorOptions?.length ? `• Цвета: ${x.sku.colorOptions.slice(0, 8).join(', ')}` : null;
  const modelLine = x.sku.sizeOptions?.length
    ? `• Размеры/модели: ${x.sku.sizeOptions.slice(0, 10).join(', ')}`
    : x.sku.ambiguousParams?.length
      ? `• Параметры: ${x.sku.ambiguousParams.slice(0, 8).join(' / ')} — значение нужно уточнить`
      : null;
  const mainWeightText = x.weight.canUseForCargo ? x.weight.displayText.replace(/^Вес:\s*/i, '') : 'не указан';
  const questions = topQuestions(product, x, 5).map(q => q.replace(/^\d+[.)]\s*/, ''));
  const selectedSku = x.sku.ambiguousParams?.length ? 'выберите конкретный цвет и параметр SKU' : (x.sku.recommendedSampleSku || (x.sku.needsSelection ? 'выберите конкретный цвет/размер/модель' : 'уточнить у поставщика'));
  const packageItems = ['вопросы поставщику', 'ТЗ байеру', 'ТЗ карго', 'чек-лист образца', 'SEO-черновик', 'фото товара'];
  const verdict = x.price.canCalculateCost
    ? 'Партию закупать рано. Можно запросить данные и заказать 1–2 образца.'
    : 'Партию закупать рано. Сначала уточните цену выбранного SKU и базовые данные у поставщика.';
  const lines = [
    `📦 <b>${html(x.title)}</b>`,
    '',
    `Источник: ${html(source)}`,
    `Поставщик: ${html([supplierType, supplierRating ? `рейтинг ${supplierRating}` : '', sold ? `заказов ${Math.round(sold).toLocaleString('ru-RU')}` : ''].filter(Boolean).join(' · '))}`,
    '',
    '📌 <b>Товар</b>',
    `• Цена: ${html(displayPriceSummary(x.price.displayPriceText))}`,
    `• Выбранный SKU: ${html(selectedSku)}`,
    `• MOQ: ${moq ? `${Math.round(moq).toLocaleString('ru-RU')} шт.` : 'уточнить'}`,
    `• SKU: ${html(displayMainSkuSummary(x))}`,
    ...(colorLine ? [html(colorLine)] : []),
    ...(modelLine ? [html(modelLine)] : []),
    `• Материал: ${html(materials)}`,
    `• Вес: ${html(mainWeightText)}`,
    '',
    `<b>${html(procurementStatusText(x))}</b>`,
    '',
    '⚠️ <b>Что уточнить</b>',
    ...(questions.length ? questions.map(q => `• ${html(q)}`) : ['• цену, SKU, вес и упаковку выбранного товара']),
    '',
    '💸 <b>Предварительная себестоимость</b>',
    ...buildCostSummaryLines(x).map(html),
    '',
    '📁 <b>Закупочный пакет готов</b>',
    ...packageItems.map(v => `• ${html(v)}`),
    '',
    '🎯 <b>Вывод</b>',
    html(verdict),
    '',
    'Что сделать:',
    '1. Нажмите «💬 Вопросы поставщику».',
    '2. Отправьте текст поставщику в чат 1688.',
    '3. Скачайте закупочный пакет.',
    '',
    `📦 Осталось: ${typeof statusInfo?.creditsRemaining === 'number' ? Math.max(0, statusInfo.creditsRemaining) : 0} анализов`,
  ];
  return lines.join('\n');
}

function procurementStatusText(x: ReturnType<typeof buildDecisionContext>): string {
  if (!x.price.canCalculateCost) return '🔴 Статус: данных мало';
  if (!x.weight.canUseForCargo || x.price.needsSkuConfirmation) return '🟡 Статус: нужны данные поставщика';
  if (x.readiness.status === 'ready_for_sample') return '🟢 Статус: готов к заказу образца';
  return '🟡 Статус: можно запрашивать образец';
}

function materialsLine(x: ReturnType<typeof buildDecisionContext>, product: any): string {
  if (isUmbrella(product, x)) {
    return 'ткань купола, железо/сплав — подтвердить у поставщика';
  }
  const id = x.intelligence.productIdentity ?? {};
  const fromIntel = asArray<any>(id.materials ?? id.material)
    .map((m) => typeof m === 'string' ? m : m?.value)
    .map(normalizeFact)
    .filter(Boolean);
  const fromAttrs = collectRawAttributes(product, 12)
    .filter(f => /материал|材质|材料|пвх|pvc|eva|силикон|пластик|металл|ткан/i.test(`${f.name} ${f.value}`))
    .map(f => f.value);
  const values = uniq([...fromIntel, ...fromAttrs], 4)
    .map(v => v.replace(/понтиж|pongee|碰击|碰击布/gi, 'ткань купола'));
  return values.length ? `${values.join(', ')} — подтвердить у поставщика` : 'уточнить у поставщика';
}
function useCasesLine(x: ReturnType<typeof buildDecisionContext>): string {
  const uses = asArray<string>(x.intelligence.productIdentity?.useCases).map(normalizeFact).filter(Boolean);
  if (uses.length) return uses.slice(0, 4).join(', ');
  const kind = String(x.intelligence.productIdentity?.productKind ?? x.title ?? '').toLowerCase();
  if (/бахил|чехл.*обув|shoe cover/.test(kind)) return 'защита обуви от дождя, грязи и брызг';
  if (/стиральн[а-яё ]*машин|мини[ -]?стирал|washing machine|洗衣机/.test(kind)) return 'стирка небольших вещей, белья и носков дома, на даче или в поездке';
  if (/сабо|обув|сандал|тапоч|кроссов/.test(kind)) return 'повседневная носка, работа, прогулки';
  return '';
}

function buildCostSummaryLines(x: ReturnType<typeof buildDecisionContext>): string[] {
  if (!x.price.canCalculateCost || !x.price.calculationPriceYuan) return ['• Закупка: цену нужно уточнить', '• Без карго: не рассчитано', '• Карго: нужен вес с упаковкой'];
  const lines: string[] = [];
  lines.push(`• Закупка: ${cny(x.price.calculationPriceYuan)}${x.cost.purchaseRub ? ` ≈ ${money(x.cost.purchaseRub)}` : ''}`);
  if (x.cost.costWithoutCargoRub) lines.push(`• Без карго: ~${money(x.cost.costWithoutCargoRub)}`);
  else lines.push('• Без карго: не рассчитано');
  if (x.cost.cargoRub) lines.push(`• Карго: ~${money(x.cost.cargoRub)}`);
  else lines.push('• Карго: нужен вес с упаковкой');
  return lines;
}

function isSleepMask(product: any, x?: ReturnType<typeof buildDecisionContext>): boolean {
  const t = `${x?.title ?? ''} ${product?.titleRu ?? ''} ${product?.titleCn ?? ''} ${product?.categoryName ?? ''}`.toLowerCase();
  return /маск[аи]\s+для\s+сна|3d[ -]?маск|sleep\s*mask|眼罩|睡眠眼罩|遮光眼罩/.test(t);
}

function isUmbrella(product: any, x?: ReturnType<typeof buildDecisionContext>): boolean {
  const t = `${x?.title ?? ''} ${product?.titleRu ?? ''} ${product?.titleCn ?? ''} ${product?.categoryName ?? ''}`.toLowerCase();
  return /зонт|umbrella|雨伞|伞|傘/.test(t);
}

function isSmallAppliance(product: any, x?: ReturnType<typeof buildDecisionContext>): boolean {
  const t = `${x?.title ?? ''} ${product?.titleRu ?? ''} ${product?.titleCn ?? ''} ${product?.categoryName ?? ''}`.toLowerCase();
  return /мини[ -]?стирал|стиральн[а-яё ]*машин|портативн[а-яё ]*стирал|washing\s*machine|洗衣机|内衣洗衣/.test(t);
}

function skipCategoryDefaultWeight(product: any, category: string): boolean {
  const text = `${product?.titleRu ?? ''} ${product?.titleCn ?? ''} ${product?.categoryName ?? ''}`.toLowerCase();
  return category === 'small_appliance' || /стиральн[а-яё ]*машин|洗衣机|объ[её]м\s*\d+\s*л/.test(text);
}


function procurementKind(product: any, x?: ReturnType<typeof buildDecisionContext>): string {
  const cat = String(x?.categoryType ?? categoryType(product)).toLowerCase();
  const t = `${x?.title ?? ''} ${product?.titleRu ?? ''} ${product?.titleCn ?? ''} ${product?.categoryName ?? ''} ${getIdentity(product).productKind ?? ''} ${getIdentity(product).coreObject ?? ''}`.toLowerCase();
  if (isUmbrella(product, x)) return 'umbrella';
  if (isSmallAppliance(product, x)) return 'mini_washer';
  if (isSleepMask(product, x)) return 'sleep_mask';
  if (/пассивн[а-яё ]*ловуш|липк[а-яё ]*ловуш|клеев[а-яё ]*ловуш|捕虫|粘虫|蚊/.test(t) && !/usb|ламп|电|электр|ультразвук/.test(t)) return 'passive_insect_trap';
  if (cat === 'shoes' || /鞋|сабо|сандал|тапоч|шл[её]пан|обув|кроссов/.test(t)) return 'footwear';
  if (/usb|type-c|зарядк|power bank|кабель|adapter|адаптер/.test(t)) return 'usb_device';
  if (cat === 'clothing' || /плать|брюк|леггинс|футбол|одежд|衣|裤/.test(t)) return 'clothing';
  if (/сумк|рюкзак|кошел|bag|包/.test(t)) return 'bag_accessory';
  if (/кухн|нож|овощ|посуда|терк|сковор|锅|厨房/.test(t)) return 'kitchen_tool';
  return 'generic_product';
}

function getProcurementRules(product: any, x?: ReturnType<typeof buildDecisionContext>): ProcurementRules {
  const kind = procurementKind(product, x);
  const base = PROCUREMENT_RULES[kind] ?? GENERIC_PROCUREMENT_RULES;
  return { ...GENERIC_PROCUREMENT_RULES, ...base, productKind: base.productKind || kind };
}

function cleanRuleList(list: string[], product: any, x?: ReturnType<typeof buildDecisionContext>, limit = 12): string[] {
  const banned = new Set<string>();
  const cat = String(x?.categoryType ?? categoryType(product)).toLowerCase();
  const kind = procurementKind(product, x);
  for (const b of [...(CATEGORY_MUST_NOT_ASK[cat] ?? []), ...(CATEGORY_MUST_NOT_ASK[kind] ?? [])]) banned.add(b.toLowerCase());
  return uniq(list, 30)
    .filter((item) => {
      const low = item.toLowerCase();
      return ![...banned].some(b => b && low.includes(b));
    })
    .slice(0, limit);
}

function questionFromCheck(check: string): string {
  const text = stripNumber(check).replace(/[.;]+$/g, '');
  if (!text) return '';
  if (/^(есть ли|можно ли|регулируется ли|работает ли|не давит ли|не теч[её]т ли|как работает|какие|какой|какая|какое|сколько|что означает)/i.test(text)) return `${text}?`;
  if (/подтверд/i.test(text)) return `${text}.`;
  if (/фото|видео/i.test(text)) return `Пришлите ${text}.`;
  if (/вес|габарит|размер|длин|диаметр|объ[её]м|мощность|напряжение|тип вилки|материал|комплектац|упаковк|инструкц|гарант|сертифик/i.test(text)) return `Уточните ${text}.`;
  return `Подтвердите: ${text}.`;
}

function cnQuestionFromCheck(check: string): string {
  const low = check.toLowerCase();
  if (/мощност/.test(low)) return '请确认产品功率。';
  if (/напряж/.test(low)) return '请确认电压。';
  if (/тип вилки/.test(low)) return '请确认插头类型。';
  if (/длина кабеля/.test(low)) return '请确认电源线长度。';
  if (/объ[её]м/.test(low)) return '请确认实际容量。';
  if (/режим/.test(low)) return '请确认工作模式。';
  if (/слив/.test(low)) return '请确认是否有排水口以及如何排水。';
  if (/видео/.test(low)) return '请发送产品工作视频。';
  if (/инструкц/.test(low)) return '请提供说明书照片或电子版。';
  if (/сертифик|деклараци|документ/.test(low)) return '请提供相关证书/检测报告/合规文件。';
  if (/гарант/.test(low)) return '请确认保修和售后政策。';
  if (/вес/.test(low)) return '请提供所选SKU含包装重量。';
  if (/габарит|размер упаков/.test(low)) return '请提供包装尺寸。';
  if (/материал/.test(low)) return '请确认产品材质。';
  if (/комплектац/.test(low)) return '请确认包装清单/配件。';
  if (/фото/.test(low)) return '请发送产品和包装实拍照片。';
  if (/диаметр купола/.test(low)) return '请确认雨伞打开后的伞面直径。';
  if (/длина в сложенном/.test(low)) return '请确认雨伞折叠后的长度。';
  if (/количество спиц/.test(low)) return '请确认伞骨数量。';
  if (/чехол/.test(low)) return '请确认是否包含伞套。';
  if (/ремешок/.test(low)) return '请确认头带是否可调节。';
  if (/затемнен/.test(low)) return '请确认遮光效果，并发送实拍图。';
  return `请确认：${check}。`;
}

export function build1688Detail(product: any): string {
  const p = ensureProductProcurementProfile(product);
  const cleaned = cleanRawAttributes(product?.attributes ?? product?.normalized1688?.attributes ?? [], {
    fashionLike: /clothing|footwear|одежд|обув/i.test(String(p.identity.productKind)),
  });
  const x = buildDecisionContext(product);
  const skuExamples = [
    ...p.sku.normalizedExamples.slice(0, 8),
    ...x.sku.skuVariantsNormalized.slice(0, 6).map(v => v.label),
  ].filter(Boolean).filter((v, i, arr) => arr.findIndex(x => x.toLowerCase() === v.toLowerCase()) === i).slice(0, 8);
  const useful = cleaned.userFacing.slice(0, 10).map(a => `• ${html(a.label)}: ${html(a.value)}`);
  const materialText = p.identity.materials.join(', ') || 'нужно уточнить';
  const supplierName = isMaterialLikeSupplierName(product?.supplierName) ? 'не указано' : (product?.supplierName || p.supplier.name || 'не указано');
  const photoCount = imagesCount(product) || product?.normalized1688?.imageCount || '—';
  const moq = positive(product?.moq ?? product?.normalized1688?.moq);
  const weight = positive(product?.weightKg ?? product?.packedWeightKg ?? product?.normalized1688?.weightKg);
  const detailLines = [
    '📦 <b>Данные товара с 1688</b>',
    '',
    '<b>Название CN:</b>',
    html(stripRawSourceLabels(cleanChineseTitle(product?.titleCn ?? product?.normalized1688?.titleCn ?? '')).replace(/cross[\s-]?border/gi, '').trim() || '—'),
    '',
    '<b>Название RU:</b>',
    html(p.identity.titleForReport),
    '',
    '<b>Цена:</b>',
    html(p.pricing.displayPriceText),
    '',
    '<b>Выбранный SKU:</b>',
    html(p.sku.selectedSkuText ?? 'не определён'),
    '',
    '<b>SKU:</b>',
    html(p.sku.skuSummary),
    ...(skuExamples.length ? skuExamples.map(v => `• ${html(v)}`) : ['• SKU нужно уточнить']),
    '',
    '<b>Поставщик:</b>',
    `• название: ${html(supplierName)}`,
    `• тип: ${html(p.supplier.displayType || 'не указан')}`,
    `• рейтинг: ${html(p.supplier.rating || '—')}`,
    `• заказов: ${html(p.supplier.orders || '—')}`,
    `• MOQ: ${moq ? `${moq} шт.` : 'уточнить'}`,
    '',
    '<b>Ключевые характеристики:</b>',
    `• тип товара: ${html(p.identity.titleForReport)}`,
    p.identity.formFactor ? `• конструкция: ${html(p.identity.formFactor)}` : '',
    p.sku.sizes.length ? `• размер: ${html(p.sku.sizes.join(', '))}` : '',
    `• материал: ${html(materialText)}`,
    ...(useful.length ? useful : []),
    ...(p.identity.useCases.length ? [`• назначение: ${html(p.identity.useCases.slice(0, 3).join(', '))}`] : []),
    '',
    '<b>Логистика:</b>',
    `• вес: ${weight ? `${weight} кг` : 'не указан'}`,
    `• упаковка: ${p.cargo.mustAsk.some(v => /габарит|упаков/i.test(v)) ? 'нужно уточнить' : 'не указана'}`,
    `• фото: ${html(photoCount)}`,
  ].filter(Boolean);
  return detailLines.join('\n');
}

function seoFriendlyTitle(product: any, x: ReturnType<typeof buildDecisionContext>, content: any): string {
  const rawTitle = normalizeFact(content.title || content.titleDraft || (x.intelligence.cleanTitles as any)?.titleForSeo || x.title);
  const text = `${rawTitle} ${product?.titleCn ?? ''}`.toLowerCase();
  if (/бахил|чехл.*обув|鞋套/.test(text)) return 'Бахилы многоразовые водонепроницаемые для обуви';
  if (isSmallAppliance(product, x)) return 'Мини стиральная машина портативная 4 л для белья и носков';
  if (isSleepMask(product, x)) return 'Маска для сна 3D с затемнением мягкая';
  if (isUmbrella(product, x)) return 'Зонт автоматический складной с крючком и чехлом';
  if (/сабо|洞洞鞋|护士鞋/.test(text)) return 'Сабо EVA для работы и повседневной носки';
  if (/сандал|凉鞋/.test(text)) return 'Женские сандалии летние с декоративным элементом';
  return rawTitle || x.title;
}

function seoDescription(product: any, x: ReturnType<typeof buildDecisionContext>, title: string): string {
  const text = `${title} ${product?.titleCn ?? ''}`.toLowerCase();
  const material = materialsLine(x, product).replace(/\s+—\s+подтвердить у поставщика$/i, '');
  if (/бахил|чехл.*обув|鞋套/.test(text)) {
    return 'Высокие многоразовые бахилы помогают защитить обувь от дождя, грязи и брызг во время прогулок, поездок на велосипеде, походов и работы на улице. Модель надевается поверх обуви и подходит для использования в сырую погоду. Перед публикацией подтвердите материал, размерную сетку, вес и заявленные противоскользящие свойства на образце.';
  }
  if (isSmallAppliance(product, x)) {
    return 'Компактная мини-стиральная машина подходит для стирки нижнего белья, носков и небольших вещей дома, на даче или в поездке. Объём 4 л и компактный корпус позволяют использовать её там, где нет места для полноразмерной техники. Перед публикацией подтвердите мощность, напряжение, тип вилки, комплектацию и видео работы.';
  }
  if (isUmbrella(product, x)) {
    return 'Складной автоматический зонт подходит для защиты от дождя во время прогулок, дороги на работу и поездок. Перед публикацией подтвердите диаметр купола, длину в сложенном виде, количество спиц, материал купола и наличие чехла. UPF/защиту от солнца и ветроустойчивость используйте только после подтверждения документов или теста образца.';
  }
  if (isSleepMask(product, x)) {
    return 'Мягкая 3D-маска для сна помогает закрыть глаза от света дома, в дороге, самолёте, поезде или во время отдыха. Объёмная форма снижает давление на глаза и ресницы, а мягкий материал делает маску удобной для ежедневного использования. Перед публикацией подтвердите материал, размер, вес и качество резинки на образце.';
  }
  const uses = useCasesLine(x) || 'использования';
  const features = uniq([...(x.sku.componentOptions ?? []), ...asArray<string>(x.intelligence.productIdentity?.visibleFeatures)], 4).join(', ');
  return `${title} — товар для ${uses}. ${material && material !== 'уточнить у поставщика' ? `Материал: ${material}. ` : ''}${features ? `Ключевые детали: ${features}. ` : ''}Перед публикацией подтвердите выбранный SKU, материал, вес, упаковку и заявленные свойства на образце.`;
}

function seoBullets(product: any, x: ReturnType<typeof buildDecisionContext>): string[] {
  const titleText = `${x.title} ${product?.titleCn ?? ''}`.toLowerCase();
  if (/бахил|чехл.*обув|鞋套/.test(titleText)) {
    return [
      'Защита обуви от дождя, грязи и брызг',
      'Высокая посадка поверх обуви',
      'Подходит для прогулок, велосипеда, походов и работы на улице',
      'Многоразовый формат',
      'Заявленное антискольжение — проверить на образце',
    ];
  }
  if (isSmallAppliance(product, x)) {
    return [
      'Компактный формат для небольших вещей',
      'Подходит для белья, носков и детских вещей',
      'Объём 4 л — подтвердить у поставщика',
      'Несколько цветов и моделей',
      'Перед продажей проверьте мощность и тип вилки',
    ];
  }
  if (isUmbrella(product, x)) {
    return [
      'Автоматическое открытие — подтвердить механизм на образце',
      'Складной формат удобно брать с собой',
      'Купол и спицы нужно проверить на прочность',
      'Чехол и упаковку подтвердить у поставщика',
      'UPF/защиту от солнца писать только после подтверждения',
    ];
  }
  if (isSleepMask(product, x)) {
    return [
      '3D-форма не давит на глаза',
      'Подходит для сна дома и в поездках',
      'Помогает закрыть глаза от света',
      'Несколько цветов и вариантов упаковки',
      'Мягкий материал — подтвердить на образце',
    ];
  }
  const generic = uniq([
    ...(asArray<string>(x.intelligence.productIdentity?.visibleFeatures).map(cautiousClaim)),
    ...(x.sku.componentOptions ?? []),
    ...(useCasesLine(x) ? [`Для: ${useCasesLine(x)}`] : []),
    'Несколько вариантов SKU — выбрать нужный перед заказом',
    'Материал и упаковку подтвердить у поставщика',
    'Перед партией проверить качество образца',
  ], 5);
  while (generic.length < 5) generic.push('Проверить качество и комплектацию на образце');
  return generic.slice(0, 5);
}

export function buildSeoDraft(product: any): string {
  const x = buildDecisionContext(product);
  const rules = getProcurementRules(product, x);
  const content = product?.seoContent ?? {};
  const title = seoFriendlyTitle(product, x, content);
  const description = seoDescription(product, x, title);
  const bullets = seoBullets(product, x);
  const facts = mergeFacts(collectRawAttributes(product, 24), collectIntelFacts(product, x.intelligence, 12))
    .filter(f => !/^(?:производитель|место производства|провинция|бренд|тип|type|material|материал)$/i.test(f.name))
    .filter(f => !/(Product Intelligence|AI-черновик|debug)/i.test(f.value + ' ' + f.status))
    .slice(0, 6);
  const colors = x.sku.colorOptions?.length ? x.sku.colorOptions.join(', ') : null;
  const sizes = x.sku.sizeOptions?.length ? x.sku.sizeOptions.join(', ') : null;
  const keywords = uniq([
    title.toLowerCase(),
    x.title.toLowerCase(),
    ...(asArray<string>(x.intelligence.wbSearch?.queryCandidates).slice(0, 8)),
    ...(colors ? colors.split(', ').map(c => `${x.title.toLowerCase()} ${c}`) : []),
  ], 18);
  return [
    '# SEO-черновик карточки товара',
    '',
    'Статус документа: черновик. Можно использовать после подтверждения веса, материала, размерной сетки и выбранного SKU.',
    '',
    '## Название',
    title,
    '',
    '## Описание',
    description,
    '',
    '## Буллеты',
    ...bullets.map((b, i) => `${i + 1}. ${b}`),
    '',
    '## Характеристики',
    '| Параметр | Значение | Статус |',
    '|---|---|---|',
    ...(isUmbrella(product, x) ? [
      '| Тип | складной автоматический зонт | из карточки, проверить |',
      ...(colors ? [`| Цвета | ${colors} | из SKU |`] : []),
      '| Материал купола | уточнить | подтвердить у поставщика |',
      '| Материал спиц | железо/сплав | подтвердить у поставщика |',
      '| Механизм | автоматический | проверить на образце |',
      '| Защита от солнца | UPF50+ заявлено | не писать без подтверждения |',
    ] : [
      `| Тип | ${x.title} | из карточки |`,
      `| Материал | ${materialsLine(x, product).replace(/\|/g, '/')} | подтвердить |`,
      ...(colors ? [`| Цвета | ${colors} | из SKU |`] : []),
      ...(sizes ? [`| Размеры | ${sizes} | из SKU, уточнить сетку |`] : []),
      ...(x.sku.componentOptions?.length ? [`| Детали | ${x.sku.componentOptions.join(', ')} | из SKU/фото, проверить |`] : []),
    ]),
    ...facts.slice(0, 4).map(f => `| ${f.name.replace(/\|/g, '/')} | ${f.value.replace(/\|/g, '/')} | ${f.status} |`),
    '',
    '## Ключевые слова',
    keywords.join(', '),
    '',
    '## Что уточнить перед публикацией',
    ...uniq([...x.readiness.missingData, 'материал', 'вес с упаковкой', 'реальные фото выбранного SKU'], 7).map(s => `- ${s}`),
    '',
    '## Нельзя писать как факт',
    ...uniq([...(x.intelligence.claimsPolicy?.forbiddenAsFact ?? []), ...rules.seoForbiddenClaims], 10).map(s => `- ${s}`),

    '',
    '## Идеи для инфографики',
    ...((rules.infographicSlides.length ? rules.infographicSlides : GENERIC_PROCUREMENT_RULES.infographicSlides).slice(0, 6).map((slide, i) => `${i + 1}. ${cautiousClaim(slide.title)} — ${cautiousClaim(slide.visual)}`)),
  ].join('\n');
}

export function buildSupplierQuestions(product: any, x = buildDecisionContext(product)): { ru: string[]; cn: string[] } {
  const rules = getProcurementRules(product, x);
  const priceRu = x.price.calculationPriceYuan ? cny(x.price.calculationPriceYuan) : 'цену нужно уточнить';
  const priceCn = x.price.calculationPriceYuan ? cnyCn(x.price.calculationPriceYuan) : '需要确认价格';
  const params = uniq(x.sku.ambiguousParams ?? [], 8);

  if (isUmbrella(product, x)) {
    const ru = uniq([
      x.price.calculationPriceYuan ? `Подтвердите цену выбранного SKU: ${priceRu}.` : 'Укажите цену выбранного SKU.',
      'Укажите вес с упаковкой выбранного SKU.',
      'Укажите габариты индивидуальной упаковки.',
      params.length ? `Что означают параметры SKU ${params.join(' / ')}: диаметр купола, длина в сложенном виде, количество спиц или другой параметр?` : '',
      'Укажите длину зонта в сложенном виде.',
      'Укажите диаметр купола в раскрытом виде.',
      'Сколько спиц у выбранного SKU?',
      'Есть ли чехол в комплекте? Пришлите фото открытого/закрытого зонта и упаковки.',
    ].filter(Boolean), 8);
    const cn = uniq([
      x.price.calculationPriceYuan ? `请确认所选SKU的价格是否为 ${priceCn}。` : '请提供所选SKU的价格。',
      '请提供所选SKU含包装的重量。',
      '请提供单件产品的包装尺寸。',
      params.length ? `SKU参数 ${params.join(' / ')} 分别代表什么：伞面直径、折叠长度、伞骨数量还是其他参数？` : '',
      '请提供雨伞折叠后的长度。',
      '请提供雨伞打开后的伞面直径。',
      '所选SKU有多少根伞骨？',
      '是否包含伞套？请发送打开、折叠状态和包装的实拍照片。',
    ].filter(Boolean), 8);
    return { ru, cn };
  }

  const ru: string[] = [];
  const cn: string[] = [];
  if (x.price.calculationPriceYuan) {
    ru.push(`Подтвердите цену выбранного SKU: ${priceRu}.`);
    cn.push(`请确认所选SKU的价格是否为 ${priceCn}。`);
  } else {
    ru.push('Укажите цену выбранного цвета/размера/комплектации.');
    cn.push('请告诉我所选颜色/尺码/套装的价格。');
  }
  ru.push('Укажите вес с упаковкой выбранного SKU.');
  cn.push('请提供所选SKU含包装的重量。');
  ru.push('Укажите габариты индивидуальной упаковки.');
  cn.push('请提供单件产品包装尺寸。');
  if (params.length) {
    ru.push(`Что означают параметры SKU ${params.join(' / ')}?`);
    cn.push(`SKU参数 ${params.join(' / ')} 分别代表什么？`);
  }
  if (x.sku.needsSelection) {
    ru.push('Подтвердите точную комплектацию выбранного SKU.');
    cn.push('请确认所选SKU的准确套装内容。');
  }

  for (const check of cleanRuleList(rules.buyerMustCheck, product, x, 8)) {
    const q = questionFromCheck(check);
    if (q) ru.push(q);
    cn.push(cnQuestionFromCheck(check));
  }
  ru.push('Пришлите реальные фото товара, выбранного SKU и упаковки.');
  cn.push('请发送所选SKU、产品和包装的实拍照片。');
  ru.push('Можно ли заказать 1–2 образца перед партией?');
  cn.push('批量采购前可以先购买1-2个样品吗？');

  return {
    ru: cleanRuleList(ru, product, x, 8),
    cn: uniq(cn.filter(Boolean), 8),
  };
}

export function buildBuyerBrief(product: any, sourceUrl = ''): string {
  const x = buildDecisionContext(product);
  const rules = getProcurementRules(product, x);
  const skuExamples = x.sku.skuVariantsNormalized.slice(0, 8).map(v => v.label);
  const sampleChecks = cleanRuleList(rules.sampleMustCheck, product, x, 8);
  const buyerChecks = cleanRuleList(rules.buyerMustCheck, product, x, 10);
  return [
    '# ТЗ байеру',
    '',
    'Статус документа: готово для отправки байеру после выбора SKU. После ответа поставщика пакет нужно обновить.',
    '',
    '## 1. Ссылка',
    sourceUrl || '—',
    '',
    '## 2. Что закупаем',
    `Название: ${x.title}`,
    `Цена: ${displayPriceSummary(x.price.displayPriceText)}`,
    `SKU: ${displaySkuSummary(x.sku.skuSummary)}`,
    ...(skuExamples.length ? ['Примеры SKU:', ...skuExamples.map(s => `- ${s}`)] : []),
    `Цвет: ${x.sku.colorOptions?.length ? x.sku.colorOptions.join(', ') : 'уточнить выбранный SKU'}`,
    `Размер/параметр: ${x.sku.sizeOptions?.length ? x.sku.sizeOptions.join(', ') : 'если применимо — уточнить'}`,
    `Комплектация: ${x.sku.componentOptions?.length ? x.sku.componentOptions.join(', ') : (x.sku.isMultiPack ? 'зависит от комплектации' : 'уточнить')}`,
    `MOQ: ${positive(product?.moq ?? product?.normalized1688?.moq) ? `${positive(product?.moq ?? product?.normalized1688?.moq)} шт.` : 'уточнить'}`,
    '',
    '## 3. Поставщик',
    `Название: ${normalizeFact(product?.supplierName) || 'не указано'}`,
    `Тип: ${supplierTypeRu(product?.supplierType) || 'не указан'}`,
    `Рейтинг: ${normalizeFact(product?.supplierRating) || '—'}`,
    `Заказы: ${normalizeFact(product?.sold) || '—'}`,
    '',
    '## 4. Что подтвердить у поставщика',
    ...buyerChecks.map(q => `- ${q}`),
    '',
    '## 5. Что проверить на образце',
    ...sampleChecks.map(q => `- ${q}`),
    '',
    '## 6. Фото, которые нужно запросить',
    '- общий вид выбранного SKU',
    '- крупно материал, рабочие элементы и важные детали',
    '- упаковка и маркировка',
    '- комплектация в одном кадре',
    '- фото рядом с линейкой/размером, если это влияет на закупку',
    '',
    '## 7. Риски',
    ...uniq([...x.readiness.risks, ...x.sku.skuRisks, ...rules.redFlags], 12).map(r => `- ${r}`),
    '',
    '## 8. Решение',
    x.readiness.canRecommendSample ? 'Можно запрашивать данные для образца. Партию не закупать до проверки веса, упаковки и образца.' : 'Пока не готово к закупке: закрыть недостающие данные поставщика.',
  ].join('\n');
}

export function buildCargoBrief(product: any, sourceUrl = ''): string {
  const x = buildDecisionContext(product);
  const rules = getProcurementRules(product, x);
  const cargoChecks = cleanRuleList(rules.cargoMustAsk, product, x, 16);
  return [
    '# ТЗ для карго',
    '',
    'Статус документа: готово для запроса расчёта. Точное карго возможно только после веса и габаритов выбранного SKU.',
    '',
    '## Товар',
    x.title,
    sourceUrl ? `Ссылка: ${sourceUrl}` : '',
    '',
    '## Что нужно запросить',
    ...cargoChecks.map(v => `- ${v}`),
    '',
    '## Текущий статус',
    `Вес: ${x.weight.displayText.replace(/^Вес:\s*/i, '')}`,
    `Габариты: ${product?.supplierAnswer?.dimensions ?? 'уточнить'}`,
    `SKU: ${displaySkuSummary(x.sku.skuSummary)}`,
    '',
    '## Важно',
    'Карго не рассчитывается точно без веса и габаритов выбранного SKU.',
    'Если поставщик не даёт вес/габариты — не считайте финальную себестоимость партии.',
  ].filter(Boolean).join('\n');
}

function categorySpecificSampleChecks(product: any, x: ReturnType<typeof buildDecisionContext>): string[] {
  const rules = getProcurementRules(product, x);
  return cleanRuleList(rules.sampleMustCheck, product, x, 12);
}

export function buildInfographicBrief(product: any): string {
  const x = buildDecisionContext(product);
  const rules = getProcurementRules(product, x);
  const slides = rules.infographicSlides.length ? rules.infographicSlides : GENERIC_PROCUREMENT_RULES.infographicSlides;
  return [
    '# Идеи для инфографики',
    '',
    'Статус документа: черновик для дизайнера. Использовать после подтверждения фото выбранного SKU.',
    '',
    '## Цель карточки',
    'Показать товар, сценарии применения и ключевые преимущества без неподтверждённых claims.',
    '',
    ...slides.slice(0, 6).flatMap((s, i) => [
      `## Слайд ${i + 1} — ${s.title}`,
      `Текст: ${cautiousClaim(s.text)}`,
      `Что показать: ${s.visual}`,
      '',
    ]),
    '## Что нельзя писать',
    ...cleanRuleList(rules.seoForbiddenClaims, product, x, 8).map(v => `- ${v}`),
  ].join('\n');
}

export function buildRiskChecklist(product: any): string {
  const x = buildDecisionContext(product);
  const rules = getProcurementRules(product, x);
  const sampleChecks = cleanRuleList(rules.sampleMustCheck, product, x, 12);
  const redFlags = cleanRuleList(rules.redFlags, product, x, 12);
  const beforeBatch = uniq([
    'проверку ответа поставщика и образца',
    'финальную себестоимость с карго',
    'ответ поставщика по весу, упаковке и выбранному SKU',
    'результат проверки образца',
    ...rules.buyerMustCheck.slice(0, 6),
  ], 12);
  return [
    '# Риск-чеклист товара',
    '',
    'Статус документа: рабочий чек-лист для закупки. Красные флаги обязательны к проверке до партии.',
    '',
    '## Главные риски',
    ...(x.readiness.risks.length ? x.readiness.risks.map(r => `- ${r}`) : ['- данные поставщика и образец ещё не подтверждены']),
    '',
    '## Что проверить до образца',
    ...uniq([...x.readiness.missingData, ...rules.buyerMustCheck.slice(0, 8), 'реальные фото товара и упаковки'], 14).map(m => `- ${m}`),
    '',
    '## Что проверить на образце',
    ...sampleChecks.map(r => `- ${r}`),
    '',
    '## Что проверить перед партией',
    ...beforeBatch.map(v => `- ${v}`),
    '',
    '## Красные флаги',
    ...redFlags.map(v => `- ${v}`),
    '',
    '## Решение',
    x.readiness.canRecommendSample ? 'Можно переходить к образцу после подтверждения SKU, веса и упаковки. Партию не закупать.' : 'Пока не готово к закупке: закрыть недостающие данные.',
  ].join('\n');
}

export function buildSampleRecommendation(product: any): string {
  const x = buildDecisionContext(product);
  const rules = getProcurementRules(product, x);
  const sku = x.sku.recommendedSampleSku || 'базовый/самый массовый SKU';
  const checks = cleanRuleList(rules.sampleMustCheck, product, x, 12);
  const measureItems = cleanRuleList([
    'вес с упаковкой',
    'габариты индивидуальной упаковки',
    ...rules.cargoMustAsk.filter(v => /длина|диаметр|объ[её]м|кабель|габарит|вес|количество|размер/i.test(v)).slice(0, 6),
  ], product, x, 8).map(v => `- ${v}`);
  const photoItems = cleanRuleList([
    'общий вид выбранного SKU',
    'крупно важные детали и рабочие элементы',
    'комплектация в одном кадре',
    'упаковка и маркировка',
    ...rules.infographicSlides.map(s => s.visual),
  ], product, x, 8).map(v => `- ${v}`);
  return [
    '# Рекомендация по образцу',
    '',
    'Статус документа: план проверки образца. Использовать перед заказом 1–2 единиц.',
    '',
    '## Лучше взять',
    `- SKU: ${sku}`,
    '- Количество: 1–2 единицы, не партия',
    '- Почему этот SKU: проверить качество, вес, упаковку и соответствие карточке с минимальным риском',
    '',
    '## Что проверить',
    ...checks.map(c => `- ${c}`),
    '',
    '## Что измерить',
    ...measureItems,
    '',
    '## Какие фото сделать',
    ...photoItems,
    '',
    '## Решение после образца',
    '- брать в тестовую партию',
    '- доработать SKU/упаковку/контент',
    '- не брать, если качество/вес/материал не подтверждены',
  ].join('\n');
}

export function buildSampleChecklist(product: any): string {
  const x = buildDecisionContext(product);
  const rules = getProcurementRules(product, x);
  const sku = x.sku.recommendedSampleSku || 'базовый/самый массовый SKU';
  const params = uniq(x.sku.ambiguousParams ?? [], 8);

  if (isUmbrella(product, x)) {
    const beforeSample = uniq([
      'подтвердить цену выбранного SKU',
      'получить вес и габариты упаковки',
      params.length ? `уточнить параметры SKU ${params.join(' / ')}` : '',
      'запросить фото открытого и закрытого зонта',
      'уточнить наличие чехла',
    ].filter(Boolean), 8);
    const sampleChecks = [
      'работу механизма',
      'прочность спиц',
      'качество ручки',
      'ткань купола',
      'швы',
      'водоотталкивание',
      'размер в раскрытом виде',
      'длину в сложенном виде',
      'упаковку',
    ];
    const redFlags = cleanRuleList([...x.readiness.risks, ...x.sku.skuRisks, ...rules.redFlags], product, x, 10);
    return [
      '# Чек-лист образца',
      '',
      '## До заказа образца',
      ...beforeSample.map(v => `- ${v}`),
      '',
      '## Какой SKU взять',
      `- ${sku}`,
      '- Количество: 1–2 единицы, не партия',
      '',
      '## На образце проверить',
      ...sampleChecks.map(v => `- ${v}`),
      '',
      '## Какие фото сделать',
      '- зонт раскрыт полностью',
      '- зонт в сложенном виде',
      '- кнопка и ручка крупно',
      '- спицы и швы купола',
      '- чехол и упаковка',
      '',
      '## Красные флаги',
      ...(redFlags.length ? redFlags.map(v => `- ${v}`) : ['- поставщик не подтверждает вес, упаковку или выбранный SKU']),
      '',
      '## Решение после образца',
      '- брать в тестовую партию',
      '- доработать SKU/упаковку/контент',
      '- не брать',
    ].join('\n');
  }

  const beforeSample = uniq([
    ...x.readiness.missingData,
    ...rules.buyerMustCheck.slice(0, 6),
    'подтвердить цену выбранного SKU',
    'получить реальные фото товара и упаковки',
  ], 8);
  const sampleChecks = cleanRuleList(rules.sampleMustCheck, product, x, 10);
  const measureItems = cleanRuleList([
    'вес с упаковкой',
    'габариты индивидуальной упаковки',
    ...rules.cargoMustAsk.filter(v => /длина|диаметр|объ[её]м|кабель|габарит|вес|количество|размер|упаков/i.test(v)).slice(0, 5),
  ], product, x, 7);
  const photoItems = cleanRuleList([
    'общий вид выбранного SKU',
    'крупно материал, рабочие элементы и важные детали',
    'комплектация в одном кадре',
    'индивидуальная упаковка и маркировка',
  ], product, x, 6);
  const redFlags = cleanRuleList([...x.readiness.risks, ...x.sku.skuRisks, ...rules.redFlags], product, x, 10);
  return [
    '# Чек-лист образца',
    '',
    '## До заказа образца',
    ...(beforeSample.length ? beforeSample.map(v => `- ${v}`) : ['- подтвердить SKU, цену, вес и упаковку у поставщика']),
    '',
    '## Какой SKU взять',
    `- ${sku}`,
    '- Количество: 1–2 единицы, не партия',
    '',
    '## Что проверить на образце',
    ...(sampleChecks.length ? sampleChecks.map(v => `- ${v}`) : ['- качество материала', '- соответствие SKU', '- упаковку', '- комплектацию']),
    '',
    '## Что измерить',
    ...measureItems.map(v => `- ${v}`),
    '',
    '## Какие фото сделать',
    ...photoItems.map(v => `- ${v}`),
    '',
    '## Красные флаги',
    ...(redFlags.length ? redFlags.map(v => `- ${v}`) : ['- поставщик не подтверждает вес, упаковку или выбранный SKU']),
    '',
    '## Решение после образца',
    '- брать в тестовую партию',
    '- доработать SKU/упаковку/контент',
    '- не брать',
  ].join('\n');
}

export function buildSafeSummary(product: any, reason?: string): string {
  const x = buildDecisionContext(product);
  return [
    '⚠️ <b>Не удалось показать полный отчёт</b>',
    '',
    `Товар: ${html(x.title)}`,
    `Статус: ${html(procurementStatusText(x))}`,
    '',
    `Что случилось: ${html(reason || x.readiness.blockers[0] || x.readiness.risks[0] || 'данные требуют проверки')}`,
    '',
    'Анализ не потерян. Вернитесь к отчёту или начните новый товар.',
  ].join('\n');
}

export function validateGeneratedText(input: { productIntelligence?: ProductIntelligenceLike; generatedText: string; reportType: 'main' | 'detail1688' | 'seo' | 'buyerBrief' | 'supplierQuestions'; categoryType?: string; marketDecision?: MarketDecision; weightDecision?: WeightDecision }): { ok: boolean; errors: string[]; fixedText: string } {
  const errors: string[] = [];
  let fixed = String(input.generatedText ?? '');
  const before = fixed;
  if (/\b(?:undefined|null|NaN|Infinity|-Infinity)\b/i.test(fixed)) errors.push('technical garbage');
  if (/0(?:[,.]0+)?\s*[¥￥₽]/i.test(fixed)) errors.push('zero price');
  if (/0(?:[,.]0+)?\s*(?:кг|kg)\b/i.test(fixed)) errors.push('zero weight');
  if (/Product Intelligence|AI-черновик|debug/i.test(fixed)) errors.push('internal labels');
  fixed = fixed
    .replace(/❌\s*Внутренняя ошибка\.?\s*Попробуй ещё раз\.?/gi, '⚠️ Не удалось открыть раздел. Данные анализа сохранены — вернитесь к отчёту или откройте пакет ещё раз.')
    .replace(/\b(?:undefined|null|NaN|Infinity|-Infinity)\b/gi, '—')
    .replace(/0(?:[,.]0+)?\s*[¥￥]/gi, 'цена уточняется')
    .replace(/0(?:[,.]0+)?\s*₽/gi, 'цена уточняется')
    .replace(/0(?:[,.]0+)?\s*(?:кг|kg)\b/gi, 'вес уточняется')
    .replace(/Product Intelligence|AI-черновик/gi, 'по данным карточки')
    .replace(/медицинск[а-яё]*/gi, '')
    .replace(/ортопедическ[а-яё]*/gi, '')
    .replace(/лечебн[а-яё]*/gi, '')
    .replace(/антибактериальн[а-яё]*/gi, 'обычный')
    .replace(/сертифицированн[а-яё]*/gi, 'требует подтверждения')
    .replace(/""/g, '—')
    .replace(/(^|\n)\s*(?:цвет|color)\s*[:—-]\s*(заявлен[^\n]*|противоскольз[^\n]*|антибактер[^\n]*|влагозащит[^\n]*)/gi, '$1Особенность: $2');
  if (input.reportType !== 'detail1688' && input.reportType !== 'supplierQuestions' && /[一-鿿]/.test(fixed)) {
    errors.push('raw chinese normalized');
    fixed = fixed.split('\n').map(line => normalizeMixedProductText(line)).filter(Boolean).join('\n');
  }
  if (/\bROI\b/i.test(fixed)) {
    errors.push('roi mention');
    fixed = fixed.split('\n').filter(line => !/\bROI\b/i.test(line)).join('\n');
  }
  const category = String(input.categoryType ?? '').toLowerCase();
  if (/shoes|обув/.test(category)) fixed = fixed.replace(/\b(?:мощность|напряжение|аккумулятор|тип вилки|рукав|усадка после стирки)\b[^\n]*/gi, '').replace(/\n{3,}/g, '\n\n');
  if (/passive_insect_trap|ловуш/.test(category)) fixed = fixed.replace(/\b(?:мощность|напряжение|тип вилки|аккумулятор|тип лампы|электрическая)\b[^\n]*/gi, '').replace(/\n{3,}/g, '\n\n');
  if (/мини[ -]?стирал|стиральн[а-яё ]*машин|washing\s*machine|洗衣机/i.test(fixed)) {
    fixed = fixed
      .replace(/\b(?:подошв[аы]|стельк[аи]|длина стельки|рукав|состав ткани в процентах|усадка после стирки|консистенция|срок годности)\b[^\n]*/gi, '')
      .replace(/товар\s+для\s+для/gi, 'товар для')
      .replace(/товар\s+для\s+стирка/gi, 'товар для стирки')
      .replace(/\n{3,}/g, '\n\n');
  }
  if (/маск[аи]\s+для\s+сна|sleep\s*mask|3d-маск/i.test(fixed)) {
    fixed = fixed
      .replace(/\b(?:срок годности|консистенция образца|подошв[аы]|дно|корпус|герметичность упаковки как обязательное|размерная сетка)\b[^\n]*/gi, '')
      .replace(/товар\s+для\s+для/gi, 'товар для')
      .replace(/\n{3,}/g, '\n\n');
  }
  if (/зонт|umbrella|雨伞|伞|傘/i.test(fixed)) {
    fixed = fixed
      .replace(/\b(?:длина стельки|подошв[аы]|стельк[аи]|рукав|мощность|напряжение|аккумулятор|тип вилки|срок годности|консистенция)\b[^\n]*/gi, '')
      .replace(/UFP50/gi, 'UPF50+/UFP50 — уточнить у поставщика')
      .replace(/ветроустойчив[а-яё]*\s+как\s+факт/gi, 'ветроустойчивость — проверить на образце')
      .replace(/\n{3,}/g, '\n\n');
  }
  fixed = fixed.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return { ok: errors.length === 0 || fixed !== before, errors, fixedText: fixed };
}

import type { RawProduct1688, WbFilteredResult, RiskFlags } from '../types';

const ELECTRICAL_KEYWORDS = [
  'электр', 'electric', 'батарей', 'battery', 'аккумулятор', 'зарядн',
  'charger', 'adapter', 'адаптер', 'кабель', 'cable', 'usb', 'led',
  'светодиод', 'лампа', 'lamp', 'light', 'вентилятор', 'fan', 'мотор',
  'motor', 'нагреватель', 'heater', 'блок питания', 'power supply',
  '充电', '电池', '电源', '电动', '插头', '灯', '风扇',
];

const CHILDREN_KEYWORDS = [
  'детск', 'child', 'kids', 'baby', 'младенц', 'новорождённ', 'игрушк',
  'toy', 'коляск', 'stroller', 'соска', 'пустышка', 'подгузник',
  '儿童', '婴儿', '玩具', '宝宝',
];

const COSMETIC_KEYWORDS = [
  'косметик', 'cosmetic', 'крем', 'cream', 'сыворотк', 'serum',
  'маска для лица', 'шампунь', 'shampoo', 'помада', 'lipstick',
  'тушь', 'mascara', 'лосьон', 'lotion', 'парфюм', 'perfume',
  '化妆', '护肤', '面膜', '口红', '洗发',
];

const FOOD_KEYWORDS = [
  'пищев', 'food', 'еда', 'чай', 'tea', 'кофе', 'coffee', 'конфет',
  'candy', 'шоколад', 'chocolate', 'специ', 'spice', 'витамин', 'vitamin',
  'бад', 'supplement', '食品', '茶', '咖啡', '糖果',
];

const MEDICAL_KEYWORDS = [
  'медицин', 'medical', 'ортопед', 'orthopedic', 'массажёр', 'massager',
  'тонометр', 'термометр', 'thermometer', 'бандаж', 'корсет', 'ингалятор',
  'небулайзер', '医疗', '按摩', '矫正',
];

const SIZE_GRID_KEYWORDS = [
  'одежд', 'cloth', 'обувь', 'shoe', 'платье', 'dress', 'куртк', 'jacket',
  'брюки', 'pants', 'джинс', 'jeans', 'футболк', 'shirt', 'юбк', 'skirt',
  'костюм', 'suit', 'пальто', 'coat', 'кроссовк', 'sneaker', 'сандал',
  'sandal', 'сапог', 'boot', 'бюстгальтер', 'bra', 'трусы', 'белье',
  'размер', 'size', '服装', '鞋', '衣服', '裙', '裤',
];

const BRAND_MARKERS = [
  /(?:^|\s)(VICH|Xiaomi|Baseus|Anker|Ugreen|HOCO|Remax|Nillkin|ZMI|Orico|Lenovo|Samsung|Huawei|JBL|Sony|Apple|Nike|Adidas|Puma|Reebok|New Balance)\b/i,
];

function textPool(product: RawProduct1688): string {
  const parts = [
    product.titleCn,
    product.titleEn ?? '',
    product.categoryName ?? '',
    product.description ?? '',
    ...(product.attributes?.map((a) => `${a.name} ${a.value}`) ?? []),
  ];
  return parts.join(' ').toLowerCase();
}

function hasKeyword(text: string, keywords: string[]): boolean {
  return keywords.some((kw) => text.includes(kw.toLowerCase()));
}

function detectBrand(product: RawProduct1688): string | undefined {
  const text = `${product.titleCn} ${product.titleEn ?? ''} ${product.supplierName}`;
  for (const re of BRAND_MARKERS) {
    const m = text.match(re);
    if (m) return m[1];
  }
  return undefined;
}

export function buildRiskFlags(
  product: RawProduct1688,
  wbFiltered: WbFilteredResult | null
): RiskFlags {
  const text = textPool(product);
  const brand = detectBrand(product);

  return {
    hasBrand: !!brand,
    brand,
    isElectrical: hasKeyword(text, ELECTRICAL_KEYWORDS),
    isChildren: hasKeyword(text, CHILDREN_KEYWORDS),
    isCosmetic: hasKeyword(text, COSMETIC_KEYWORDS),
    isFood: hasKeyword(text, FOOD_KEYWORDS),
    isMedical: hasKeyword(text, MEDICAL_KEYWORDS),
    supplierOrdersLow: (product.sold ?? 0) < 10,
    supplierTypeUnknown: !product.supplierType,
    weightMissing: !product.weightKg || product.weightKg <= 0,
    sizeGridRelevant: hasKeyword(text, SIZE_GRID_KEYWORDS),
    marketDataUnreliable: !wbFiltered || wbFiltered.quality === 'unreliable' || wbFiltered.quality === 'unavailable',
  };
}

export function formatRiskMessages(flags: RiskFlags): string[] {
  const msgs: string[] = [];

  if (flags.hasBrand && flags.brand) {
    msgs.push(`Обнаружен бренд ${flags.brand}. Не используйте его в карточке WB без подтверждённых прав на товарный знак.`);
  }
  if (flags.isElectrical) {
    msgs.push('Электротовар: уточните параметры питания, комплектацию и обязательные документы перед закупкой.');
  }
  if (flags.isChildren) {
    msgs.push('Детский товар: проверьте обязательные сертификаты и документы перед закупкой.');
  }
  if (flags.isCosmetic) {
    msgs.push('Косметический товар: проверьте сертификаты, состав и разрешения для импорта.');
  }
  if (flags.isFood) {
    msgs.push('Пищевой товар: проверьте разрешения на импорт, сроки годности и сертификаты.');
  }
  if (flags.isMedical) {
    msgs.push('Медицинский товар: проверьте регистрационные удостоверения и сертификаты.');
  }
  if (flags.supplierOrdersLow) {
    msgs.push('У поставщика мало подтверждённых заказов. Запросите образец и реальные фото/видео.');
  }
  if (flags.weightMissing) {
    msgs.push('Вес не указан. Карго и итоговая себестоимость рассчитаны неточно или не рассчитаны.');
  }
  if (flags.marketDataUnreliable) {
    msgs.push('Данные WB ограничены. Не используйте автоматическую цену как финальное решение о закупке.');
  }
  if (flags.sizeGridRelevant) {
    msgs.push('Размеры поставщика могут отличаться от российских. Запросите таблицу размеров в сантиметрах.');
  }

  return msgs;
}

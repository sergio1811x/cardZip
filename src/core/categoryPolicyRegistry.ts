import type { CategoryPolicyProfile, ProductCapability } from '../types';

const COMMON_FORBIDDEN_CLAIMS = [
  'сертифицированный',
  'безопасный для детей',
  'гипоаллергенный',
  'лечебный',
  'ортопедический',
  'антибактериальный',
  'оригинальный бренд',
];

function uniqueCapabilities(values: ProductCapability[]): ProductCapability[] {
  return Array.from(new Set(values));
}

export function buildCategoryPolicyProfile(input: {
  categoryType?: string | null;
  title?: string | null;
  attributes?: Array<{ name: string; value: string }> | null;
}): CategoryPolicyProfile {
  const categoryType = String(input.categoryType ?? 'other').toLowerCase() || 'other';
  const title = `${input.title ?? ''} ${(input.attributes ?? []).map((item) => `${item.name} ${item.value}`).join(' ')}`.toLowerCase();

  const capabilities: ProductCapability[] = [];
  const requiredSupplierFacts = ['выбранный SKU', 'цена выбранного SKU'];
  const requiredCargoFacts = ['вес с упаковкой', 'габариты индивидуальной упаковки'];
  const criticalWarnings: string[] = [];

  if (/обув|shoes|footwear/.test(categoryType)) capabilities.push('footwear', 'wearable');
  if (/одеж|clothes|textile/.test(categoryType)) capabilities.push('textile', 'wearable');
  if (/элект|electronics|electric/.test(categoryType) || /usb|заряд|питани|мощност|вольт|аккумулятор/.test(title)) {
    capabilities.push('electrical');
  }
  if (/аккумулятор|battery|锂电/.test(title)) capabilities.push('battery');
  if (/вилка|plug|eu|us|uk|jp/.test(title)) capabilities.push('plug_required');
  if (/надув|inflatable|充气/.test(title)) {
    capabilities.push('inflatable', 'assembled_size_differs_from_package_size', 'home_furniture');
    requiredSupplierFacts.push('максимальная нагрузка', 'материал ПВХ/покрытия');
    criticalWarnings.push('Для надувных товаров размеры в надутом состоянии нельзя использовать как размеры упаковки.');
  }
  if (/дет|kids|children/.test(title)) capabilities.push('kids_risk');
  if (/food|пищев|кух/.test(title) || /kitchen/.test(categoryType)) capabilities.push('food_contact');
  if (/medical|лечеб|ортопед|гипоаллерген|антибактери/.test(title)) capabilities.push('medical_claim_risk');
  if (/стекл|glass|хрупк|fragile|ceramic|керамик/.test(title)) capabilities.push('fragile');
  if (/beauty|cosmetic|космет/.test(categoryType)) capabilities.push('cosmetic');
  if (/outdoor|улиц|сад|туризм|camp/.test(title)) capabilities.push('outdoor');

  if (capabilities.includes('electrical')) {
    requiredSupplierFacts.push('напряжение/мощность', 'тип вилки или питания');
  }
  if (capabilities.includes('battery')) {
    requiredSupplierFacts.push('тип аккумулятора', 'ёмкость аккумулятора');
    requiredCargoFacts.push('ограничения на перевозку аккумуляторов');
  }
  if (capabilities.includes('textile')) {
    requiredSupplierFacts.push('состав материала', 'размерная сетка');
  }
  if (capabilities.includes('footwear')) {
    requiredSupplierFacts.push('длина стельки', 'размерная сетка');
  }
  if (capabilities.includes('food_contact')) {
    criticalWarnings.push('Пищевой контакт нельзя обещать без документов.');
  }

  return {
    categoryType,
    capabilities: uniqueCapabilities(capabilities),
    requiredSupplierFacts: Array.from(new Set(requiredSupplierFacts)),
    requiredCargoFacts: Array.from(new Set(requiredCargoFacts)),
    forbiddenSeoClaims: COMMON_FORBIDDEN_CLAIMS,
    criticalWarnings: Array.from(new Set(criticalWarnings)),
  };
}

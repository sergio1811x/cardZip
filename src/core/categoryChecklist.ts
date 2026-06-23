import type { RiskFlags } from '../types';

const CLOTHING_CHECKLIST = [
  'Размерная таблица в сантиметрах',
  'Замеры изделия (длина, ширина, рукав)',
  'Состав ткани в процентах',
  'Плотность ткани (г/м²)',
  'Усадка после стирки',
  'Реальные фото на модели + рост и параметры',
  'Наличие бирок, составников, маркировки',
  'Упаковка',
];

const ELECTRONICS_CHECKLIST = [
  'Напряжение и мощность (220V?)',
  'Тип вилки (Евро/Китай)',
  'Аккумулятор: наличие и ёмкость (мАч)',
  'Сертификаты и декларации',
  'Инструкция на русском',
  'Гарантия производителя',
  'Вес и размеры с упаковкой',
  'Тестовое видео работы',
  'Процент брака',
  'Нейтральная упаковка',
];

const HOME_TEXTILE_CHECKLIST = [
  'Материал и плотность',
  'Размеры в сантиметрах',
  'Вес с упаковкой',
  'Комплектация',
  'Устойчивость цвета (линяет?)',
  'Упаковка',
  'Реальные фото',
];

const FRAGILE_CHECKLIST = [
  'Усиленная обрешётка при карго',
  'Дополнительная упаковка (пенопласт/пузырчатая плёнка)',
  'Страховка при доставке',
  'Процент боя при транспортировке',
];

export function getCategoryChecklist(riskFlags: RiskFlags, categoryHint?: string): string[] {
  const text = (categoryHint ?? '').toLowerCase();
  const checks: string[] = [];

  if (riskFlags.sizeGridRelevant) {
    checks.push(...CLOTHING_CHECKLIST);
  } else if (riskFlags.isElectrical) {
    checks.push(...ELECTRONICS_CHECKLIST);
  } else if (/текстил|ткан|постел|полотенц|плед|одеял|подушк/i.test(text)) {
    checks.push(...HOME_TEXTILE_CHECKLIST);
  }

  if (/стекл|керамик|фарфор|хрупк|glass|ceramic|porcelain/i.test(text)) {
    checks.push(...FRAGILE_CHECKLIST);
  }

  return checks;
}

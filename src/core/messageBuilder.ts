import { Markup } from 'telegraf';
import type { ProductWithContent, SubscriptionStatus, ProductAttribute, PriceRange } from '../types';
import type { WbCategory } from '../db/queries/wbCategories';
import { getCategoryRules, detectCategoryFromAttributes, type ProductCategoryType } from './categoryRules';

function esc(s: unknown): string {
  const str = String(s ?? '');
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sanitize(text: string): string {
  return text
    .replace(/file:\/\/\/[^\s]+/gi, '')
    .replace(/\/(?:tmp|var|home|Users)\/[^\s]+/g, '')
    .trim();
}

function fP(n: number): string {
  return Math.round(n).toLocaleString('ru-RU') + ' ₽';
}

function fN(n: number): string {
  return n.toLocaleString('ru-RU');
}

function pluralize(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

function formatCreditsLine(status: SubscriptionStatus): string {
  if (status.plan === 'week') {
    const word = pluralize(status.creditsRemaining, 'анализ', 'анализа', 'анализов');
    let line = `⚡ Pro-неделя`;
    if (status.activeUntil) line += ` до ${status.activeUntil.toLocaleDateString('ru-RU')}`;
    return line + ` · осталось ${status.creditsRemaining} ${word}`;
  }
  if (status.creditsRemaining <= 0) return '📦 Анализы использованы.';
  const word = pluralize(status.creditsRemaining, 'анализ', 'анализа', 'анализов');
  return `📦 Осталось: ${status.creditsRemaining} ${word}`;
}

// ─── CN→RU перевод атрибутов ─────────────────────────────────────────────────

const CN_ATTR_NAMES: Record<string, string> = {
  '适用性别': 'Пол', '性别': 'Пол',
  '鞋底材质': 'Материал подошвы', '鞋面材质': 'Материал верха',
  '材质': 'Материал', '面料': 'Материал', '材料': 'Материал',
  '功能': 'Функция', '风格': 'Стиль', '适用季节': 'Сезон', '季节': 'Сезон',
  '是否外贸': 'Для экспорта', '颜色': 'Цвет', '尺码': 'Размер',
  '适用场景': 'Назначение', '适用范围': 'Область применения',
  '图案': 'Рисунок', '厚薄': 'Толщина',
  '弹力': 'Эластичность', '产地': 'Происхождение', '品牌': 'Бренд',
  '是否进口': 'Импорт', '加工定制': 'Кастомизация',
  '额定电压': 'Напряжение', '外形尺寸': 'Форма / размер',
  '型号': 'Модель', '电源方式': 'Тип питания', '功率': 'Мощность',
  '订货号': 'Артикул', '货号': 'Артикул',
  '重量': 'Вес', '包装': 'Упаковка', '尺寸': 'Размер',
  '适用人群': 'Целевая аудитория', '类型': 'Тип',
  '产品类别': 'Тип товара', '产品名称': 'Название',
  '原产国/地区': 'Регион производства',
  '是否有专利': 'Патент', '是否跨境出口': 'Экспорт',
  '长度': 'Длина', '宽度': 'Ширина', '高度': 'Высота',
  '容量': 'Объём', '适用年龄': 'Возраст',
  '刀刃材质': 'Материал лезвия', '手柄材质': 'Материал рукоятки',
  '刀刃长度': 'Длина лезвия',
  '裤长': 'Длина брюк', '裙长': 'Длина юбки', '袖长': 'Длина рукава',
  '领型': 'Тип воротника', '袖型': 'Тип рукава', '版型': 'Крой',
  '腰型': 'Тип талии', '裤型': 'Тип брюк', '闭合方式': 'Застёжка',
  '衣长': 'Длина изделия', '厚度': 'Толщина', '克重': 'Плотность ткани',
  '面料名称': 'Название ткани', '面料成分': 'Состав ткани',
  '主面料成分': 'Основной состав', '主面料成分的含量': 'Содержание',
};

const SKIP_ATTR_MAIN: Set<string> = new Set([
  '订货号', '货号', '型号', '是否进口', '加工定制', '是否外贸',
  '品牌', '产地', '是否有专利', '是否跨境出口', '原产国/地区',
]);

function isJunkAttrValue(value: string): boolean {
  if (!value || value === '/' || value === '-' || value === '无' || value === 'null') return true;
  if (value.length > 40) return true;
  return false;
}

function hasUntranslatedChinese(text: string): boolean {
  return /[一-鿿]/.test(text);
}

const CN_ATTR_VALUES: Record<string, string> = {
  '中性/男女均可': 'унисекс', '中性': 'унисекс', '男女均可': 'унисекс',
  '男': 'мужской', '女': 'женский',
  '否': 'нет', '是': 'да',
  '透气': 'дышащие', '防滑': 'нескользящие', '保暖': 'утеплённые',
  '春': 'весна', '夏': 'лето', '秋': 'осень', '冬': 'зима',
  '春夏': 'весна-лето', '秋冬': 'осень-зима', '四季': 'все сезоны',
  '圆形': 'круглая', '方形': 'квадратная', '长方形': 'прямоугольная',
  '中国': 'Китай', '国产': 'Китай',
  '不锈钢': 'нержавеющая сталь', '碳钢': 'углеродистая сталь',
  '塑料': 'пластик', '木': 'дерево', '竹': 'бамбук',
  '斩切刀': 'нож-секач', '切片刀': 'нож для нарезки',
  '无': 'нет',
  // Цвета
  '黑色': 'чёрный', '白色': 'белый', '红色': 'красный', '蓝色': 'синий',
  '绿色': 'зелёный', '黄色': 'жёлтый', '粉色': 'розовый', '紫色': 'фиолетовый',
  '灰色': 'серый', '棕色': 'коричневый', '橙色': 'оранжевый', '米色': 'бежевый',
  '卡其色': 'хаки', '驼色': 'верблюжий', '藏青色': 'тёмно-синий', '酒红色': 'бордовый',
  '咖啡色': 'кофейный', '杏色': 'абрикосовый', '深蓝': 'тёмно-синий',
  '浅蓝': 'голубой', '深灰': 'тёмно-серый', '浅灰': 'светло-серый',
  '黑': 'чёрный', '白': 'белый', '红': 'красный', '蓝': 'синий',
  '绿': 'зелёный', '粉': 'розовый', '灰': 'серый',
  // Функции / свойства одежды
  '高腰': 'завышенная талия', '低腰': 'заниженная талия', '中腰': 'средняя талия',
  '修身': 'приталенный', '宽松': 'свободный', '直筒': 'прямой крой',
  '收腰': 'с акцентом на талии', '显瘦': 'стройнящий',
  '加绒': 'с начёсом', '加厚': 'утеплённый',
  // Материалы
  '锦氨': 'нейлон-спандекс', '纯棉': 'хлопок 100%', '棉': 'хлопок',
  '涤纶': 'полиэстер', '氨纶': 'спандекс', '锦纶': 'нейлон',
  '丝绸': 'шёлк', '麻': 'лён', '羊毛': 'шерсть', '羊绒': 'кашемир',
  '莫代尔': 'модал', '冰丝': 'ледяной шёлк (вискоза)',
  '雪纺': 'шифон', '牛仔': 'джинса/деним', '皮革': 'кожа', '人造革': 'искусственная кожа',
  '帆布': 'холст/канвас', '网纱': 'сетка/тюль', '蕾丝': 'кружево',
  '珊瑚绒': 'велсофт', '法兰绒': 'фланель',
};

function translateAttrName(cn: string): string | null {
  if (CN_ATTR_NAMES[cn]) return CN_ATTR_NAMES[cn];
  for (const [key, val] of Object.entries(CN_ATTR_NAMES)) {
    if (cn.includes(key)) return val;
  }
  return null;
}

function translateAttrValue(cn: string): string {
  if (CN_ATTR_VALUES[cn]) return CN_ATTR_VALUES[cn];
  let result = cn;
  for (const [key, val] of Object.entries(CN_ATTR_VALUES)) {
    if (key.length >= 2 && result.includes(key)) {
      result = result.replace(key, val);
    }
  }
  return result;
}

function formatTiersShort(pr: PriceRange[]): string {
  const valid = pr.filter((r) => r.minQty > 0);
  if (!valid.length) return 'не распознаны';
  return valid.map((r) => `${r.minQty}+ → ${r.price}¥`).join(', ');
}

const SUPPLIER_TYPE_RU: Record<string, string> = {
  factory: 'фабрика',
  merchant: 'проверенный продавец',
  seller: 'обычный продавец',
};

function fWeight(w: number): string {
  if (w <= 0) return 'не указан';
  return `~${w.toFixed(2)} кг`;
}

function fRevenue(rub: number): string {
  if (rub >= 1_000_000_000) return `~${(rub / 1_000_000_000).toFixed(1)} млрд ₽/нед`;
  if (rub >= 1_000_000) return `~${(rub / 1_000_000).toFixed(1)} млн ₽/нед`;
  if (rub >= 1_000) return `~${(rub / 1_000).toFixed(0)} тыс ₽/нед`;
  return `${fP(rub)}/нед`;
}

function formatPriceDisplay(product: ProductWithContent): string {
  const pricing = product.normalized1688?.pricing;
  const price = pricing?.displayPriceYuan ?? product.priceYuan;
  if (!price || price <= 0) return 'нужно уточнить';

  if (pricing) {
    if (pricing.quoteType === 'by_sku' && pricing.skuMinPriceYuan && pricing.skuMaxPriceYuan && pricing.skuMinPriceYuan !== pricing.skuMaxPriceYuan) {
      return `${pricing.skuMinPriceYuan}–${pricing.skuMaxPriceYuan} ¥`;
    }
    if (pricing.quoteType === 'by_volume' && pricing.volumeMinPriceYuan && pricing.volumeMaxPriceYuan && pricing.volumeMinPriceYuan !== pricing.volumeMaxPriceYuan) {
      return `${pricing.volumeMinPriceYuan}–${pricing.volumeMaxPriceYuan} ¥`;
    }
    return `${pricing.displayPriceYuan} ¥`;
  }

  if (product.priceRange?.length) {
    const valid = product.priceRange.filter((r) => r.minQty > 0);
    if (valid.length) return `от ${valid[valid.length - 1].price} ¥`;
    const prices = product.priceRange.map((r) => r.price).filter(Boolean);
    if (prices.length) return `от ${Math.min(...prices)} ¥`;
  }

  return `${price} ¥`;
}


const PLATFORM_LABELS: Record<string, string> = {
  '1688': '1688',
  taobao: 'Taobao',
  tmall: 'Tmall',
};

// ─── Главное сообщение (единственное после анализа) ─────────────────────────

export function buildMainMessage(
  product: ProductWithContent,
  jobId: string,
  status?: SubscriptionStatus,
  wbCategory?: WbCategory | null,
): {
  text: string;
  keyboard: ReturnType<typeof Markup.inlineKeyboard>;
} {
  const { wbFiltered, economics, conclusion, similarityData: sim } = product;
  if (!economics) {
    return { text: '❌ Данные анализа неполные.', keyboard: Markup.inlineKeyboard([[Markup.button.callback('🔄 Новый товар', 'new_search')]]) };
  }
  const safeConclusion = conclusion ?? { platform: product.platform, icon: '🟡', headline: 'Нужны данные для оценки', disclaimers: [] };
  const catType: ProductCategoryType = ((product as any).categoryType as ProductCategoryType) ??
    detectCategoryFromAttributes(product.categoryName, product.attributes ?? [], product.titleCn);
  const wm = economics.weightMissing;
  const directLocalCount = sim?.directCount ?? 0;
  const crossBorderCount = sim?.crossBorderCount ?? 0;
  const hasConfirmedAnalogs = directLocalCount > 0;
  const hasMarket = !!(wbFiltered && wbFiltered.relevantCount > 0 && wbFiltered.medianPrice > 0);
  const L: string[] = [];

  // ─── Товар ──────────────────────────────────────────────────────────────────
  L.push(`📦 <b>${esc(product.titleRu)}</b>`);
  L.push('');
  L.push(`Источник: ${PLATFORM_LABELS[product.platform] ?? product.platform}`);

  const priceStr = formatPriceDisplay(product);
  const econ = product.economics;
  if (priceStr === 'нужно уточнить') {
    L.push('Цена: нужно уточнить');
  } else if (econ && econ.breakdown?.purchaseRub > 0 && !priceStr.startsWith('от ')) {
    L.push(`Цена: ${priceStr} ≈ ${fP(econ.breakdown.purchaseRub)}`);
  } else {
    L.push(`Цена: ${priceStr}`);
  }
  if (product.supplierName) L.push(`Поставщик: ${esc(product.supplierName)}`);

  const priceIsZero = !product.priceYuan || product.priceYuan <= 0;

  // ─── Данные 1688 (выжимка) ─────────────────────────────────────────────────
  L.push('');
  L.push('📌 <b>Данные 1688</b>');
  const normalized = product.normalized1688;

  // Переведённые атрибуты (только полезные, без технических)
  const translatedAttrs: { label: string; value: string }[] = [];
  const rawAttrs = normalized?.keyAttributes ?? product.attributes ?? [];
  for (const a of rawAttrs) {
    const name = (a as any).label ?? (a as any).name ?? '';
    const val = (a as any).value ?? '';
    if (SKIP_ATTR_MAIN.has(name)) continue;
    if (isJunkAttrValue(val)) continue;
    const ruName = translateAttrName(name);
    if (!ruName) continue;
    const ruVal = translateAttrValue(val);
    if (hasUntranslatedChinese(ruVal)) continue;
    translatedAttrs.push({ label: ruName, value: ruVal });
  }

  L.push(`• Тип поставщика: ${SUPPLIER_TYPE_RU[normalized?.supplierType ?? product.supplierType ?? ''] ?? 'не указан'}`);
  L.push(`• MOQ: ${(normalized?.moq ?? product.moq) > 1 ? `${normalized?.moq ?? product.moq} шт` : 'не указан'}`);
  const skuCount = normalized?.skuCount ?? product.skus?.length ?? 0;
  const skuQuoteType = normalized?.pricing?.quoteType;
  if (skuCount > 0) {
    L.push(`• SKU: ${skuCount} вариантов`);
  } else if (skuQuoteType === 'by_sku') {
    L.push('• SKU: варианты не загружены');
  } else {
    L.push('• SKU: не предусмотрены');
  }
  L.push(`• Фото: ${normalized?.imageCount ?? product.images?.length ?? 0} шт`);
  L.push(`• Вес: ${fWeight(product.weightKg)}`);
  const catForbidden = getCategoryRules(catType).forbiddenFields;
  translatedAttrs
    .filter((a) => !catForbidden.some((f) => a.label.toLowerCase().includes(f.toLowerCase())))
    .slice(0, 4)
    .forEach((a) => L.push(`• ${a.label}: ${esc(a.value)}`));
  const hasTiers = product.priceRange?.some((r) => r.minQty > 0);
  if (hasTiers) L.push(`• Скидки: ${formatTiersShort(product.priceRange!)}`);

  // ─── Статус ─────────────────────────────────────────────────────────────────
  L.push('');
  if (wm || !hasConfirmedAnalogs) {
    L.push('🟡 <b>Статус: нужны данные</b>');
  } else if (economics.grossProfitRub > 0) {
    L.push('🟢 <b>Статус: можно тестировать</b>');
  } else {
    L.push('🔴 <b>Статус: экономика слабая</b>');
  }

  // ─── Рынок WB ──────────────────────────────────────────────────────────────
  L.push('');
  L.push('🔎 <b>Рынок WB</b>');
  const wb429 = !!(product as any).wb429;
  if (wb429) {
    L.push('WB временно ограничил поиск. Прямые локальные аналоги не подтверждены.');
  } else if (hasConfirmedAnalogs) {
    L.push(`Прямые локальные аналоги: ${directLocalCount}`);
    if (hasMarket) L.push(`Медиана цены: ${fP(wbFiltered!.medianPrice)}`);
  } else {
    L.push('Прямые локальные аналоги не подтверждены.');
    if (crossBorderCount > 0) {
      L.push(`Найден${crossBorderCount > 1 ? 'о' : ''} ${crossBorderCount} cross-border ${crossBorderCount === 1 ? 'товар' : 'товаров'} — не используем для экономики.`);
    }
    if (sim?.similarCount && sim.similarCount > 0) L.push(`Похожие товары: ${sim.similarCount}`);
    if (sim?.categoryCount && sim.categoryCount > 0) L.push(`Широкая категория: ${sim.categoryCount}`);
  }

  if (wbCategory && !hasConfirmedAnalogs) {
    L.push('');
    L.push(`📊 <b>Категория WB: ${esc(wbCategory.item)}</b>`);
    L.push('<i>Данные по категории, не по конкретному товару.</i>');
    if (wbCategory.average_check_rub > 0) L.push(`Средний чек: ${fP(wbCategory.average_check_rub)}`);
    L.push(`Продавцов: ${fN(wbCategory.sellers)} (с заказами: ${fN(wbCategory.sellers_with_orders)})`);
    if (wbCategory.revenue_rub > 0) L.push(`Выручка: ${fRevenue(wbCategory.revenue_rub)}`);
    if (wbCategory.availability && wbCategory.availability !== 'Не рассчитано') L.push(`Наличие: ${wbCategory.availability}`);
  }

  // ─── Запросы WB (тренды) ────────────────────────────────────────────────────
  const wbTrends = (product as any).wbTrends as Array<{ search_words: string; weeks_request_per_day: number }> | undefined;
  if (wbTrends?.length) {
    L.push('');
    L.push('🔑 <b>Запросы WB</b>');
    wbTrends.slice(0, 5).forEach((t) => {
      const rpd = t.weeks_request_per_day;
      const label = rpd >= 1000 ? `~${(rpd / 1000).toFixed(1)}к/день` : `~${rpd}/день`;
      L.push(`• ${esc(t.search_words)} — ${label}`);
    });
  }

  // ─── Экономика ──────────────────────────────────────────────────────────────
  L.push('');
  L.push('💰 <b>Экономика</b>');
  if (priceIsZero) {
    L.push('Не рассчитана — цена не распознана.');
  } else if (economics.platformMode === 'full') {
    if (wm) {
      L.push(`Предварительно без карго. Себестоимость без карго: ${fP(economics.costRub)}`);
      L.push('Вес не указан — карго, маржа и ROI не рассчитаны.');
    } else if (!hasConfirmedAnalogs || economics.isSyntheticPrice) {
      L.push(`Себестоимость: ${fP(economics.costRub)}. ROI не рассчитан: нет прямых WB-аналогов.`);
    } else {
      L.push(`Себестоимость: ${fP(economics.costRub)}`);
      if (wbFiltered) {
        const b = economics.breakdown;
        const profitMed = wbFiltered.medianPrice - economics.costRub
          - Math.round(wbFiltered.medianPrice * 0.20) - 100
          - Math.round(wbFiltered.medianPrice * b.drrPercent / 100)
          - Math.round(wbFiltered.medianPrice * 0.07);
        const sign = profitMed >= 0 ? '+' : '';
        L.push(`Прибыль (медиана): ${sign}${fP(profitMed)}`);
        if (economics.roiPercent) L.push(`ROI: ${economics.roiPercent}%`);
        if (directLocalCount >= 1 && directLocalCount <= 4) {
          L.push(`<i>⚠️ Ограниченная выборка (${directLocalCount} ${pluralize(directLocalCount, 'аналог', 'аналога', 'аналогов')})</i>`);
        }
      }
    }
  } else if (economics.platformMode === 'sample_only') {
    L.push(`Образец: ~${fP(economics.costRub)}`);
    L.push('Это розничная цена, не цена партии.');
  } else {
    L.push(`Витрина: ${economics.breakdown.purchaseYuan} ¥`);
    L.push('Брендовый референс — найдите OEM на 1688.');
  }

  // ─── Что уточнить (по категории товара) ──────────────────────────────────
  const catRules = getCategoryRules(catType);
  const clarify: string[] = [];
  if (priceIsZero) clarify.push('цену выбранного цвета/размера');
  else if (product.priceIsRange) clarify.push('подтвердите цену выбранного варианта');
  if (wm) clarify.push('вес единицы с упаковкой');
  // Category questions, filtered by what's actually missing
  for (const q of catRules.supplierQuestions.ru) {
    if (clarify.length >= 7) break;
    const ql = q.toLowerCase();
    // Skip weight questions if weight exists
    if (!wm && (ql.includes('вес') || ql.includes('weight'))) continue;
    // Skip price questions if price exists and not range
    if (!priceIsZero && !product.priceIsRange && (ql.includes('цен') || ql.includes('price'))) continue;
    // Skip duplicates
    if (clarify.some((c) => c.toLowerCase() === ql)) continue;
    clarify.push(q);
  }

  if (clarify.length) {
    L.push('');
    L.push('📌 <b>Что уточнить у поставщика</b>');
    clarify.forEach((c) => L.push(`• ${c}`));
  }

  // ─── Вердикт ────────────────────────────────────────────────────────────────
  L.push('');
  L.push('🎯 <b>Вердикт</b>');
  L.push(buildSmartVerdict(wm, hasConfirmedAnalogs, economics.grossProfitRub, economics.platformMode, priceIsZero, !!wbCategory));

  // ─── Остаток анализов ───────────────────────────────────────────────────────
  if (status) {
    L.push('');
    L.push(formatCreditsLine(status));
  }

  // ─── Кнопки ─────────────────────────────────────────────────────────────────
  const buttons: any[][] = [
    [
      Markup.button.callback('📦 Данные 1688', `product_detail_${jobId}`),
      Markup.button.callback('🔎 WB-рынок', `wb_detail_${jobId}`),
    ],
    [
      Markup.button.callback('💰 Экономика', `econ_detail_${jobId}`),
      Markup.button.callback('💬 Поставщику', 'supplier_questions'),
    ],
    [
      Markup.button.callback('📎 Файлы', `materials_${jobId}`),
      Markup.button.callback('🔄 Новый товар', 'new_search'),
    ],
  ];

  if (status && status.creditsRemaining <= 1) {
    buttons.push([
      Markup.button.callback('💳 Купить анализы', 'buy_analyses'),
    ]);
  }

  return { text: sanitize(L.join('\n')), keyboard: Markup.inlineKeyboard(buttons) };
}

function buildSmartVerdict(wm: boolean, hasAnalogs: boolean, profit: number, mode: string, priceZero: boolean, hasWbCategory: boolean): string {
  if (mode === 'reference_only') return 'Этот товар — брендовый референс. Найдите OEM-аналог на 1688.';
  if (mode === 'sample_only') return 'Закажите образец и запросите оптовую цену для расчёта партии.';
  if (priceZero) return 'Цена не распознана. Уточните цену SKU у поставщика и повторите расчёт.';

  if (!hasAnalogs && hasWbCategory) {
    if (wm) return 'Категория WB живая, но нужны данные. Уточните цену SKU, вес и повторите расчёт.';
    return 'Категория WB живая, но прямые аналоги не подтверждены. Перед закупкой проверьте похожие товары на WB.';
  }

  if (wm && !hasAnalogs) return 'Сначала уточните данные у поставщика и повторите расчёт.';
  if (wm) return 'Уточните вес и размеры у поставщика — после этого бот рассчитает полную экономику.';
  if (!hasAnalogs) return 'Аналоги на WB не найдены. Оцените рынок вручную перед закупкой.';
  if (profit > 0) return 'Экономика положительная. Можно заказывать тестовую партию.';
  return 'Экономика слабая. Попробуйте договориться о лучшей цене или выбрать другой товар.';
}

// ─── Экономика (по кнопке) ──────────────────────────────────────────────────

export function buildEconomicsDetail(product: ProductWithContent, jobId: string): {
  text: string;
  keyboard: ReturnType<typeof Markup.inlineKeyboard>;
} {
  const { economics, wbFiltered, maxPurchasePrice, budgets } = product;
  if (!economics) return { text: '💰 Данные экономики недоступны.', keyboard: Markup.inlineKeyboard([]) };
  const b = economics.breakdown;
  const wm = economics.weightMissing;
  const hasConfirmedAnalogs = !!(product.similarityData && (product.similarityData.directCount ?? 0) > 0);
  const L: string[] = [];

  L.push('💰 <b>Экономика</b>');
  L.push('');

  if (economics.platformMode === 'full') {
    if (wm) {
      L.push('Расчёт предварительный: нет веса товара.');
      L.push('');
    }

    // Объясняем разницу цен, если priceRange
    if (product.priceRange?.length) {
      const valid = product.priceRange.filter((r) => r.minQty > 0);
      if (valid.length) {
        const minPrice = valid[valid.length - 1].price;
        if (minPrice !== b.purchaseYuan) {
          L.push(`Цена товара: от ${minPrice} ¥`);
          L.push(`Расчётный SKU: ${b.purchaseYuan} ¥ ≈ ${fP(b.purchaseRub)}`);
        } else {
          L.push(`Закупка: ${b.purchaseYuan} ¥ × ${economics.yuanToRub.toFixed(2)} = ${fP(b.purchaseRub)}`);
        }
      } else {
        L.push(`Закупка: ${b.purchaseYuan} ¥ × ${economics.yuanToRub.toFixed(2)} = ${fP(b.purchaseRub)}`);
      }
    } else {
      L.push(`Закупка: ${b.purchaseYuan} ¥ × ${economics.yuanToRub.toFixed(2)} = ${fP(b.purchaseRub)}`);
    }

    L.push(`Банк / обмен: +${fP(b.bankMarkupRub)}`);
    if (!wm) {
      L.push(`Карго (${product.weightKg} кг): +${fP(b.cargoRub)}`);
    }
    L.push(`Фулфилмент: +${fP(b.internalLogisticsRub)}`);
    L.push('');
    L.push(`<b>Себестоимость${wm ? ' без карго' : ''}: ${fP(economics.costRub)}</b>`);

    // Что не рассчитано
    if (wm || !hasConfirmedAnalogs || economics.isSyntheticPrice) {
      const missing: string[] = [];
      if (wm) missing.push('карго — нет веса');
      if (!hasConfirmedAnalogs || economics.isSyntheticPrice) missing.push('маржа — нет подтверждённой цены WB');
      if (wm || !hasConfirmedAnalogs) missing.push('ROI — нет ' + [wm ? 'веса' : '', !hasConfirmedAnalogs ? 'рынка WB' : ''].filter(Boolean).join(' и '));

      L.push('');
      L.push('<b>Не рассчитано:</b>');
      missing.forEach((m) => L.push(`• ${m}`));
    }

    // Полные сценарии
    if (!wm && !economics.isSyntheticPrice && hasConfirmedAnalogs && wbFiltered) {
      const calcProfit = (salePrice: number) => {
        const comm = Math.round(salePrice * 0.20);
        const drr = Math.round(salePrice * b.drrPercent / 100);
        const tax = Math.round(salePrice * 0.07);
        return salePrice - economics.costRub - comm - 100 - drr - tax;
      };
      const fSign = (n: number) => (n >= 0 ? '+' : '') + fP(n);

      L.push('');
      L.push('<b>Прибыль по сценариям:</b>');
      L.push(`Консервативный (P25: ${fP(wbFiltered.p25Price)}): ${fSign(calcProfit(wbFiltered.p25Price))}`);
      L.push(`Базовый (медиана: ${fP(wbFiltered.medianPrice)}): <b>${fSign(calcProfit(wbFiltered.medianPrice))}</b>`);
      L.push(`Оптимистичный (P75: ${fP(wbFiltered.p75Price)}): ${fSign(calcProfit(wbFiltered.p75Price))}`);
      L.push(`<i>Комиссия 20%, ДРР ${b.drrPercent}%, налог 7%, логистика WB 100₽</i>`);
    }

    if (maxPurchasePrice && !wm && !economics.isSyntheticPrice && hasConfirmedAnalogs) {
      L.push('');
      L.push('<b>Целевая закупочная цена</b>');
      if (maxPurchasePrice.maxYuan > 0) {
        L.push(`Макс. цена (маржа ${maxPurchasePrice.targetMarginPercent}%): <b>${maxPurchasePrice.maxYuan.toFixed(1)} ¥</b>`);
        L.push(`Текущая: ${maxPurchasePrice.currentYuan} ¥`);
        L.push(maxPurchasePrice.allowed ? '✅ Текущая цена проходит' : `❌ Нужна цена ниже ${maxPurchasePrice.maxYuan.toFixed(0)} ¥`);
      } else {
        L.push(`❌ Целевая маржа ${maxPurchasePrice.targetMarginPercent}% недостижима.`);
      }
    }

    if (budgets) {
      L.push('');
      if (wm) {
        L.push('<b>Бюджет (без карго):</b>');
        [budgets.sample, budgets.test, budgets.firstBatch].forEach((s) => {
          L.push(`${s.label}, ${s.quantity} шт: ~${fP(s.goodsCostRub)}`);
        });
        L.push('<i>Карго не включено — нет веса.</i>');
      } else {
        L.push('<b>Бюджет закупки:</b>');
        [budgets.sample, budgets.test, budgets.firstBatch].forEach((s) => {
          L.push(`${s.label} — ${s.quantity} шт: ~<b>${fP(s.totalRub)}</b>`);
        });
      }
    }
  } else if (economics.platformMode === 'sample_only') {
    L.push(`Цена витрины: ${b.purchaseYuan} ¥ · розничная`);
    L.push(`Стоимость образца: ~${fP(economics.costRub)}`);
    L.push('<i>Запросите цену на 20/50/100 шт. для расчёта партии.</i>');
  } else {
    L.push(`Цена витрины: ${b.purchaseYuan} ¥ (~${fP(b.purchaseRub)})`);
    L.push('<i>Брендовый референс. Найдите OEM-аналог на 1688.</i>');
  }

  if (wm || !hasConfirmedAnalogs) {
    L.push('');
    L.push('📌 Для полного расчёта нужен вес с упаковкой.');
  }

  const buttons = [
    [Markup.button.callback('📥 Внести ответ поставщика', 'supplier_confirm')],
    [Markup.button.callback('⚙️ Изменить параметры', 'edit_params')],
    [Markup.button.callback('⬅️ Назад', `back_main_${jobId}`)],
  ];

  return { text: sanitize(L.join('\n')), keyboard: Markup.inlineKeyboard(buttons) };
}

// ─── WB-рынок (по кнопке) ──────────────────────────────────────────────────

export function buildWbDetail(product: ProductWithContent, jobId: string): {
  text: string;
  keyboard: ReturnType<typeof Markup.inlineKeyboard>;
} {
  const { wbFiltered, similarityData: sim } = product;
  const L: string[] = [];

  L.push('🔎 <b>WB-рынок</b>');
  L.push('');

  if ((product as any).wb429) {
    L.push('⚠️ WB временно ограничил поиск (429). Данные рынка могут быть неполными.');
    L.push('');
  }

  if (sim && sim.totalAnalyzed > 0) {
    const confMap: Record<string, [string, string]> = {
      high: ['🟢', 'Высокая'], medium: ['🟡', 'Средняя'], low: ['🟠', 'Низкая'],
      crossborder_only: ['🟤', 'Только cross-border'],
      category_only: ['🔵', 'Только категория'], no_market: ['🔴', 'Не подтверждён'],
    };
    const [confIcon, confLabel] = confMap[sim.confidence ?? ''] ?? ['🔴', 'Не подтверждён'];
    L.push(`${confIcon} Уверенность: <b>${confLabel}</b>`);
    L.push(`Прямые локальные: ${sim.directCount ?? 0}`);
    L.push(`Похожие локальные: ${sim.similarCount ?? 0}`);
    if (sim.crossBorderCount) L.push(`Cross-border: ${sim.crossBorderCount} (не используем для экономики)`);
    if (sim.categoryCount) L.push(`Широкая категория: ${sim.categoryCount}`);
  }

  if (wbFiltered && wbFiltered.relevantCount > 0 && wbFiltered.medianPrice > 0) {
    L.push('');
    L.push('<b>Цены аналогов:</b>');
    L.push(`P25: ${fP(wbFiltered.p25Price)} | Медиана: <b>${fP(wbFiltered.medianPrice)}</b> | P75: ${fP(wbFiltered.p75Price)}`);

    if (wbFiltered.topExamples.length) {
      L.push('');
      L.push('🎯 <b>Ближайшие товары:</b>');
      wbFiltered.topExamples.slice(0, 5).forEach((ex, i) => {
        const t = ex.title.length > 35 ? ex.title.slice(0, 32) + '...' : ex.title;
        L.push(`${i + 1}. <a href="${ex.url}">${fP(ex.price)}</a> ⭐${ex.rating} 💬${fN(ex.feedbacks)} — ${esc(t)}`);
      });
    }

    const leaders = sim?.leaders;
    if (leaders?.length) {
      const top = leaders.filter((l: any) => l.feedbacks > 50).slice(0, 3);
      if (top.length) {
        L.push('');
        L.push('🏆 <b>Лидеры рынка:</b>');
        top.forEach((ex: any, i: number) => {
          const t = (ex.title ?? '').length > 35 ? ex.title.slice(0, 32) + '...' : ex.title ?? '';
          L.push(`${i + 1}. <a href="${ex.url}">${fP(ex.price)}</a> ⭐${ex.rating} 💬${fN(ex.feedbacks)} — ${esc(t)}`);
        });
      }
    }

    L.push('');
    const demandIcon = wbFiltered.totalFeedbacks > 1000 ? '🟢' : wbFiltered.totalFeedbacks > 100 ? '🟡' : '🔴';
    const compIcon = wbFiltered.relevantCount > 50 ? '🔴' : wbFiltered.relevantCount > 20 ? '🟡' : '🟢';
    L.push(`Спрос: ${demandIcon} ${wbFiltered.totalFeedbacks > 1000 ? 'Есть' : wbFiltered.totalFeedbacks > 100 ? 'Средний' : 'Слабый'}`);
    L.push(`Конкуренция: ${compIcon} ${wbFiltered.relevantCount > 50 ? 'Высокая' : wbFiltered.relevantCount > 20 ? 'Средняя' : 'Низкая'}`);
  } else {
    L.push('Прямые аналоги пока не подтверждены.');
    L.push('Рыночную цену и ROI не считаю.');
  }

  const buttons = [
    [Markup.button.callback('⬅️ Назад', `back_main_${jobId}`)],
  ];

  return { text: sanitize(L.join('\n')), keyboard: Markup.inlineKeyboard(buttons) };
}

// ─── Кредиты (используется только в legacy/link.ts) ─────────────────────────

export function buildCreditsMessage(status: SubscriptionStatus): {
  text: string;
  keyboard: ReturnType<typeof Markup.inlineKeyboard>;
} {
  const text = formatCreditsLine(status);
  const buttons: any[][] = [];

  if (status.creditsRemaining <= 0) {
    buttons.push([
      Markup.button.callback('10 · 150⭐', 'pay_pack10'),
      Markup.button.callback('30 · 300⭐', 'pay_pack30'),
      Markup.button.callback('7дн Pro · 500⭐', 'pay_week'),
    ]);
  }

  return { text, keyboard: Markup.inlineKeyboard(buttons) };
}

// ─── Данные 1688 (по кнопке) ────────────────────────────────────────────────

export function build1688Detail(product: ProductWithContent, jobId: string): {
  text: string;
  keyboard: ReturnType<typeof Markup.inlineKeyboard>;
} {
  const L: string[] = [];
  const normalized = product.normalized1688;

  L.push('📦 <b>Данные товара с 1688</b>');
  L.push('');

  // Названия
  L.push('<b>Название CN:</b>');
  L.push(esc(product.titleCn));
  if (product.titleRu) {
    L.push('');
    L.push('<b>Название RU:</b>');
    L.push(esc(product.titleRu));
  }

  // Цена
  L.push('');
  L.push('<b>Цена:</b>');
  if (product.priceYuan > 0) {
    L.push(`• базовая: ${product.priceYuan} ¥`);
  } else {
    L.push('• базовая: не распознана');
  }
  if (normalized?.pricing?.skuMinPriceYuan && normalized?.pricing?.skuMaxPriceYuan) {
    const min = normalized.pricing.skuMinPriceYuan;
    const max = normalized.pricing.skuMaxPriceYuan;
    L.push(min === max ? `• цена SKU: ${min} ¥` : `• диапазон SKU: ${min}–${max} ¥`);
  }
  if (product.priceRange?.length) {
    const valid = product.priceRange.filter((r) => r.minQty > 0 && r.price > 0);
    if (valid.length) {
      L.push('• оптовые цены:');
      valid.slice(0, 4).forEach((r) => {
        const maxLabel = r.maxQty > 0 ? `${r.minQty}–${r.maxQty} шт` : `от ${r.minQty} шт`;
        L.push(`  ${maxLabel}: ${r.price} ¥`);
      });
    }
  }

  // SKU
  L.push('');
  const quoteType = normalized?.pricing?.quoteType;
  if (product.skus?.length) {
    L.push(`<b>SKU:</b> ${product.skus.length} вариантов`);
    const withPrice = product.skus.filter((s) => s.price && s.price > 0);
    if (withPrice.length) {
      const prices = withPrice.map((s) => s.price!);
      const minP = Math.min(...prices);
      const maxP = Math.max(...prices);
      L.push(minP === maxP ? `• цена: ${minP} ¥` : `• цена: ${minP}–${maxP} ¥`);
    }
    const names = product.skus.slice(0, 6).map((s) => s.name).filter(Boolean);
    if (names.length) {
      L.push(`• варианты: ${names.join(', ')}${product.skus.length > 6 ? '…' : ''}`);
    }
  } else if (quoteType === 'by_sku') {
    L.push('<b>SKU:</b> варианты не загружены');
    L.push('<i>Товар продаётся по SKU, но варианты не загрузились. Уточните у поставщика.</i>');
  } else {
    L.push('<b>SKU:</b> не предусмотрены');
  }

  // Поставщик
  L.push('');
  L.push('<b>Поставщик:</b>');
  L.push(`• название: ${esc(product.supplierName)}`);
  L.push(`• тип: ${SUPPLIER_TYPE_RU[normalized?.supplierType ?? product.supplierType ?? ''] ?? 'не указан'}`);
  if (product.supplierRating) L.push(`• рейтинг: ${product.supplierRating}/5`);
  if (product.sold) L.push(`• заказов: ${fN(product.sold)}+`);
  L.push(`• MOQ: ${product.moq > 1 ? `${product.moq} шт` : 'не указан'}`);

  // Характеристики — переводим, фильтруем мусор
  if (product.attributes?.length) {
    L.push('');
    L.push('<b>Характеристики:</b>');
    let shownCount = 0;
    for (const a of product.attributes) {
      if (shownCount >= 10) break;
      if (isJunkAttrValue(a.value)) continue;
      const ruName = translateAttrName(a.name);
      const ruVal = translateAttrValue(a.value);
      const displayName = ruName ?? a.name;
      // Filter out untranslated Chinese from both name and value
      if (hasUntranslatedChinese(ruVal) || (!ruName && hasUntranslatedChinese(a.name))) continue;
      L.push(`• ${esc(displayName)}: ${esc(ruVal)}`);
      shownCount++;
    }
    if (product.attributes.length > shownCount) L.push(`<i>и ещё ${product.attributes.length - shownCount} атрибутов</i>`);
  }

  // Логистика
  L.push('');
  L.push('<b>Логистика:</b>');
  L.push(`• вес: ${fWeight(product.weightKg)}`);
  L.push(`• фото: ${normalized?.imageCount ?? product.images?.length ?? 0} шт`);
  if (product.stock) L.push(`• остаток: ${fN(product.stock)} шт`);

  const buttons = [
    [Markup.button.callback('⬅️ Назад', `back_main_${jobId}`)],
  ];

  return { text: sanitize(L.join('\n')), keyboard: Markup.inlineKeyboard(buttons) };
}

// ─── Legacy exports ─────────────────────────────────────────────────────────

export const buildMessage1 = (product: ProductWithContent) => buildMainMessage(product, '').text;
export const buildMessage2 = (product: ProductWithContent, jobId: string) => buildMainMessage(product, jobId);
export const buildMessage3 = buildCreditsMessage;

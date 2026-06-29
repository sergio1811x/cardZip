const CN_MAP: Record<string, string> = {
  '踩屎感': 'эффект мягкой амортизации',
  '冰丝': 'заявленный охлаждающий материал',
  '爆款': 'популярная модель по заявлению поставщика',
  '显瘦': 'заявленный визуально стройнящий эффект',
  '加绒': 'утеплённая подкладка',
  '加厚': 'утолщённый',
  '百搭': 'универсальный стиль',
  '网红': 'трендовый по заявлению поставщика',
  '潮牌': 'модный стиль',
  '高颜值': 'стильный дизайн',
  'ins风': 'инстаграм-стиль',
  '韩版': 'корейский стиль',
  '日系': 'японский стиль',
  '欧美风': 'европейский стиль',
  '大码': 'большой размер',
  '小码': 'маленький размер',
  '均码': 'один размер',
  '包邮': 'доставка заявлена поставщиком',
  '厂家直销': 'от производителя',
  '一件代发': 'дропшиппинг',
  '外贸': 'для внешней торговли',
  '跨境': 'для cross-border торговли',
  '防水': 'заявленная влагозащита',
  '防滑': 'заявленное противоскользящее свойство',
  '透气': 'заявленная воздухопроницаемость',
  '速干': 'заявленное быстрое высыхание',
  '弹力': 'эластичность',
  '修身': 'приталенный',
  '宽松': 'свободный крой',
  '薄款': 'тонкий / летний',
  '厚款': 'утеплённый / плотный',
  '纯棉': 'заявленный хлопок',
  '真皮': 'заявленная натуральная кожа',
  '牛皮': 'заявленная бычья кожа',
  '羊皮': 'заявленная овечья кожа',
  '不锈钢': 'нержавеющая сталь',
  '合金': 'сплав',
  '硅胶': 'силикон',
  '新款': 'новая модель',
  '经典款': 'классическая модель',
  '高版本': 'высокая версия',
  '偏小一码': 'маломерит на 1 размер',
};

const CN_DIGITS: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

const COLOR_MAP: Record<string, string> = {
  粉: 'розовый', 粉色: 'розовый', 红: 'красный', 红色: 'красный', 黄: 'жёлтый', 黄色: 'жёлтый',
  蓝: 'синий', 蓝色: 'синий', 绿: 'зелёный', 绿色: 'зелёный', 黑: 'чёрный', 黑色: 'чёрный',
  白: 'белый', 白色: 'белый', 灰: 'серый', 灰色: 'серый', 紫: 'фиолетовый', 紫色: 'фиолетовый',
  橙: 'оранжевый', 橙色: 'оранжевый',
};

const MACHINE_RU_INSERTS = [
  /заявленн(?:ое|ая|ый|ые)\s+[^\u4e00-\u9fff]{0,80}/gi,
  /доставка\s+включена[^\u4e00-\u9fff]{0,80}/gi,
  /для\s+международной\s+торговли/gi,
  /новинка/gi,
  /по\s+заявлению\s+поставщика/gi,
  /машинн(?:ый|ая|ое)\s+перевод/gi,
];

export function normalizeCnText(text: string): string {
  let result = String(text ?? '');
  for (const [cn, ru] of Object.entries(CN_MAP)) {
    result = result.split(cn).join(ru);
  }
  return result.replace(/\s+/g, ' ').trim();
}

export function cleanChineseTitle(input: unknown): string {
  let text = String(input ?? '');
  for (const re of MACHINE_RU_INSERTS) text = text.replace(re, ' ');
  text = text
    .replace(/[А-Яа-яЁё]+(?:[\s.,;:!?'"«»()\-–—/]+[А-Яа-яЁё]+)*/g, ' ')
    .replace(/(?:包邮|跨境|外贸|新款|爆款|网红|现货|厂家直销|一件代发)/g, '')
    .replace(/[^\u4e00-\u9fffA-Za-z0-9+\-_/\.\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

export function detectPackCount(input: unknown): number | undefined {
  const text = String(input ?? '');
  const direct = text.match(/(\d+)\s*(?:个|件|只|支|条|шт|штук|pcs?)\s*(?:装|pack)?/i);
  if (direct) {
    const n = Number(direct[1]);
    if (Number.isFinite(n) && n > 0 && n < 1000) return n;
  }
  const cn = text.match(/([一二两三四五六七八九十])\s*(?:个|件|只|支|条)?\s*装/);
  if (cn) return CN_DIGITS[cn[1]];
  if (/单个装|一个装/.test(text)) return 1;
  return undefined;
}

export function extractShoeSize(input: unknown): string | undefined {
  const m = String(input ?? '').match(/(?:^|[^\d])(3[5-9]|4[0-9]|5[0-2])(?:码|\b)/);
  return m?.[1];
}

function detectColor(input: string): string | undefined {
  for (const [cn, ru] of Object.entries(COLOR_MAP)) {
    if (input.includes(cn)) return ru;
  }
  const ru = input.match(/(розов\w*|красн\w*|ж[её]лт\w*|син\w*|зел[её]н\w*|ч[её]рн\w*|бел\w*|сер\w*|оранж\w*)/i)?.[1];
  return ru;
}

export function normalizeSkuText(input: unknown): string {
  const raw = String(input ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const parts: string[] = [];
  const color = detectColor(raw);
  const size = extractShoeSize(raw);
  const pack = detectPackCount(raw);
  if (color) parts.push(`Цвет: ${color}`);
  if (/经典款/.test(raw)) parts.push('Модель: классическая');
  if (/高版本/.test(raw)) parts.push('Версия: высокая');
  if (size) parts.push(`Размер: ${size}`);
  if (/偏小一码/.test(raw)) parts.push('Примечание: маломерит на 1 размер');
  if (pack) parts.push(`Комплект: ${pack} шт`);
  const model = raw.match(/\b[A-Z]{1,6}\d{2,}[\w-]*\b/i)?.[0];
  if (model) parts.unshift(`Модель/SKU: ${model}`);
  if (parts.length) return parts.join('; ');
  return normalizeCnText(raw)
    .replace(/[【】（）()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

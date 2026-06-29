const CN_MAP: Record<string, string> = {
  踩屎感: "эффект мягкой амортизации",
  冰丝: "заявленный охлаждающий материал",
  爆款: "популярная модель по заявлению поставщика",
  显瘦: "заявленный визуально стройнящий эффект",
  加绒: "утеплённая подкладка",
  加厚: "утолщённый",
  百搭: "универсальный стиль",
  网红: "трендовый по заявлению поставщика",
  潮牌: "модный стиль",
  高颜值: "стильный дизайн",
  ins风: "инстаграм-стиль",
  韩版: "корейский стиль",
  日系: "японский стиль",
  欧美风: "европейский стиль",
  大码: "большой размер",
  小码: "маленький размер",
  均码: "один размер",
  包邮: "доставка заявлена поставщиком",
  厂家直销: "от производителя",
  一件代发: "дропшиппинг",
  外贸: "для внешней торговли",
  跨境: "для cross-border торговли",
  防水: "заявленная влагозащита",
  防滑: "заявленное противоскользящее свойство",
  透气: "заявленная воздухопроницаемость",
  速干: "заявленное быстрое высыхание",
  弹力: "эластичность",
  修身: "приталенный",
  宽松: "свободный крой",
  薄款: "тонкий / летний",
  厚款: "утеплённый / плотный",
  纯棉: "заявленный хлопок",
  真皮: "заявленная натуральная кожа",
  牛皮: "заявленная бычья кожа",
  羊皮: "заявленная овечья кожа",
  不锈钢: "нержавеющая сталь",
  合金: "сплав",
  硅胶: "силикон",
  新款: "новая модель",
  经典款: "классическая модель",
  高版本: "высокая версия",
  偏小一码: "маломерит на 1 размер",

  医用: "медицинский",
  医疗: "медицинский",
  手术室: "для операционной",
  拖鞋: "сабо/шлёпанцы",
  洞洞鞋: "сабо с отверстиями",
  护士鞋: "обувь для медперсонала",
  医护: "для медперсонала",
  男款: "мужская модель",
  男士: "мужские",
  女款: "женская модель",
  女士: "женские",
  防臭: "заявленная защита от запаха",
  不臭脚: "заявлено: не вызывает запах ног",
  抗菌: "заявленное антибактериальное свойство",
  杀菌: "заявленное антибактериальное свойство",
  卡其: "хаки",
  米白: "молочно-белый",
  建议: "рекомендация",
  脚穿: "для стопы",
  普通款: "базовая модель",
  基础款: "базовая модель",
  厚底: "толстая подошва",
  软底: "мягкая подошва",
  不累脚: "заявлено: не утомляет ноги",
  男: "мужские",
  女: "женские",

  材质: "материал",
  材料: "материал",
  功能: "функции",
  特点: "особенности",
  适用场景: "сценарий применения",
  场景: "сценарий применения",
  颜色: "цвет",
  尺码: "размер",
  鞋底厚度: "толщина подошвы",
  厚度: "толщина",
  货号: "артикул",
  型号: "модель",
  产品类别: "тип товара",
  适用性别: "пол",
};

const CN_DIGITS: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

const COLOR_MAP: Record<string, string> = {
  粉色: "розовый",
  粉: "розовый",
  红色: "красный",
  红: "красный",
  黄色: "жёлтый",
  黄: "жёлтый",
  蓝色: "синий",
  蓝: "синий",
  绿色: "зелёный",
  绿: "зелёный",
  黑色: "чёрный",
  黑: "чёрный",
  白色: "белый",
  白: "белый",
  灰色: "серый",
  灰: "серый",
  紫色: "фиолетовый",
  紫: "фиолетовый",
  橙色: "оранжевый",
  橙: "оранжевый",
  卡其: "хаки",
  米白: "молочно-белый",
};

const RU_COLOR_PATTERNS: Array<[RegExp, string]> = [
  [/розов\w*/i, "розовый"],
  [/красн\w*/i, "красный"],
  [/ж[её]лт\w*/i, "жёлтый"],
  [/син\w*/i, "синий"],
  [/зел[её]н\w*/i, "зелёный"],
  [/(?:ч[её]рн|черн)\w*/i, "чёрный"],
  [/бел\w*/i, "белый"],
  [/сер\w*/i, "серый"],
  [/оранж\w*/i, "оранжевый"],
  [/хаки/i, "хаки"],
];

const MACHINE_RU_INSERTS = [
  /заявленн(?:ое|ая|ый|ые)\s+[^\u4e00-\u9fff]{0,80}/gi,
  /доставка\s+включена[^\u4e00-\u9fff]{0,80}/gi,
  /для\s+международной\s+торговли/gi,
  /новинка/gi,
  /по\s+заявлению\s+поставщика/gi,
  /машинн(?:ый|ая|ое)\s+перевод/gi,
];

export function normalizeCnText(text: string): string {
  let result = String(text ?? "");
  const entries = Object.entries(CN_MAP).sort(
    (a, b) => b[0].length - a[0].length,
  );
  for (const [cn, ru] of entries) {
    result = result.split(cn).join(` ${ru} `);
  }
  return result
    .replace(/[【】（）()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeMixedProductText(input: unknown): string {
  let text = normalizeCnText(String(input ?? ""));
  text = text
    .replace(/[一-鿿]+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

export function cleanChineseTitle(input: unknown): string {
  let text = String(input ?? "");
  for (const re of MACHINE_RU_INSERTS) text = text.replace(re, " ");
  text = text
    .replace(/[А-Яа-яЁё]+(?:[\s.,;:!?'"«»()\-–—/]+[А-Яа-яЁё]+)*/g, " ")
    .replace(/(?:包邮|跨境|外贸|新款|爆款|网红|现货|厂家直销|一件代发)/g, "")
    .replace(/[^\u4e00-\u9fffA-Za-z0-9+\-_/\.\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

export function detectPackCount(input: unknown): number | undefined {
  const text = String(input ?? "");
  const direct = text.match(
    /(\d+)\s*(?:个|件|只|支|条|шт|штук|pcs?)\s*(?:装|pack)?/i,
  );
  if (direct) {
    const n = Number(direct[1]);
    if (Number.isFinite(n) && n > 0 && n < 1000) return n;
  }
  const cn = text.match(
    /([一二两三四五六七八九十])\s*(?:个|件|只|支|条)?\s*装/,
  );
  if (cn) return CN_DIGITS[cn[1]];
  if (/单个装|一个装/.test(text)) return 1;
  return undefined;
}

export function extractShoeSize(input: unknown): string | undefined {
  const text = String(input ?? "");
  const range = text.match(
    /(?:^|[^\d])(3[5-9]|4[0-9]|5[0-2])\s*[-–]\s*(3[5-9]|4[0-9]|5[0-2])(?:码|\b)/,
  );
  if (range) return `${range[1]}-${range[2]}`;
  const m = text.match(/(?:^|[^\d])(3[5-9]|4[0-9]|5[0-2])(?:码|\b)/);
  return m?.[1];
}

function detectColor(input: string): string | undefined {
  const entries = Object.entries(COLOR_MAP).sort(
    (a, b) => b[0].length - a[0].length,
  );
  for (const [cn, ru] of entries) {
    if (input.includes(cn)) return ru;
  }
  for (const [pattern, color] of RU_COLOR_PATTERNS) {
    if (pattern.test(input)) return color;
  }
  return undefined;
}

export function normalizeSkuText(input: unknown): string {
  const raw = String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return "";
  const parts: string[] = [];
  const color = detectColor(raw);
  const size = extractShoeSize(raw);
  const pack = detectPackCount(raw);
  if (color) parts.push(`Цвет: ${color}`);
  if (/经典款/.test(raw)) parts.push("Модель: классическая");
  if (/高版本/.test(raw)) parts.push("Версия: высокая");
  if (size) parts.push(`Размер: ${size}`);
  if (/偏小一码/.test(raw)) parts.push("Примечание: маломерит на 1 размер");
  const featureParts: string[] = [];
  if (/防臭|不臭脚/.test(raw)) featureParts.push("заявленная защита от запаха");
  if (/抗菌|杀菌/.test(raw))
    featureParts.push("заявленное антибактериальное свойство");
  if (/防滑/.test(raw))
    featureParts.push("заявленное противоскользящее свойство");
  if (/透气/.test(raw)) featureParts.push("заявленная воздухопроницаемость");
  if (/厚底/.test(raw)) featureParts.push("толстая подошва");
  if (/软底|不累脚/.test(raw))
    featureParts.push("заявленный комфорт/мягкая подошва");
  if (featureParts.length)
    parts.push(`Особенность: ${[...new Set(featureParts)].join(", ")}`);
  if (pack) parts.push(`Комплект: ${pack} шт`);
  const model = raw.match(/\b[A-Z]{1,6}\d{2,}[\w-]*\b/i)?.[0];
  if (model) parts.unshift(`Модель/SKU: ${model}`);
  if (parts.length) return parts.join("; ");
  return normalizeMixedProductText(raw);
}

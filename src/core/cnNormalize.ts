const CN_MAP: Record<string, string> = {
  '踩屎感': 'мягкая амортизация',
  '冰丝': 'охлаждающий материал',
  '爆款': 'популярная модель',
  '显瘦': 'визуально стройнит',
  '加绒': 'утеплённая подкладка',
  '加厚': 'утолщённый',
  '百搭': 'универсальный стиль',
  '网红': 'трендовый стиль',
  '潮牌': 'модный бренд',
  '高颜值': 'выразительный дизайн',
  'ins风': 'инстаграм-стиль',
  '韩版': 'корейский стиль',
  '日系': 'японский стиль',
  '欧美风': 'европейский стиль',
  '大码': 'большой размер',
  '小码': 'маленький размер',
  '均码': 'один размер',
  '包邮': 'доставка включена по заявлению поставщика',
  '厂家直销': 'от производителя',
  '一件代发': 'дропшиппинг',
  '外贸': 'экспортная версия',
  '跨境': 'cross-border / для международной торговли',

  // Claims ниже нельзя превращать в сильные маркетинговые обещания.
  // Это только перевод заявлений поставщика, а не подтверждённые свойства для WB-карточки.
  '防水': 'заявленная влагозащита',
  '防滑': 'заявленное противоскользящее свойство',
  '透气': 'заявленная воздухопроницаемость',
  '速干': 'заявленное быстрое высыхание',
  '弹力': 'эластичный материал',
  '修身': 'приталенный крой',
  '宽松': 'свободный крой',
  '薄款': 'тонкая версия',
  '厚款': 'утеплённая версия',
  '纯棉': 'заявленный хлопок 100%',
  '真皮': 'заявленная натуральная кожа',
  '牛皮': 'заявленная бычья кожа',
  '羊皮': 'заявленная овечья кожа',
  '不锈钢': 'нержавеющая сталь',
  '合金': 'сплав',
  '硅胶': 'силикон',
  '新款': 'новинка',
};

const CN_RE = /[\u3400-\u9fff]/;
const SPACES_RE = /\s+/g;

export function hasChineseChars(value: unknown): boolean {
  return CN_RE.test(String(value ?? ''));
}

export function normalizeCnText(text: string): string {
  let result = String(text ?? '');
  for (const [cn, ru] of Object.entries(CN_MAP)) {
    // split/join вместо replaceAll — безопаснее для старых target/runtime.
    result = result.split(cn).join(ru);
  }
  return result.replace(SPACES_RE, ' ').trim();
}

export function normalizeCnRecord(record: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record ?? {})) {
    const safeKey = normalizeCnText(key);
    const safeValue = normalizeCnText(String(value ?? ''));
    if (!safeKey || !safeValue) continue;
    out[safeKey] = safeValue;
  }
  return out;
}

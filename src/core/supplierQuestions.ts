import type { RiskFlags, SupplierQuestions } from '../types';

// ─── Fallback (если LLM не вернул вопросы) ──────────────────────────────────

interface QuestionPair {
  ru: string;
  cn: string;
}

const BASE_QUESTIONS: QuestionPair[] = [
  { ru: 'Можно ли заказать образец?', cn: '可以先订样品吗？' },
  { ru: 'Какая цена при заказе 20 / 50 / 100 штук?', cn: '订购20/50/100件的价格分别是多少？' },
  { ru: 'Возможна ли нейтральная упаковка без бренда?', cn: '可以做无品牌包装吗？' },
  { ru: 'Есть ли реальные фото и видео товара?', cn: '可以提供产品实拍图和视频吗？' },
  { ru: 'Какие размеры и вес товара с индивидуальной упаковкой?', cn: '单个产品和包装后的尺寸、毛重是多少？' },
];

const ELECTRICAL_QUESTIONS: QuestionPair[] = [
  { ru: 'Какая мощность в ваттах?', cn: '功率是多少瓦？' },
  { ru: 'Какое напряжение и тип питания?', cn: '电压和供电方式是什么？' },
  { ru: 'Есть ли аккумулятор? Какая ёмкость?', cn: '是否有电池？电池容量是多少？' },
  { ru: 'Какие документы доступны для товара?', cn: '产品有哪些证书和文件？' },
];

const CLOTHING_QUESTIONS: QuestionPair[] = [
  { ru: 'Пришлите размерную таблицу в сантиметрах.', cn: '请提供以厘米为单位的尺码表。' },
  { ru: 'Какова погрешность размеров?', cn: '尺寸误差范围是多少？' },
  { ru: 'Можно ли смешивать размеры и цвета в одном заказе?', cn: '一个订单可以混合不同尺码和颜色吗？' },
];

const BRAND_QUESTIONS: QuestionPair[] = [
  { ru: 'Возможна ли поставка без логотипа и без брендированной упаковки?', cn: '可以去掉logo和品牌包装发货吗？' },
];

export function buildFallbackQuestions(flags: RiskFlags): SupplierQuestions {
  const pairs: QuestionPair[] = [...BASE_QUESTIONS];

  if (flags.isElectrical) pairs.push(...ELECTRICAL_QUESTIONS);
  if (flags.sizeGridRelevant) pairs.push(...CLOTHING_QUESTIONS);
  if (flags.hasBrand) pairs.push(...BRAND_QUESTIONS);

  return {
    ru: pairs.map((p, i) => `${i + 1}. ${p.ru}`),
    cn: pairs.map((p) => p.cn),
  };
}

// ─── Форматирование для Telegram ────────────────────────────────────────────

export function formatQuestionsRu(q: SupplierQuestions): string {
  return '📩 <b>Вопросы поставщику (русский)</b>\n\n' + q.ru.join('\n');
}

export function formatQuestionsCn(q: SupplierQuestions): string {
  const lines = q.cn.join('\n');
  return `📩 <b>Вопросы поставщику (中文)</b>\n\n<code>${lines}</code>`;
}

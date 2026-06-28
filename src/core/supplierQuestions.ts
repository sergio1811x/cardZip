import type { RiskFlags, SupplierQuestions } from '../types';

// ─── Fallback (если LLM не вернул вопросы) ──────────────────────────────────

interface QuestionPair {
  ru: string;
  cn: string;
  key?: string;
}

export interface SupplierQuestionContext {
  hasConfirmedTierPrices?: boolean;
  hasConfirmedPackedWeight?: boolean;
  hasConfirmedDimensions?: boolean;
  hasRealPhotos?: boolean;
  hasPackagingInfo?: boolean;
  hasPowerWatts?: boolean;
  hasVoltage?: boolean;
  hasBatteryInfo?: boolean;
  hasDocumentsInfo?: boolean;
  hasSizeTable?: boolean;
  hasSizeMixInfo?: boolean;
}

const BASE_QUESTIONS: QuestionPair[] = [
  { key: 'sample', ru: 'Можно ли заказать образец?', cn: '可以先订样品吗？' },
  { key: 'tierPrices', ru: 'Какая цена при заказе 20 / 50 / 100 штук?', cn: '订购20/50/100件的价格分别是多少？' },
  { key: 'packaging', ru: 'Возможна ли нейтральная упаковка без бренда?', cn: '可以做无品牌包装吗？' },
  { key: 'realPhotos', ru: 'Есть ли реальные фото и видео товара?', cn: '可以提供产品实拍图和视频吗？' },
  { key: 'packedWeight', ru: 'Какие размеры и вес товара с индивидуальной упаковкой?', cn: '单个产品和包装后的尺寸、毛重是多少？' },
];

const ELECTRICAL_QUESTIONS: QuestionPair[] = [
  { key: 'power', ru: 'Какая мощность в ваттах?', cn: '功率是多少瓦？' },
  { key: 'voltage', ru: 'Какое напряжение и тип питания?', cn: '电压和供电方式是什么？' },
  { key: 'battery', ru: 'Есть ли аккумулятор? Какая ёмкость?', cn: '是否有电池？电池容量是多少？' },
  { key: 'documents', ru: 'Какие документы доступны для товара?', cn: '产品有哪些证书和文件？' },
];

const CLOTHING_QUESTIONS: QuestionPair[] = [
  { key: 'sizeTable', ru: 'Пришлите размерную таблицу в сантиметрах.', cn: '请提供以厘米为单位的尺码表。' },
  { key: 'sizeError', ru: 'Какова погрешность размеров?', cn: '尺寸误差范围是多少？' },
  { key: 'sizeMix', ru: 'Можно ли смешивать размеры и цвета в одном заказе?', cn: '一个订单可以混合不同尺码和颜色吗？' },
];

const BRAND_QUESTIONS: QuestionPair[] = [
  { key: 'noLogo', ru: 'Возможна ли поставка без логотипа и без брендированной упаковки?', cn: '可以去掉logo和品牌包装发货吗？' },
];

function shouldKeepQuestion(pair: QuestionPair, context: SupplierQuestionContext): boolean {
  switch (pair.key) {
    case 'tierPrices':
      return !context.hasConfirmedTierPrices;
    case 'packaging':
    case 'noLogo':
      return !context.hasPackagingInfo;
    case 'realPhotos':
      return !context.hasRealPhotos;
    case 'packedWeight':
      return !(context.hasConfirmedPackedWeight && context.hasConfirmedDimensions);
    case 'power':
      return !context.hasPowerWatts;
    case 'voltage':
      return !context.hasVoltage;
    case 'battery':
      return !context.hasBatteryInfo;
    case 'documents':
      return !context.hasDocumentsInfo;
    case 'sizeTable':
      return !context.hasSizeTable;
    case 'sizeMix':
      return !context.hasSizeMixInfo;
    default:
      return true;
  }
}

export function buildFallbackQuestions(flags: RiskFlags, context: SupplierQuestionContext = {}): SupplierQuestions {
  const pairs: QuestionPair[] = [...BASE_QUESTIONS];

  if (flags.isElectrical) pairs.push(...ELECTRICAL_QUESTIONS);
  if (flags.sizeGridRelevant) pairs.push(...CLOTHING_QUESTIONS);
  if (flags.hasBrand) pairs.push(...BRAND_QUESTIONS);

  const filtered = pairs.filter((p) => shouldKeepQuestion(p, context)).slice(0, 12);

  return {
    ru: filtered.map((p, i) => `${i + 1}. ${p.ru}`),
    cn: filtered.map((p) => p.cn),
  };
}

// ─── Форматирование для Telegram ────────────────────────────────────────────

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatQuestionsRu(q: SupplierQuestions): string {
  const lines = (q.ru ?? []).map(escapeHtml).join('\n');
  return '📩 <b>Вопросы поставщику (русский)</b>\n\n' + lines;
}

export function formatQuestionsCn(q: SupplierQuestions): string {
  const lines = (q.cn ?? []).map(escapeHtml).join('\n');
  return `📩 <b>Вопросы поставщику (中文)</b>\n\n<code>${lines}</code>`;
}

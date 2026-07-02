export type RawAttribute = { name?: string; key?: string; label?: string; value?: unknown };

export type NormalizedAttribute = {
  key: string;
  label: string;
  value: string;
  confidence: 'high' | 'medium' | 'low';
  sourceReason: string;
};

export type EvidenceAttribute = {
  key: string;
  value: string;
  reason: string;
};

export type CleanedAttributes = {
  userFacing: NormalizedAttribute[];
  evidenceOnly: EvidenceAttribute[];
  trash: EvidenceAttribute[];
  rejectedTitleCandidates: Array<{ value: string; reason: string }>;
};

const SOURCE_LABEL_RX = /\s*(?:—|-|\()\s*(?:из\s+карточки\s+1688|from\s+1688|source\s*:?\s*1688)\)?\s*/gi;
const CHINESE_RX = /[\u3400-\u9fff\uf900-\ufaff]/;
const CROSS_BORDER_RX = /cross[\s-]?border|跨境|外贸|для\s*cross[\s-]?border|cross-border\s*торгов/i;
const RAW_TRASH_VALUE_RX = /^(?:\+|0|товар|goods?|unknown|undefined|null|nan|n\/a|неизвестно|для\s*cross[\s-]?border\s*торговли\s*функции|функции)$/i;
const RAW_TRASH_KEY_RX = /^(?:source|источник|debug|raw|extra|trace|market|channel|sales\s*channel|cross[\s-]?border|аудитория|audience|gender|пол|season|сезон|остаток|stock)$/i;
const USEFUL_KEY_RX = /материал|材质|面料|成分|размер|尺寸|длина|ширина|высота|重量|вес|цвет|颜色|комплект|套装|упаков|包装|назначение|用途|объ[её]м|容量|модель|型号|ярус|层|тип\s*установ|конструк|особен/i;
const EVIDENCE_ONLY_KEY_RX = /категор|category|1688|跨境|cross[\s-]?border|sales|channel|raw|tag|标签|type|тип|функц/i;
const FASHION_ONLY_KEYS_RX = /аудитория|audience|gender|пол|season|сезон/i;

function text(value: unknown): string {
  return String(value ?? '')
    .replace(SOURCE_LABEL_RX, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function rawKey(attr: RawAttribute): string {
  return text(attr.name ?? attr.key ?? attr.label ?? '');
}

export function stripRawSourceLabels(value: unknown): string {
  return text(value);
}

export function containsRawPollution(value: unknown): boolean {
  const v = text(value).toLowerCase();
  return /из\s+карточки\s+1688|cross[\s-]?border|для\s*cross[\s-]?border\s*торговли|\b(?:undefined|null|nan|debug|raw)\b/i.test(v);
}

export function isMaterialLikeSupplierName(value: unknown): boolean {
  const v = text(value).toLowerCase();
  if (!v) return false;
  if (/нержавеющ|сталь|steel|塑料|пластик|полиэстер|сплав|железо|алюмини|metal|材质/.test(v)) return true;
  return false;
}

export function shouldHideRawAttribute(keyRaw: unknown, valueRaw: unknown, context: { fashionLike?: boolean } = {}): boolean {
  const key = text(keyRaw).toLowerCase();
  const value = text(valueRaw).toLowerCase();
  if (!key && !value) return true;
  if (RAW_TRASH_VALUE_RX.test(value)) return true;
  if (CROSS_BORDER_RX.test(key) || CROSS_BORDER_RX.test(value)) return true;
  if (RAW_TRASH_KEY_RX.test(key)) return true;
  if (!context.fashionLike && FASHION_ONLY_KEYS_RX.test(key)) return true;
  if (/^артикул$/i.test(key) && /^\+$/.test(value)) return true;
  if (/материал|材质|material/i.test(key) && /^[,，\s]+$/.test(value)) return true;
  if (/^stock|остаток$/i.test(key) && Number(value) > 1_000_000) return true;
  return false;
}

export function normalizeUsefulAttribute(keyRaw: unknown, valueRaw: unknown, context: { fashionLike?: boolean } = {}): NormalizedAttribute | null {
  const key = text(keyRaw);
  const value = text(valueRaw);
  if (!key || !value) return null;
  if (shouldHideRawAttribute(key, value, context)) return null;
  if (!USEFUL_KEY_RX.test(key) && !USEFUL_KEY_RX.test(value)) return null;
  const label = key
    .replace(/材质|面料|成分/gi, 'Материал')
    .replace(/尺寸|规格/gi, 'Размер')
    .replace(/颜色/gi, 'Цвет')
    .replace(/包装/gi, 'Упаковка')
    .replace(/重量/gi, 'Вес')
    .replace(/型号/gi, 'Модель')
    .replace(/层数|层/gi, 'Количество ярусов')
    .replace(/\s+/g, ' ')
    .trim();
  const confidence: NormalizedAttribute['confidence'] = CHINESE_RX.test(value) ? 'medium' : 'high';
  return { key, label, value, confidence, sourceReason: 'cleaned_1688_attribute' };
}

export function extractEvidenceOnlyAttributes(rawAttributes: RawAttribute[] = [], context: { fashionLike?: boolean } = {}): EvidenceAttribute[] {
  const out: EvidenceAttribute[] = [];
  for (const attr of rawAttributes) {
    const key = rawKey(attr);
    const value = text(attr.value);
    if (!key && !value) continue;
    if (shouldHideRawAttribute(key, value, context)) {
      out.push({ key, value, reason: 'hidden_or_trash_raw_attribute' });
      continue;
    }
    if (EVIDENCE_ONLY_KEY_RX.test(key) || EVIDENCE_ONLY_KEY_RX.test(value)) {
      out.push({ key, value, reason: 'evidence_only_attribute' });
    }
  }
  return out;
}

export function cleanRawAttributes(rawAttributes: RawAttribute[] = [], context: { fashionLike?: boolean } = {}): CleanedAttributes {
  const userFacing: NormalizedAttribute[] = [];
  const evidenceOnly: EvidenceAttribute[] = [];
  const trash: EvidenceAttribute[] = [];
  const rejectedTitleCandidates: Array<{ value: string; reason: string }> = [];
  const seen = new Set<string>();

  for (const attr of rawAttributes) {
    const key = rawKey(attr);
    const value = text(attr.value);
    if (!key && !value) continue;
    const normalized = normalizeUsefulAttribute(key, value, context);
    if (normalized) {
      const dedupKey = `${normalized.label.toLowerCase()}:${normalized.value.toLowerCase()}`;
      if (!seen.has(dedupKey)) {
        seen.add(dedupKey);
        userFacing.push(normalized);
      }
      continue;
    }
    const record = { key, value, reason: shouldHideRawAttribute(key, value, context) ? 'trash_or_hidden' : 'evidence_only' };
    if (record.reason === 'trash_or_hidden') trash.push(record);
    else evidenceOnly.push(record);
    if (value && (CROSS_BORDER_RX.test(value) || RAW_TRASH_VALUE_RX.test(value) || /функции|товар/i.test(value))) {
      rejectedTitleCandidates.push({ value, reason: 'raw attribute is not a product title' });
    }
  }

  return { userFacing, evidenceOnly, trash, rejectedTitleCandidates };
}

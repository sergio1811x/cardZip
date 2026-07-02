import { stripRawSourceLabels } from './rawAttributeCleaner';

export const LEGACY_MARKET_TEXT_RX = /\b(?:WB|Ozon|Wildberries|ROI)\b|\b(?:roi|market|marketplace)\b|\b(?:марж[а-я]*|прибыл[а-я]*|доходност[а-я]*|окупаемост[а-я]*|продажн(?:ая|ую|ой|ые)?\s+цен[а-я]*|рыночн[а-я]*\s+цен[а-я]*|аналог[а-я]*\s+(?:на|в)\s*(?:WB|Ozon|ВБ))\b/gi;

const LINE_DROP_RX = /(?:\b(?:WB|Ozon|Wildberries|ROI)\b|\b(?:марж[а-я]*|прибыл[а-я]*|доходност[а-я]*|окупаемост[а-я]*|рынок\s+провер|рыночн[а-я]*\s+цен[а-я]*|продажн(?:ая|ую|ой|ые)?\s+цен[а-я]*|аналоги?\s+(?:на|в)\s*(?:WB|Ozon|ВБ))\b)/i;

export function sanitizeUserFacingText(input: unknown): string {
  let text = stripRawSourceLabels(String(input ?? ''));
  text = text
    .replace(/\bWB\/Ozon\b/gi, 'карточки товара')
    .replace(/\bWB\b/gi, 'карточки товара')
    .replace(/\bOzon\b/gi, 'карточки товара')
    .replace(/\bWildberries\b/gi, 'карточки товара')
    .replace(/\bROI\b/gi, 'себестоимость')
    .replace(/\broi\b/gi, 'себестоимость')
    .replace(/\bmarketplace\b/gi, 'карточка товара')
    .replace(/\bmarket\b/gi, 'закупочный контекст')
    .replace(/\bмарж[а-я]*\b/gi, 'себестоимость')
    .replace(/\bприбыл[а-я]*\b/gi, 'результат')
    .replace(/\bдоходност[а-я]*\b/gi, 'результат')
    .replace(/\bокупаемост[а-я]*\b/gi, 'результат')
    .replace(/\bпродажн(?:ая|ую|ой|ые)?\s+цен[а-я]*\b/gi, 'цена продажи')
    .replace(/\bрыночн[а-я]*\s+цен[а-я]*\b/gi, 'цена продажи')
    .replace(/\bаналоги?\s+(?:на|в)\s*(?:ВБ|WB|Ozon)\b/gi, 'похожие товары')
    .replace(/cross[\s-]?border|для\s*cross[\s-]?border\s*торговли|для\s+торговли\s+функции/gi, '')
    .replace(/из\s+карточки\s+1688/gi, '')
    .replace(/\b(?:undefined|null|NaN|Infinity|-Infinity)\b/gi, '')
    .replace(/0(?:[,.]0+)?\s*[₽¥￥]/g, 'нужно уточнить')
    .replace(/0(?:[,.]0+)?\s*кг/gi, 'вес не указан')
    .replace(/поставщpику/g, 'поставщику')
    .replace(/матеpиал/g, 'материал');
  text = text
    .split('\n')
    .filter((line) => !LINE_DROP_RX.test(line) || /себестоимост|цена товара|закупк|карго|пакет|вопрос/i.test(line))
    .join('\n');
  return text.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

export function containsForbiddenMarketText(input: unknown): boolean {
  return LEGACY_MARKET_TEXT_RX.test(String(input ?? ''));
}

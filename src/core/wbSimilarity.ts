import type { WbCard, RawProduct1688 } from '../types';

export interface ScoredCard extends WbCard {
  similarity: number;
  level: 'high' | 'medium' | 'low';
}

export interface SimilarityResult {
  queries: string[];
  totalAnalyzed: number;
  highCards: ScoredCard[];
  mediumCards: ScoredCard[];
  lowCards: ScoredCard[];
  marketStatus: 'confirmed' | 'limited' | 'insufficient';
}

interface ProductTraits {
  category: string[];
  functions: string[];
  tech: string[];
  material: string[];
  gender: string[];
}

function extractTraits(product: RawProduct1688, titleRu?: string): ProductTraits {
  const text = [
    product.titleCn,
    product.titleEn ?? '',
    titleRu ?? '',
    product.categoryName ?? '',
    ...(product.attributes ?? []).map(a => `${a.name} ${a.value}`),
  ].join(' ').toLowerCase();

  return {
    category: extractWords(text, CATEGORY_WORDS),
    functions: extractWords(text, FUNCTION_WORDS),
    tech: extractWords(text, TECH_WORDS),
    material: extractWords(text, MATERIAL_WORDS),
    gender: extractWords(text, GENDER_WORDS),
  };
}

function extractWords(text: string, dictionary: string[]): string[] {
  return dictionary.filter(w => text.includes(w));
}

const CATEGORY_WORDS = [
  'леггинсы', 'брюки', 'штаны', 'джинсы', 'юбка', 'платье', 'куртка', 'пальто',
  'зонт', 'сумка', 'рюкзак', 'кошелек', 'часы', 'очки', 'шапка', 'шарф',
  'вентилятор', 'лампа', 'фен', 'утюг', 'блендер', 'чайник', 'кофеварка',
  'пусковое', 'компрессор', 'зарядное', 'аккумулятор', 'наушники', 'колонка',
  'leggings', 'pants', 'dress', 'jacket', 'umbrella', 'bag', 'fan', 'lamp',
  '打底裤', '裤', '裙', '伞', '包', '风扇', '灯',
];

const FUNCTION_WORDS = [
  'автомат', 'ручной', 'складной', 'беспроводной', 'bluetooth', 'usb',
  'утягивающие', 'компрессионные', 'спортивные', 'антиветер', 'водонепроницаемый',
  'пусковое устройство', 'компрессор', 'насос', 'зарядка',
  'automatic', 'wireless', 'portable', 'foldable',
];

const TECH_WORDS = [
  '12v', '24v', '220v', '110v', '3000a', '1500a', '2000a', '5v', '2a',
  'mah', 'вт', 'квт', 'w', 'kw', 'rpm', 'db', 'led',
  'type-c', 'usb-c', 'micro-usb', 'lightning',
];

const MATERIAL_WORDS = [
  'полиэстер', 'спандекс', 'хлопок', 'нейлон', 'шелк', 'кожа', 'замша',
  'пластик', 'металл', 'алюминий', 'сталь', 'стекло', 'керамика', 'дерево',
  'polyester', 'spandex', 'cotton', 'nylon', 'leather', 'plastic', 'metal',
];

const GENDER_WORDS = [
  'женские', 'мужские', 'детские', 'унисекс', 'для девочек', 'для мальчиков',
  'women', 'men', 'kids', 'unisex',
  '女', '男', '儿童',
];

interface CardScore {
  score: number;
  hasCategoryMatch: boolean;
  hasFunctionMatch: boolean;
}

function scoreCard(cardTitle: string, sourceTraits: ProductTraits): CardScore {
  const title = cardTitle.toLowerCase();
  let score = 0;

  const catMatch = sourceTraits.category.some(w => title.includes(w));
  if (catMatch) score += 35;

  const funcMatches = sourceTraits.functions.filter(w => title.includes(w)).length;
  if (funcMatches >= 1) score += Math.min(25, funcMatches * 12);

  const techMatches = sourceTraits.tech.filter(w => title.includes(w)).length;
  if (techMatches >= 1) score += Math.min(20, techMatches * 10);

  const genderMatch = sourceTraits.gender.some(w => title.includes(w));
  if (genderMatch) score += 10;

  const matMatch = sourceTraits.material.some(w => title.includes(w));
  if (matMatch) score += 10;

  return { score: Math.min(100, score), hasCategoryMatch: catMatch, hasFunctionMatch: funcMatches >= 1 };
}

function getLevel(cs: CardScore): 'high' | 'medium' | 'low' {
  // High требует: категория + функция + score >= 55
  if (cs.score >= 55 && cs.hasCategoryMatch && cs.hasFunctionMatch) return 'high';
  // Medium: категория совпала + score >= 30
  if (cs.score >= 30 && cs.hasCategoryMatch) return 'medium';
  return 'low';
}

export function scoreSimilarity(
  cards: WbCard[],
  product: RawProduct1688,
  titleRu?: string,
  queries?: string[]
): SimilarityResult {
  const traits = extractTraits(product, titleRu);

  // Дедупликация по URL
  const seen = new Set<string>();
  const unique = cards.filter(c => {
    if (seen.has(c.url)) return false;
    seen.add(c.url);
    return true;
  });

  const scored: ScoredCard[] = unique.map(card => {
    const cs = scoreCard(card.title, traits);
    return { ...card, similarity: cs.score, level: getLevel(cs) };
  });

  const highCards = scored.filter(c => c.level === 'high').sort((a, b) => b.similarity - a.similarity);
  const mediumCards = scored.filter(c => c.level === 'medium').sort((a, b) => b.similarity - a.similarity);
  const lowCards = scored.filter(c => c.level === 'low');

  let marketStatus: 'confirmed' | 'limited' | 'insufficient';
  if (highCards.length >= 15) marketStatus = 'confirmed';
  else if (highCards.length >= 5 || highCards.length + mediumCards.length >= 15) marketStatus = 'limited';
  else marketStatus = 'insufficient';

  return {
    queries: queries ?? [],
    totalAnalyzed: unique.length,
    highCards,
    mediumCards,
    lowCards,
    marketStatus,
  };
}

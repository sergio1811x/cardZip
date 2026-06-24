import type { WbCard } from '../types';
import type { ProductStructure, WbQueryPlan } from '../providers/productUnderstanding';

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

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^а-яёa-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function containsAny(text: string, terms: string[]): boolean {
  return terms.some(t => text.includes(t.toLowerCase()));
}

function containsAnyGroup(text: string, groups: string[][]): boolean {
  return groups.some(group => group.some(t => text.includes(t.toLowerCase())));
}

function isExcludedOnly(text: string, required: string[][], excluded: string[][]): boolean {
  const hasRequired = containsAnyGroup(text, required);
  if (hasRequired) return false;
  return containsAnyGroup(text, excluded);
}

function scoreCardSmart(
  cardTitle: string,
  structure: ProductStructure,
  plan: WbQueryPlan | null
): { score: number; hasType: boolean; hasFunction: boolean } {
  const text = normalize(cardTitle);
  let score = 0;
  let hasType = false;
  let hasFunction = false;

  // Проверка на negative match (полное исключение)
  for (const neg of structure.negativeMatches) {
    const negNorm = neg.toLowerCase();
    if (text.includes(negNorm) && !text.includes(structure.productType.toLowerCase())) {
      return { score: 0, hasType: false, hasFunction: false };
    }
  }

  // excludeIfOnlyMatch
  if (plan && isExcludedOnly(text, plan.requiredConcepts, plan.excludeIfOnlyMatch)) {
    return { score: 0, hasType: false, hasFunction: false };
  }

  // Product type match (+40)
  const typeWords = [structure.productType, ...(structure.subtype ? [structure.subtype] : [])];
  if (containsAny(text, typeWords)) {
    score += 40;
    hasType = true;
  } else if (plan && containsAnyGroup(text, plan.requiredConcepts)) {
    score += 35;
    hasType = true;
  }

  // Must-have features (+25 max)
  const mustMatches = structure.mustHaveFeatures.filter(f => text.includes(f.toLowerCase())).length;
  if (mustMatches > 0) {
    score += Math.min(25, mustMatches * 12);
    hasFunction = true;
  }

  // Important features (+20 max)
  const impMatches = structure.importantFeatures.filter(f => text.includes(f.toLowerCase())).length;
  score += Math.min(20, impMatches * 8);
  if (impMatches > 0) hasFunction = true;

  // Bonus concepts (+10 max)
  if (plan) {
    const bonusMatches = plan.bonusConcepts.filter(g => g.some(t => text.includes(t.toLowerCase()))).length;
    score += Math.min(10, bonusMatches * 5);
  }

  // Technical specs (+5 each, max 10)
  const specMatches = Object.values(structure.technicalSpecs).filter(v => text.includes(v.toLowerCase())).length;
  score += Math.min(10, specMatches * 5);

  return { score: Math.min(100, score), hasType, hasFunction };
}

function getLevel(score: number, hasType: boolean, hasFunction: boolean): 'high' | 'medium' | 'low' {
  if (score >= 55 && hasType && hasFunction) return 'high';
  if (score >= 30 && hasType) return 'medium';
  return 'low';
}

export function scoreSimilarity(
  cards: WbCard[],
  structure: ProductStructure | null,
  plan: WbQueryPlan | null,
  queries: string[]
): SimilarityResult {
  // Дедупликация по URL
  const seen = new Set<string>();
  const unique = cards.filter(c => {
    if (seen.has(c.url)) return false;
    seen.add(c.url);
    return true;
  });

  if (!structure) {
    // Fallback без LLM-структуры — все карточки medium
    const scored: ScoredCard[] = unique.map(card => ({ ...card, similarity: 30, level: 'medium' as const }));
    return {
      queries,
      totalAnalyzed: unique.length,
      highCards: [],
      mediumCards: scored,
      lowCards: [],
      marketStatus: scored.length >= 15 ? 'limited' : 'insufficient',
    };
  }

  const scored: ScoredCard[] = unique.map(card => {
    const { score, hasType, hasFunction } = scoreCardSmart(card.title, structure, plan);
    return { ...card, similarity: score, level: getLevel(score, hasType, hasFunction) };
  });

  const highCards = scored.filter(c => c.level === 'high').sort((a, b) => b.similarity - a.similarity);
  const mediumCards = scored.filter(c => c.level === 'medium').sort((a, b) => b.similarity - a.similarity);
  const lowCards = scored.filter(c => c.level === 'low');

  let marketStatus: 'confirmed' | 'limited' | 'insufficient';
  if (highCards.length >= 15) marketStatus = 'confirmed';
  else if (highCards.length >= 5 || highCards.length + mediumCards.length >= 15) marketStatus = 'limited';
  else marketStatus = 'insufficient';

  return { queries, totalAnalyzed: unique.length, highCards, mediumCards, lowCards, marketStatus };
}

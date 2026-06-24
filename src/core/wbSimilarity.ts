import type { WbCard } from '../types';
import type { ProductStructure, WbQueryPlan } from '../providers/productUnderstanding';

export interface ScoredCard extends WbCard {
  similarity: number;
  level: 'high' | 'medium' | 'low';
  matched: string[];
  missing: string[];
}

export interface SimilarityResult {
  queries: string[];
  totalAnalyzed: number;
  highCards: ScoredCard[];
  mediumCards: ScoredCard[];
  lowCards: ScoredCard[];
  leaders: ScoredCard[];
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
  if (containsAnyGroup(text, required)) return false;
  return containsAnyGroup(text, excluded);
}

interface ScoreResult {
  score: number;
  hasType: boolean;
  hasFunction: boolean;
  matched: string[];
  missing: string[];
}

function scoreCardSmart(
  cardTitle: string,
  structure: ProductStructure,
  plan: WbQueryPlan | null
): ScoreResult {
  const text = normalize(cardTitle);
  let score = 0;
  const matched: string[] = [];
  const missing: string[] = [];

  // coreNoun обязателен — без него карточка сразу low
  const hasCoreNoun = text.includes(structure.coreNoun.toLowerCase());
  if (!hasCoreNoun) {
    // Проверяем синонимы из requiredConcepts
    const hasSynonym = plan ? containsAnyGroup(text, plan.requiredConcepts) : false;
    if (!hasSynonym) {
      missing.push(structure.coreNoun);
      return { score: 0, hasType: false, hasFunction: false, matched, missing };
    }
  }

  // Negative match
  for (const neg of structure.negativeMatches) {
    if (text.includes(neg.toLowerCase()) && !hasCoreNoun) {
      return { score: 0, hasType: false, hasFunction: false, matched, missing: [neg] };
    }
  }

  // excludeIfOnlyMatch
  if (plan && isExcludedOnly(text, plan.requiredConcepts, plan.excludeIfOnlyMatch)) {
    return { score: 0, hasType: false, hasFunction: false, matched, missing };
  }

  // Product type (+40)
  matched.push(structure.coreNoun);
  score += 40;
  let hasType = true;

  // Modifiers (+5 each, max 15)
  for (const mod of structure.modifiers) {
    if (text.includes(mod.toLowerCase())) {
      matched.push(mod);
      score += 5;
    } else {
      missing.push(mod);
    }
  }
  score = Math.min(score, 55);

  // Must-have features (+12 each, max 25)
  let hasFunction = false;
  for (const f of structure.mustHaveFeatures) {
    if (text.includes(f.toLowerCase())) {
      matched.push(f);
      score += 12;
      hasFunction = true;
    } else {
      missing.push(f);
    }
  }

  // Important features (+8 each, max 20)
  for (const f of structure.importantFeatures) {
    if (text.includes(f.toLowerCase())) {
      matched.push(f);
      score += 8;
    }
  }

  // Bonus concepts (+5 each, max 10)
  if (plan) {
    for (const group of plan.bonusConcepts) {
      if (group.some(t => text.includes(t.toLowerCase()))) {
        score += 5;
      }
    }
  }

  return { score: Math.min(100, score), hasType, hasFunction, matched, missing };
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
  const seen = new Set<string>();
  const unique = cards.filter(c => {
    if (seen.has(c.url)) return false;
    seen.add(c.url);
    return true;
  });

  if (!structure) {
    const scored: ScoredCard[] = unique.map(card => ({
      ...card, similarity: 30, level: 'medium' as const, matched: [], missing: [],
    }));
    return {
      queries, totalAnalyzed: unique.length,
      highCards: [], mediumCards: scored, lowCards: [],
      leaders: scored.sort((a, b) => b.feedbacks - a.feedbacks).slice(0, 10),
      marketStatus: scored.length >= 15 ? 'limited' : 'insufficient',
    };
  }

  const scored: ScoredCard[] = unique.map(card => {
    const r = scoreCardSmart(card.title, structure, plan);
    return { ...card, similarity: r.score, level: getLevel(r.score, r.hasType, r.hasFunction), matched: r.matched, missing: r.missing };
  });

  const highCards = scored.filter(c => c.level === 'high').sort((a, b) => b.similarity - a.similarity);
  const mediumCards = scored.filter(c => c.level === 'medium').sort((a, b) => b.similarity - a.similarity);
  const lowCards = scored.filter(c => c.level === 'low');

  // Лидеры рынка: топ по отзывам среди high+medium
  const leaders = [...highCards, ...mediumCards]
    .sort((a, b) => {
      const scoreA = a.similarity * 0.6 + Math.log(Math.max(a.feedbacks, 1)) * 10 * 0.25 + a.rating * 20 * 0.15;
      const scoreB = b.similarity * 0.6 + Math.log(Math.max(b.feedbacks, 1)) * 10 * 0.25 + b.rating * 20 * 0.15;
      return scoreB - scoreA;
    })
    .slice(0, 10);

  let marketStatus: 'confirmed' | 'limited' | 'insufficient';
  if (highCards.length >= 15) marketStatus = 'confirmed';
  else if (highCards.length >= 5 || highCards.length + mediumCards.length >= 15) marketStatus = 'limited';
  else marketStatus = 'insufficient';

  return { queries, totalAnalyzed: unique.length, highCards, mediumCards, lowCards, leaders, marketStatus };
}

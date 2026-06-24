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

  // ─── ЖЁСТКИЕ ФИЛЬТРЫ (карточка сразу вылетает) ──────────────────────

  // 1. Negative match → -100
  for (const neg of structure.negativeMatches) {
    if (text.includes(neg.toLowerCase())) {
      return { score: 0, hasType: false, hasFunction: false, matched, missing: [neg] };
    }
  }

  // 2. coreNoun обязателен
  const hasCoreNoun = text.includes(structure.coreNoun.toLowerCase());
  const hasSynonym = plan ? containsAnyGroup(text, plan.requiredConcepts) : false;
  if (!hasCoreNoun && !hasSynonym) {
    missing.push(structure.coreNoun);
    return { score: 0, hasType: false, hasFunction: false, matched, missing };
  }

  // 3. formFactor — если другой форм-фактор, исключаем
  if (structure.formFactor) {
    const ff = structure.formFactor.toLowerCase();
    const CONFLICTING_FORMS: Record<string, string[]> = {
      'настольный': ['ручной', 'шейный', 'напольный', 'потолочный', 'карманный'],
      'напольный': ['настольный', 'ручной', 'шейный', 'потолочный', 'карманный'],
      'ручной': ['настольный', 'напольный', 'потолочный', 'стационарный'],
      'складной': ['жёсткий', 'трость'],
      'портативный': ['стационарный', 'встроенный'],
    };
    const conflicts = CONFLICTING_FORMS[ff] ?? [];
    for (const c of conflicts) {
      if (text.includes(c)) {
        return { score: 0, hasType: false, hasFunction: false, matched, missing: [c + ' (другой формат)'] };
      }
    }
  }

  // 4. excludeIfOnlyMatch
  if (plan && isExcludedOnly(text, plan.requiredConcepts, plan.excludeIfOnlyMatch)) {
    return { score: 0, hasType: false, hasFunction: false, matched, missing };
  }

  // ─── СКОРИНГ ─────────────────────────────────────────────────────────

  // ProductType совпал (+50)
  const typeMatch = text.includes(structure.productType.toLowerCase());
  if (typeMatch) {
    matched.push(structure.productType);
    score += 50;
  }

  // CoreNoun (+30)
  if (hasCoreNoun) {
    matched.push(structure.coreNoun);
    score += 30;
  } else {
    score += 25; // synonym
  }
  let hasType = true;

  // FormFactor (+25)
  if (structure.formFactor && text.includes(structure.formFactor.toLowerCase())) {
    matched.push(structure.formFactor);
    score += 25;
  } else if (structure.formFactor) {
    missing.push(structure.formFactor);
  }

  // Must-have features / functions (+20 each)
  let hasFunction = false;
  for (const f of structure.mustHaveFeatures) {
    if (text.includes(f.toLowerCase())) {
      matched.push(f);
      score += 20;
      hasFunction = true;
    } else {
      missing.push(f);
    }
  }

  // PowerType (+10)
  for (const pt of structure.powerType) {
    if (text.includes(pt.toLowerCase())) {
      matched.push(pt);
      score += 10;
      break;
    }
  }

  // Important features (+8 each, max 16)
  let impScore = 0;
  for (const f of structure.importantFeatures) {
    if (text.includes(f.toLowerCase())) {
      matched.push(f);
      impScore += 8;
    }
  }
  score += Math.min(16, impScore);

  // Bonus concepts (+5 each, max 10)
  if (plan) {
    let bonusScore = 0;
    for (const group of plan.bonusConcepts) {
      if (group.some(t => text.includes(t.toLowerCase()))) bonusScore += 5;
    }
    score += Math.min(10, bonusScore);
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

  // Лидеры рынка: дедупликация по продавцу (1 seller = 1 карточка)
  const leaderCandidates = [...highCards, ...mediumCards]
    .sort((a, b) => {
      const scoreA = a.similarity * 0.6 + Math.log(Math.max(a.feedbacks, 1)) * 10 * 0.25 + a.rating * 20 * 0.15;
      const scoreB = b.similarity * 0.6 + Math.log(Math.max(b.feedbacks, 1)) * 10 * 0.25 + b.rating * 20 * 0.15;
      return scoreB - scoreA;
    });

  const leaders: ScoredCard[] = [];
  const seenPrices = new Set<number>();
  for (const card of leaderCandidates) {
    // Дедуп по цене+отзывам (proxy для одного продавца)
    const key = card.price * 1000 + card.feedbacks;
    if (seenPrices.has(key)) continue;
    seenPrices.add(key);
    leaders.push(card);
    if (leaders.length >= 10) break;
  }

  let marketStatus: 'confirmed' | 'limited' | 'insufficient';
  if (highCards.length >= 10) marketStatus = 'confirmed';       // 🟢
  else if (highCards.length >= 3) marketStatus = 'limited';     // 🟡
  else marketStatus = 'insufficient';                           // 🔴

  return { queries, totalAnalyzed: unique.length, highCards, mediumCards, lowCards, leaders, marketStatus };
}

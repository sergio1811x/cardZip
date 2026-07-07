import type { AnalysisSnapshot } from '../core/analysisSnapshot';
import type { GapPlannerResult } from '../types';
import { GapPlannerResultSchema, parseLlmJson } from '../core/llmSchemas';

const GAP_PLANNER_MODELS = [
  'deepseek/deepseek-v4-pro',
  'google/gemini-3.1-flash-lite',
  'openai/gpt-5-mini',
];

const GAP_PLANNER_PROMPT = `CardZip Gap Planner.

Роль: planner недостающих подтверждений. Ты не writer и не classifier.

Источник правды: analysisSnapshot.factSheet, analysisSnapshot.categoryPolicy, analysisSnapshot.purchasePrice, analysisSnapshot.weight, analysisSnapshot.sku.

Задача:
- найти факты, без которых нельзя безопасно подтвердить закупочный пакет;
- сформировать короткий список вопросов поставщику без дублей;
- не придумывать значения и числа;
- если есть conflict — просить подтвердить конфликтующее поле, а не выбирать значение.

Верни строго JSON:
{
  "missingFacts": ["..."],
  "supplierQuestionsRu": ["..."],
  "requiredConfirmations": ["..."],
  "warnings": ["..."]
}

Правила:
- supplierQuestionsRu: максимум 12;
- каждый вопрос должен закрывать отдельный пробел;
- никаких CN текстов;
- никаких SEO и маркетинга.

DATA:
{{GAP_INPUT}}
`;

function compactSnapshot(snapshot: AnalysisSnapshot): Record<string, unknown> {
  const s = snapshot as any;
  return {
    offerId: s.offerId,
    productContext: s.productContext,
    purchasePrice: s.purchasePrice,
    weight: s.weight,
    sku: s.sku,
    factSheet: s.factSheet,
    categoryPolicy: s.categoryPolicy,
    missingData: s.missingData,
    conflicts: s.conflicts,
  };
}

export async function runGapPlanner(snapshot: AnalysisSnapshot): Promise<GapPlannerResult | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  const prompt = GAP_PLANNER_PROMPT.replace(
    '{{GAP_INPUT}}',
    JSON.stringify(compactSnapshot(snapshot), null, 0).slice(0, 7000),
  );

  for (const model of GAP_PLANNER_MODELS) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1500,
          temperature: 0,
          messages: [
            { role: 'system', content: 'Ты — planner пробелов CardZip. Верни строго JSON.' },
            { role: 'user', content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(32_000),
      });
      if (!res.ok) continue;
      const data = await res.json() as { choices?: { message?: { content?: string } }[] };
      const parsed = parseLlmJson(GapPlannerResultSchema, data.choices?.[0]?.message?.content ?? '');
      if (parsed) {
        return {
          missingFacts: parsed.missingFacts ?? [],
          supplierQuestionsRu: parsed.supplierQuestionsRu ?? [],
          requiredConfirmations: parsed.requiredConfirmations ?? [],
          warnings: parsed.warnings ?? [],
        };
      }
    } catch {
      continue;
    }
  }

  return null;
}

import type { RawProductForCanonicalizer } from './productCanonicalizer';
import { buildCanonicalizerClassificationInput } from './canonicalizerClassifier';

const CLASSIFIER_MODELS = [
  'deepseek/deepseek-v4-pro',
  'google/gemini-3.1-flash-lite',
  'openai/gpt-5-mini',
];

export interface CanonicalizerClassificationLlmResult {
  visionKind: string | null;
  textKind: string | null;
  finalKind: string;
  categoryType: string;
  confidence: number;
  reason: string;
  visualEvidence: string[];
  textEvidence: string[];
}

const CLASSIFIER_PROMPT = `Ты Product Classification Role.

Роль: определить тип товара и категорию. Не пиши SEO, не пиши supplier questions, не строй полный procurement profile.

Верни строго JSON:
{
  "visionKind": "... или null",
  "textKind": "... или null",
  "finalKind": "...",
  "categoryType": "shoes|clothes|electronics|home|beauty|accessory|kitchen|tools|fishing|other",
  "confidence": 0.0,
  "reason": "...",
  "visualEvidence": ["..."],
  "textEvidence": ["..."]
}

Правила:
- не придумывай свойства;
- если уверенности мало, categoryType=other;
- отвечай только JSON.

DATA:
{{CLASSIFIER_INPUT}}
`;

function cleanJson(raw: string): string {
  return String(raw ?? '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

function parseResult(raw: string): CanonicalizerClassificationLlmResult | null {
  try {
    const parsed = JSON.parse(cleanJson(raw));
    if (!parsed || typeof parsed !== 'object') return null;
    const finalKind = String((parsed as any).finalKind ?? '').trim();
    if (!finalKind) return null;
    return {
      visionKind: (parsed as any).visionKind ? String((parsed as any).visionKind) : null,
      textKind: (parsed as any).textKind ? String((parsed as any).textKind) : null,
      finalKind,
      categoryType: String((parsed as any).categoryType ?? 'other'),
      confidence: Number((parsed as any).confidence ?? 0) || 0,
      reason: String((parsed as any).reason ?? ''),
      visualEvidence: Array.isArray((parsed as any).visualEvidence) ? (parsed as any).visualEvidence.map(String) : [],
      textEvidence: Array.isArray((parsed as any).textEvidence) ? (parsed as any).textEvidence.map(String) : [],
    };
  } catch {
    return null;
  }
}

export async function runCanonicalizerClassification(
  raw: RawProductForCanonicalizer,
): Promise<CanonicalizerClassificationLlmResult | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  const input = buildCanonicalizerClassificationInput(raw);
  const prompt = CLASSIFIER_PROMPT.replace('{{CLASSIFIER_INPUT}}', input.promptSegment);

  for (const model of CLASSIFIER_MODELS) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 900,
          temperature: 0,
          messages: [
            { role: 'system', content: 'Ты Product Classification Role. Верни строго JSON.' },
            { role: 'user', content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(38_000),
      });
      if (!res.ok) continue;
      const data = await res.json() as { choices?: { message?: { content?: string } }[] };
      const parsed = parseResult(data.choices?.[0]?.message?.content ?? '');
      if (parsed) return parsed;
    } catch {
      continue;
    }
  }

  return null;
}

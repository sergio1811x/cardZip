import type { RawProductForCanonicalizer } from './productCanonicalizer';
import { buildCanonicalizerSkuResolutionInput } from './canonicalizerSkuResolver';

const SKU_MODELS = [
  'google/gemini-3.1-flash-lite',
  'openai/gpt-5-mini',
  'deepseek/deepseek-v4-pro',
];

export interface CanonicalizerSkuLlmResult {
  selectedSkuResolved: string | null;
  candidateModels: string[];
  candidateColors: string[];
  candidatePlugStandards: string[];
  reason: string;
}

const SKU_PROMPT = `Ты SKU Resolution Role.

Роль: разобрать варианты SKU и понять, какие осмысленные параметры уже видны в названиях вариантов.

Верни строго JSON:
{
  "selectedSkuResolved": "... или null",
  "candidateModels": ["..."],
  "candidateColors": ["..."],
  "candidatePlugStandards": ["US|EU|UK|JP|KR|AU|CN"],
  "reason": "..."
}

Правила:
- не придумывай параметры, которых нет в SKU;
- не делай маркетинг;
- отвечай только JSON.

DATA:
{{SKU_INPUT}}
`;

function cleanJson(raw: string): string {
  return String(raw ?? '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

function parseResult(raw: string): CanonicalizerSkuLlmResult | null {
  try {
    const parsed = JSON.parse(cleanJson(raw));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      selectedSkuResolved: (parsed as any).selectedSkuResolved ? String((parsed as any).selectedSkuResolved) : null,
      candidateModels: Array.isArray((parsed as any).candidateModels) ? (parsed as any).candidateModels.map(String) : [],
      candidateColors: Array.isArray((parsed as any).candidateColors) ? (parsed as any).candidateColors.map(String) : [],
      candidatePlugStandards: Array.isArray((parsed as any).candidatePlugStandards) ? (parsed as any).candidatePlugStandards.map(String) : [],
      reason: String((parsed as any).reason ?? ''),
    };
  } catch {
    return null;
  }
}

export async function runCanonicalizerSkuResolution(
  raw: RawProductForCanonicalizer,
): Promise<CanonicalizerSkuLlmResult | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  const input = buildCanonicalizerSkuResolutionInput(raw);
  const prompt = SKU_PROMPT.replace('{{SKU_INPUT}}', input.promptSegment);

  for (const model of SKU_MODELS) {
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
            { role: 'system', content: 'Ты SKU Resolution Role. Верни строго JSON.' },
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

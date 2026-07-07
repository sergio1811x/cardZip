import type { RawProductForCanonicalizer } from './productCanonicalizer';
import { buildCanonicalizerPolicyInput } from './canonicalizerPolicyBuilder';

const POLICY_MODELS = [
  'google/gemini-3.1-flash-lite',
  'openai/gpt-5-mini',
  'qwen/qwen3-235b-a22b',
];

export interface CanonicalizerPolicyLlmResult {
  forbiddenClaims: string[];
  requiredChecks: string[];
  logisticsWarnings: string[];
  reason: string;
}

const POLICY_PROMPT = `Ты Policy Guard Role.

Роль: выявить опасные claims и базовые закупочные предупреждения.

Верни строго JSON:
{
  "forbiddenClaims": ["..."],
  "requiredChecks": ["..."],
  "logisticsWarnings": ["..."],
  "reason": "..."
}

Правила:
- не придумывай свойства;
- опирайся только на вход;
- отвечай только JSON.

DATA:
{{POLICY_INPUT}}
`;

function cleanJson(raw: string): string {
  return String(raw ?? '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

function parseResult(raw: string): CanonicalizerPolicyLlmResult | null {
  try {
    const parsed = JSON.parse(cleanJson(raw));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      forbiddenClaims: Array.isArray((parsed as any).forbiddenClaims) ? (parsed as any).forbiddenClaims.map(String) : [],
      requiredChecks: Array.isArray((parsed as any).requiredChecks) ? (parsed as any).requiredChecks.map(String) : [],
      logisticsWarnings: Array.isArray((parsed as any).logisticsWarnings) ? (parsed as any).logisticsWarnings.map(String) : [],
      reason: String((parsed as any).reason ?? ''),
    };
  } catch {
    return null;
  }
}

export async function runCanonicalizerPolicyGuard(
  raw: RawProductForCanonicalizer,
): Promise<CanonicalizerPolicyLlmResult | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  const input = buildCanonicalizerPolicyInput(raw);
  const prompt = POLICY_PROMPT.replace('{{POLICY_INPUT}}', input.promptSegment);

  for (const model of POLICY_MODELS) {
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
            { role: 'system', content: 'Ты Policy Guard Role. Верни строго JSON.' },
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

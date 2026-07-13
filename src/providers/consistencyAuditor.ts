import type { AnalysisSnapshot } from '../core/analysisSnapshot';
import type { ConsistencyAuditResult } from '../types';
import { ConsistencyAuditResultSchema, parseLlmJson } from '../core/llmSchemas';

const CONSISTENCY_AUDIT_MODELS = [
  'google/gemini-3.1-flash-lite',
  'openai/gpt-5-mini',
  'qwen/qwen3.7-plus',
];

const CONSISTENCY_AUDIT_PROMPT = `CardZip Consistency Auditor.

Роль: аудитор консистентности между canonical facts и пользовательскими артефактами.

Источник правды: analysisSnapshot.factSheet и analysisSnapshot.categoryPolicy.

Проверь:
- не превратились ли unknown/supplier_pending/conflict в утверждения факта;
- не появились ли в одном артефакте числа, которых нет в factSheet;
- нет ли расхождения между main report, buyer brief, cargo brief, SEO и supplier questions;
- нет ли логистики по размерам товара вместо упаковки.

Верни строго JSON:
{
  "decision": "PASS|FIX_REQUIRED|BLOCK",
  "summary": "...",
  "issues": ["..."],
  "requiredEdits": [
    {"artifact": "userCard|seoText|buyerBrief|cargoBrief|sampleChecklist|supplierQuestions|readme", "reason": "...", "instruction": "..."}
  ]
}

BLOCK используй только если артефакты массово противоречат canonical facts.

DATA:
{{AUDIT_INPUT}}
`;

function compactAuditPackage(snapshot: AnalysisSnapshot, artifacts: Record<string, unknown>): Record<string, unknown> {
  const s = snapshot as any;
  return {
    snapshot: {
      offerId: s.offerId,
      factSheet: s.factSheet,
      categoryPolicy: s.categoryPolicy,
      purchasePrice: s.purchasePrice,
      weight: s.weight,
      sku: s.sku,
      missingData: s.missingData,
      conflicts: s.conflicts,
    },
    artifacts,
  };
}

export async function runConsistencyAuditor(
  snapshot: AnalysisSnapshot,
  artifacts: Record<string, unknown>,
): Promise<ConsistencyAuditResult | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  const prompt = CONSISTENCY_AUDIT_PROMPT.replace(
    '{{AUDIT_INPUT}}',
    JSON.stringify(compactAuditPackage(snapshot, artifacts), null, 0).slice(0, 8000),
  );

  for (const model of CONSISTENCY_AUDIT_MODELS) {
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
            { role: 'system', content: 'Ты — consistency auditor CardZip. Верни строго JSON.' },
            { role: 'user', content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(32_000),
      });
      if (!res.ok) continue;
      const data = await res.json() as { choices?: { message?: { content?: string } }[] };
      const parsed = parseLlmJson(ConsistencyAuditResultSchema, data.choices?.[0]?.message?.content ?? '');
      if (parsed) {
        return {
          decision: parsed.decision,
          summary: parsed.summary ?? '',
          issues: parsed.issues ?? [],
          requiredEdits: parsed.requiredEdits ?? [],
        };
      }
    } catch {
      continue;
    }
  }

  return null;
}

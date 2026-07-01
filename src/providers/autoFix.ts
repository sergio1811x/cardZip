import type { AnalysisSnapshot, QaResult } from '../types';

const FIX_MODELS = [
  'google/gemini-2.5-flash-lite',
  'deepseek/deepseek-v4-flash',
  'stepfun/step-3.7-flash',
];

function cleanJson(raw: string): string {
  return raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
}

const AUTO_FIX_PROMPT = `CardZip 2.0 Auto-Fix.

Исправь только пользовательские тексты по QA. Не анализируй товар заново и не добавляй факты не из snapshot.

Что делать:
- убрать debug/raw/NaN/undefined/null/0 ¥/0 ₽/0 кг;
- убрать дубли и служебные слова “Product Intelligence”, “AI-черновик”;
- заменить claim как факт на “заявлено/проверить/подтвердить”;
- убрать ROI/маржу, если snapshot.economics.canShowRoi!=true;
- заменить “закупать партию” на “запросить данные / заказать образец”, если данные неполные;
- сохранить полезные факты, не стерилизовать документ.

Верни только JSON:
{
  "fixed": true,
  "summary": "что исправлено",
  "userCard": "...",
  "seoText": "...",
  "buyerBrief": "...",
  "supplierQuestions": "...",
  "remainingRisks": [],
  "needsSecondQa": false
}

DATA:
{{AUTO_FIX_PACKAGE}}
`;

export async function runAutoFix(
  snapshot: AnalysisSnapshot,
  artifacts: Record<string, unknown>,
  qaResult: QaResult,
): Promise<Record<string, unknown> | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  if (qaResult.decision === 'PASS' || qaResult.issues.length === 0) {
    return null; // nothing to fix
  }

  const input = JSON.stringify({
    artifacts,
    issues: qaResult.issues,
    requiredEdits: (qaResult as any).requiredEdits ?? [],
    snapshot: {
      purchasePrice: snapshot.purchasePrice,
      weight: snapshot.weight,
      market: snapshot.market,
      economics: snapshot.economics,
      riskFlags: snapshot.riskFlags,
    },
  }, null, 0).slice(0, 5000);

  const prompt = AUTO_FIX_PROMPT.replace('{{AUTO_FIX_PACKAGE}}', input);

  for (const model of FIX_MODELS) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          max_tokens: 1500,
          temperature: 0.0,
          messages: [
            { role: 'system', content: 'Ты — автокорректор CardZip. Верни СТРОГО JSON с исправленными полями.' },
            { role: 'user', content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) continue;
      const data = await res.json() as { choices?: { message?: { content?: string } }[] };
      const raw = data.choices?.[0]?.message?.content ?? '';
      const parsed = JSON.parse(cleanJson(raw));
      if (parsed && typeof parsed === 'object') {
        console.log(`[auto-fix] ${model} fixed ${Object.keys(parsed).length} field(s)`);
        return parsed as Record<string, unknown>;
      }
    } catch { continue; }
  }
  return null;
}

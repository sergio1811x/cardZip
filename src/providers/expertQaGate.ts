import type { AnalysisSnapshot, QaResult, GeneratedArtifacts } from '../types';

const QA_MODELS = [
  'google/gemini-2.5-flash-lite',
  'deepseek/deepseek-chat-v3.2',
  'google/gemini-2.5-flash',
];

function cleanJson(raw: string): string {
  return raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
}

const QA_GATE_PROMPT = `CardZip QA Gate v3 compact.

Проверь итоговые пользовательские материалы перед отправкой. Источник правды — snapshot. Не переписывай товар заново.

Решения:
- PASS: отчёт можно показать; мелкие стилистические замечания не блокируют.
- FIX_REQUIRED: есть исправимые ошибки в формулировках/claims/мусоре; дай точные requiredEdits.
- BLOCK: только если отчёт реально вводит в заблуждение и это нельзя безопасно исправить: ROI/маржа без разрешения snapshot, цена рынка при market.canUseForEconomics=false, позитивная закупка при неполных SKU/весе/рынке, критичное противоречие цены/веса/MOQ, raw/debug/0/NaN после code sanitizer.

Проверяй:
1. нет 0 ¥/0 ₽/0 кг/NaN/undefined/null/raw/debug;
2. ROI/маржа/цена продажи только если s.economics.canShowRoi=true;
3. broad category/WBCON/cross-border не выданы за direct market;
4. неподтверждённые claims сформулированы как “уточнить/подтвердить”, а не как факт;
5. supplier questions и buyer brief не спрашивают чужую категорию и не противоречат Product Intelligence;
6. есть clear next step.

Не блокируй отчёт из-за claims в отрицательном контексте (“не писать/нельзя/без подтверждения”) или из-за уже осторожных формулировок “заявлено/уточнить/подтвердить”.

Верни строго JSON:
{
  "decision":"PASS|FIX_REQUIRED|BLOCK",
  "canShowToUser":true,
  "qualityScore":0,
  "confidence":"low|medium|high",
  "summary":"коротко",
  "criticalIssues":[],
  "warnings":[],
  "requiredEdits":[{"artifact":"UserCard|SeoText|BuyerBrief|SupplierQuestions","operation":"replace|remove|rewrite","find":"...","replaceWith":"...","reason":"..."}],
  "safeUserSummary":{"status":"черновик|рабочая гипотеза|надёжный расчёт|отклонить","verdict":"...","mainRisk":"...","nextStep":"...","doNotDo":"..."}
}

DATA:
{{QA_REVIEW_PACKAGE}}
`;

function compactQaPackage(snapshot: AnalysisSnapshot, artifacts: Record<string, unknown>): Record<string, unknown> {
  const s = snapshot as any;
  return {
    snapshot: {
      offerId: s.offerId,
      productContext: s.productContext,
      supplier: s.supplier,
      purchasePrice: s.purchasePrice,
      weight: s.weight,
      sku: { ...s.sku, variants: s.sku?.variants?.slice?.(0, 8) ?? [] },
      market: {
        directAnalogsCount: s.market?.directAnalogsCount,
        similarAnalogsCount: s.market?.similarAnalogsCount,
        broadCategoryCount: s.market?.broadCategoryCount,
        crossBorderCount: s.market?.crossBorderCount,
        marketConfirmed: s.market?.marketConfirmed,
        canUseForEconomics: s.market?.canUseForEconomics,
        displayedMainPriceRub: s.market?.displayedMainPriceRub,
      },
      economics: s.economics,
      missingData: s.missingData,
      conflicts: s.conflicts,
      riskFlags: s.riskFlags,
    },
    artifacts,
  };
}

export async function runQaGate(
  snapshot: AnalysisSnapshot,
  artifacts: Record<string, unknown>,
): Promise<QaResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return { decision: 'BLOCK', qualityScore: 0, issues: ['QA unavailable: no API key'], criticalIssues: ['QA Gate недоступен — полный отчёт нельзя показывать'] } as any;
  }

  const input = JSON.stringify(compactQaPackage(snapshot, artifacts), null, 0).slice(0, 6500);
  const prompt = QA_GATE_PROMPT.replace('{{QA_REVIEW_PACKAGE}}', input);

  for (const model of QA_MODELS) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          max_tokens: 1400,
          temperature: 0.0,
          messages: [
            { role: 'system', content: 'Ты — QA-ревьюер CardZip. Верни СТРОГО JSON.' },
            { role: 'user', content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) {
        console.log(`[qa-gate] ${model} HTTP ${res.status}`);
        continue;
      }
      const data = await res.json() as { choices?: { message?: { content?: string } }[] };
      const raw = data.choices?.[0]?.message?.content ?? '';
      const parsed = JSON.parse(cleanJson(raw));
      if (parsed?.decision) {
        console.log(`[qa-gate] ${model} | ${parsed.decision} | score: ${parsed.qualityScore}/10 | issues: ${parsed.issues?.length ?? 0}`);
        return {
          decision: parsed.decision === 'BLOCK' ? 'BLOCK' : parsed.decision === 'FIX_REQUIRED' ? 'FIX_REQUIRED' : 'PASS',
          qualityScore: parsed.qualityScore ?? 5,
          issues: parsed.issues ?? [],
        };
      }
    } catch (err) {
      console.log(`[qa-gate] ${model} error: ${err instanceof Error ? err.message : err}`);
      continue;
    }
  }

  // if QA fails, fail closed. Full report must not bypass QA Gate.
  return { decision: 'BLOCK', qualityScore: 0, issues: ['QA fallback: all models failed'], criticalIssues: ['QA Gate не дал разрешение на показ полного отчёта'] } as any;
}

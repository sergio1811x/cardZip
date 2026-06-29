import type { AnalysisSnapshot, QaResult, GeneratedArtifacts } from '../types';

const QA_MODELS = [
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-chat-v3.2',
  'qwen/qwen3-235b-a22b',
];

function cleanJson(raw: string): string {
  return raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
}

const QA_GATE_PROMPT = `CardZip QA Gate — no-WB MVP.

Проверь материалы перед отправкой. Главная цель: в 95% успешных парсингов показывать полный полезный закупочный пакет. Отсутствие WB/Ozon, аналогов, медианы и автоматического ROI НЕ является причиной BLOCK.

PASS: отчёт полезен, нет опасной лжи, есть next step.
FIX_REQUIRED: исправимые claims/мусор/формулировки.
BLOCK: только если есть реальная опасность: 0 ¥/0 ₽/0 кг, NaN/undefined/null/debug после sanitizer, закупать партию при неполных данных, ROI как факт без ручной цены продажи/сценария, лечебный/сертифицированный/безопасный claim как факт.

Проверяй:
1. данные не стерилизованы до пустоты; есть товар, SKU, цена или причина отсутствия цены;
2. вопросы поставщику конкретные;
3. SEO и buyer brief насыщенные;
4. claims помечены как “заявлено/подтвердить/проверить”, если нет документов;
5. нет чужих категорийных чек-листов;
6. есть действия: поставщику, вес, ручная цена, конкуренты вручную, файлы.

Не блокируй:
- отсутствие WB;
- “ROI не считаю”;
- “рынок проверить вручную”;
- вопросы про сертификаты;
- медицинские сабо / обувь для медработников как тип товара.

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
  "safeUserSummary":{"status":"черновик|рабочая гипотеза|отклонить","verdict":"...","mainRisk":"...","nextStep":"...","doNotDo":"..."}
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
          ...parsed,
          decision: parsed.decision === 'BLOCK' ? 'BLOCK' : parsed.decision === 'FIX_REQUIRED' ? 'FIX_REQUIRED' : 'PASS',
          canShowToUser: parsed.canShowToUser !== false,
          qualityScore: parsed.qualityScore ?? 5,
          confidence: parsed.confidence ?? 'medium',
          summary: parsed.summary ?? '',
          issues: parsed.issues ?? parsed.warnings ?? [],
          criticalIssues: parsed.criticalIssues ?? [],
          requiredEdits: parsed.requiredEdits ?? [],
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

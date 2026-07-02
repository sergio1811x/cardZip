import type { AnalysisSnapshot, QaResult, GeneratedArtifacts } from '../types';

const QA_MODELS = [
  'deepseek/deepseek-v4-pro',
  'qwen/qwen3.7-plus',
  'minimax/minimax-m2.7',
];

function cleanJson(raw: string): string {
  return raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
}

const QA_GATE_PROMPT = `CardZip 2.0 QA Gate.

Цель: пропускать полезный закупочный пакет, а не блокировать из-за отсутствия WB/ROI. BLOCK — только при реальной опасности для пользователя.

Решения:
PASS — можно показывать.
FIX_REQUIRED — есть исправимые формулировки/мусор.
BLOCK — только если после repair нельзя безопасно показать.

Проверка:
1. Main короткий, без дублей и debug.
2. Есть товар, цена/SKU или честная причина отсутствия.
3. SEO похож на черновик карточки, не на техвыгрузку.
4. Buyer/cargo/risk/sample документы пригодны человеку.
5. Claims не выданы как факт без “заявлено/проверить/подтвердить”.
6. Нет чужой категории: обуви не нужны мощность/аккумулятор/рукав; пассивной ловушке — лампа/220V; USB-товару — стелька/рукав.
7. Нет 0 ¥/0 ₽/0 кг/NaN/undefined/null/raw SKU.
8. Нет обещаний прибыли или рыночной доходности.

Не блокируй: отсутствие WB, “рынок проверить вручную”, вопросы про сертификаты, “медицинские сабо” как тип товара.

Верни только JSON:
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
          max_tokens: 1200,
          temperature: 0.0,
          messages: [
            { role: 'system', content: 'Ты — QA-ревьюер CardZip. Верни СТРОГО JSON.' },
            { role: 'user', content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(60_000),
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

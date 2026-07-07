import type { AnalysisSnapshot } from '../core/analysisSnapshot';
import type { QaResult, GeneratedArtifacts } from '../types';
import { QaGateResultSchema, parseLlmJson } from '../core/llmSchemas';

const QA_MODELS = [
  'stepfun/step-3.7-flash',
  'google/gemini-2.5-flash',
  'deepseek/deepseek-v4-flash',
];

const QA_GATE_PROMPT = `CardZip QA Gate.

Роль: контроль качества закупочного пакета. Проверяй пользовательские тексты, но не анализируй товар заново.

Цель: пропускать полезный закупочный пакет, если его можно безопасно показать. Не блокируй из-за отсутствия веса, сертификатов, полного ответа поставщика или неподтверждённых свойств.

Решения:
- PASS: можно показывать пользователю.
- FIX_REQUIRED: есть мусор, дубли, опасные формулировки или слабый текст, но это можно исправить.
- BLOCK: только если после repair пакет нельзя безопасно показать.

BLOCK разрешён только если:
- товар не определён вообще и нет честного fallback;
- текст содержит опасную медицинскую/детскую/сертификационную гарантию как факт;
- есть вредный или юридически опасный совет;
- в тексте массово raw/debug/NaN/undefined/null и repair не сможет восстановить смысл;
- документы относятся к явно чужой категории и могут ввести пользователя в заблуждение.

Проверь:
1. Main report короткий, понятный, без debug и дублей.
2. Есть товар, цена/SKU или честная причина отсутствия.
3. Поставщик не показан как seller/factory/merchant, только по-русски.
4. Вес без данных = “не указан”.
5. SEO похож на черновик карточки товара, а не на техвыгрузку.
6. SEO title не содержит “черновик”, “1688”, “заявлено”, “подтвердить”.
7. SEO bullets: ровно 5, без дублей.
8. Buyer/cargo/sample документы пригодны человеку.
9. Supplier questions без дублей, максимум 10 вопросов.
10. Claims не выданы как факт без “заявлено/проверить/подтвердить”.
11. Нет чужой категории: одежде не нужны подошва/вилка/напряжение; обуви не нужны мощность/аккумулятор/рукав; зонту не нужна стелька; кухонному стеллажу не нужны мощность/UPF/аккумулятор.
12. Нет “из карточки 1688”, cross-border, для cross-border торговли, raw SKU, 0 ¥, 0 ₽, 0 кг, NaN, undefined, null, file://.
13. Нет советов “точно брать партию”.
14. Нет латиницы внутри русских слов: поставщpику, матеpиал.
15. CN-блок либо валидный, либо скрыт.

Верни строго JSON без markdown:
{
  "decision": "PASS|FIX_REQUIRED|BLOCK",
  "canShowToUser": true,
  "qualityScore": 0,
  "confidence": "low|medium|high",
  "summary": "коротко",
  "criticalIssues": [],
  "warnings": [],
  "requiredEdits": [
    {"artifact":"UserCard|SeoText|BuyerBrief|CargoBrief|SampleChecklist|SupplierQuestions|Readme","operation":"replace|remove|rewrite","find":"...","replaceWith":"...","reason":"..."}
  ],
  "safeUserSummary": {"status":"готово|требует правки|рабочая гипотеза|нельзя показать","verdict":"...","mainRisk":"...","nextStep":"...","doNotDo":"..."}
}

Правила ответа:
- qualityScore: 0-100.
- Если decision=PASS, requiredEdits должен быть [].
- Если decision=FIX_REQUIRED, canShowToUser обычно true после repair.
- Если decision=BLOCK, canShowToUser=false и criticalIssues должен объяснять реальную опасность.
- Лучше FIX_REQUIRED, чем BLOCK, если текст можно безопасно поправить.

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
      factSheet: s.factSheet,
      categoryPolicy: s.categoryPolicy,
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
          max_tokens: 1500,
          temperature: 0.0,
          messages: [
            { role: 'system', content: 'Ты — QA-ревьюер CardZip. Верни СТРОГО JSON.' },
            { role: 'user', content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(32_000),
      });
      if (!res.ok) {
        console.log(`[qa-gate] ${model} HTTP ${res.status}`);
        continue;
      }
      const data = await res.json() as { choices?: { message?: { content?: string } }[] };
      const raw = data.choices?.[0]?.message?.content ?? '';
      const parsed = parseLlmJson(QaGateResultSchema, raw);
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

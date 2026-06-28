import type { AnalysisSnapshot, QaResult } from '../types';
import { runHardValidator, type HardValidatorResult } from '../core/reportValidator';

const QA_MODELS = [
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-chat-v3.2',
  'qwen/qwen3-235b-a22b',
];

function cleanJson(raw: string): string {
  return raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
}

const QA_GATE_PROMPT = `# CardZip Expert QA Gate Prompt v2

Ты — экспертный контролёр качества CardZip: профессиональный байер из Китая, селлер Wildberries/Ozon, товарный аналитик и редактор пользовательских отчётов.

Твоя задача — проверить финальный результат анализа товара перед показом пользователю.

Ты не должен продавать товар, украшать отчёт или делать вид, что данные точнее, чем они есть. Твоя задача — не пропустить пользователю плохой, противоречивый, опасный или вводящий в заблуждение результат.

---

# 1. Что ты проверяешь

Тебе передаются:

1. AnalysisSnapshot — источник правды.
2. UserCard — основное сообщение пользователю.
3. ExpertReport — экспертный отчёт.
4. WbMaterials — материалы для WB/Ozon.
5. BuyerBrief — ТЗ байеру/карго.
6. SupplierMessage — сообщение поставщику.
7. LastMessage — вывод /last.
8. MarketData — результаты WB/Ozon.
9. EconomicsResult — экономика, рассчитанная кодом.
10. ProductContext — понимание товара.
11. PhotoVision — вывод по фото.

Проверяй все блоки между собой.

---

# 2. Главный принцип

AnalysisSnapshot — главный источник правды.

Если UserCard, ExpertReport, WbMaterials, BuyerBrief, SupplierMessage или LastMessage противоречат AnalysisSnapshot, это ошибка.

Если AnalysisSnapshot сам содержит противоречия, отметь это как критичную проблему и не разрешай уверенный вывод.

---

# 3. Нельзя пропускать пользователю

Нельзя пропускать отчёт, если есть:

* \`0 ¥\` как цена;
* \`0 кг\` как вес;
* \`NaN\`;
* \`undefined\`;
* \`null\`;
* длинные неокруглённые float-значения;
* цена, вес, MOQ или WB-метрика противоречат между блоками;
* ROI или маржа считаются без подтверждённой рыночной цены;
* широкая категория используется как доказательство рынка;
* cross-border используется для экономики локального WB/Ozon;
* неподтверждённые claims;
* “можно закупать” при неподтверждённых SKU, весе с упаковкой, цене партии или рынке;
* raw debug-output;
* raw китайские атрибуты в UserCard без перевода;
* вопросы поставщику спрашивают очевидно лишнее;
* вопросы поставщику пропускают критичное;
* SEO вводит покупателя в заблуждение;
* verdict не содержит конкретный следующий шаг.

---

# 4. Проверка экономики

Экономика должна быть помечена как:

* confirmed — только если подтверждены SKU, цена партии, вес с упаковкой, логистика и рыночная цена;
* preliminary — если есть цена, но данные неполные;
* partial — если можно показать только часть расчёта;
* not_calculated — если нет даже базовой цены.

Если экономика preliminary или partial, в пользовательском тексте должен быть дисклеймер:

“Расчёт предварительный. Финальная экономика зависит от подтверждения SKU, веса с упаковкой, логистики и рыночной цены.”

Если direct analogs = 0, ROI и маржу показывать нельзя.

---

# 5. Проверка рынка

Разделяй:

* direct analogs;
* similar / functional analogs;
* broad category;
* cross-border.

Правила:

1. Direct analogs можно использовать для market price.
2. Similar analogs можно использовать только как ориентир, не как точную цену.
3. Broad category нельзя использовать как рыночную цену.
4. Cross-border нельзя использовать для экономики локального рынка.
5. Если direct=0, в отчёте должно быть: “рынок не подтверждён”.

---

# 6. Проверка решения

Не разрешай:

* “можно тестировать”;
* “можно брать”;
* “можно закупать 20–50 шт”;

если не подтверждены:

* выбранный SKU;
* цена SKU или партии;
* вес с упаковкой;
* прямые аналоги или рыночная цена;
* критичные характеристики.

В таких случаях допустимые решения:

* проверить дальше;
* запросить данные;
* заказать образец;
* не брать;
* недостаточно данных.

---

# 7. Проверка WB/Ozon материалов

Проверь:

* название не обещает лишнего;
* описание не содержит неподтверждённых claims;
* буллеты соответствуют фактам;
* характеристики не содержат ошибочного маппинга;
* ключевые слова релевантны товару;
* нет риска модерации;
* если есть “водонепроницаемый”, должен быть подтверждён IP-рейтинг;
* если товар с батарейками/электроникой, должны быть вопросы о комплектации и сертификации.

---

# 8. Проверка вопросов поставщику

Вопросы должны быть конкретными.

Если данных нет, должны быть вопросы про:

* цену выбранного SKU;
* цену партии 20 / 50 / 100 шт;
* вес с упаковкой;
* размер упаковки;
* комплектацию;
* батарейки;
* сертификаты/маркировку, если применимо;
* срок производства;
* условия брака;
* фото/видео перед отправкой;
* возможность образца.

Не надо спрашивать то, что уже подтверждено.

---

# 9. Верни строго JSON

Формат:

{
"decision": "PASS | FIX_REQUIRED | BLOCK",
"canShowToUser": true,
"qualityScore": 0,
"confidence": "low | medium | high",
"summary": "короткое объяснение решения",
"criticalIssues": [
{
"type": "contradiction | unsafe_claim | economics_error | market_error | formatting_error | missing_next_step | seo_error | supplier_question_error | raw_debug | other",
"severity": "high | medium | low",
"where": "UserCard | ExpertReport | WbMaterials | BuyerBrief | SupplierMessage | LastMessage | Snapshot | Multiple",
"problem": "что не так",
"evidence": "короткая цитата или описание",
"fix": "как исправить"
}
],
"warnings": [
{
"type": "weak_data | weak_market | preliminary_economics | missing_supplier_data | other",
"where": "где найдено",
"problem": "что может быть слабым",
"fix": "что улучшить"
}
],
"requiredEdits": [
{
"target": "UserCard | ExpertReport | WbMaterials | BuyerBrief | SupplierMessage | LastMessage",
"operation": "replace | remove | add | rewrite",
"find": "что заменить или удалить",
"replaceWith": "на что заменить",
"reason": "почему"
}
],
"safeUserSummary": {
"status": "черновик | рабочая гипотеза | надёжный расчёт | отклонить",
"verdict": "короткий безопасный вердикт",
"mainRisk": "главный риск",
"nextStep": "одно конкретное действие",
"doNotDo": "что нельзя делать сейчас"
}
}

---

# 10. Критерии решения

PASS:

* нет критичных ошибок;
* нет противоречий в цене/весе/MOQ/WB-метриках;
* экономика честно помечена;
* рынок честно помечен;
* verdict содержит следующий шаг;
* нет raw debug, NaN, undefined, null, 0 ¥, 0 кг.

FIX_REQUIRED:

* есть исправимые ошибки;
* отчёт можно показать после правок;
* нет опасных утверждений, которые полностью ломают вывод.

BLOCK:

* отчёт вводит пользователя в заблуждение;
* есть критичные противоречия;
* экономика или рынок представлены как точные без оснований;
* есть опасные неподтверждённые claims;
* пользователь может принять плохое закупочное решение из-за отчёта.

---

# Вход

Проверь данные ниже.

DATA:

{{QA_REVIEW_PACKAGE}}
`;


type QaDecision = 'PASS' | 'FIX_REQUIRED' | 'BLOCK';

type QaInputArtifacts = Record<string, unknown>;

type QaGateFullResult = {
  decision: QaDecision;
  canShowToUser: boolean;
  qualityScore: number;
  confidence: 'low' | 'medium' | 'high';
  summary: string;
  criticalIssues: string[];
  warnings: string[];
  requiredEdits: string[];
  issues: string[];
  safeUserSummary: {
    status: 'черновик' | 'рабочая гипотеза' | 'надёжный расчёт' | 'отклонить';
    verdict: string;
    mainRisk: string;
    nextStep: string;
    doNotDo: string;
  };
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asStringArray(value: unknown, limit = 30): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, limit);
}

function cleanQaDecision(value: unknown): QaDecision {
  return value === 'BLOCK' ? 'BLOCK' : value === 'FIX_REQUIRED' ? 'FIX_REQUIRED' : 'PASS';
}

function fallbackSafeSummary(snapshot: AnalysisSnapshot, hardValidation?: HardValidatorResult): QaGateFullResult['safeUserSummary'] {
  if (hardValidation?.safeUserSummary) return hardValidation.safeUserSummary;

  const s = asRecord(snapshot);
  const pc = asRecord(s.productContext);
  const titles = asRecord(pc.titles);
  const identity = asRecord(pc.identity);
  const name = String(titles.shortRu || titles.cleanRu || identity.productType || 'товар');

  return {
    status: 'черновик',
    verdict: `${name}: данных недостаточно для безопасного финального решения.`,
    mainRisk: 'QA Gate не смог подтвердить качество отчёта.',
    nextStep: 'Проверить SKU, цену партии, вес с упаковкой и прямые аналоги вручную.',
    doNotDo: 'Не закупать партию и не считать ROI до подтверждения ключевых данных.',
  };
}

function normalizeQaResult(raw: unknown, snapshot: AnalysisSnapshot, hardValidation?: HardValidatorResult): QaGateFullResult {
  const obj = asRecord(raw);
  const criticalIssues = [
    ...asStringArray(obj.criticalIssues),
    ...asStringArray(obj.issues).filter((issue) => /critical|критич|block|нельзя|roi|0\s*[¥₽]|0\s*кг/i.test(issue)),
  ];
  const warnings = asStringArray(obj.warnings);
  const requiredEdits = asStringArray(obj.requiredEdits);
  const allIssues = [
    ...asStringArray(obj.issues),
    ...criticalIssues,
    ...warnings,
    ...requiredEdits,
  ].filter((value, index, arr) => arr.indexOf(value) === index);

  let decision = cleanQaDecision(obj.decision);

  if (hardValidation?.block) decision = 'BLOCK';
  else if (hardValidation && !hardValidation.canShowFullReport && decision === 'PASS') decision = 'FIX_REQUIRED';
  else if (criticalIssues.length && decision === 'PASS') decision = 'FIX_REQUIRED';

  const scoreRaw = Number(obj.qualityScore);
  const qualityScore = Number.isFinite(scoreRaw) ? Math.max(1, Math.min(10, Math.round(scoreRaw))) : (decision === 'PASS' ? 7 : decision === 'FIX_REQUIRED' ? 5 : 2);
  const confidence = obj.confidence === 'high' || obj.confidence === 'medium' || obj.confidence === 'low'
    ? obj.confidence
    : qualityScore >= 8 ? 'high' : qualityScore >= 5 ? 'medium' : 'low';

  return {
    decision,
    canShowToUser: decision !== 'BLOCK',
    qualityScore,
    confidence,
    summary: String(obj.summary || (decision === 'PASS' ? 'QA пройден.' : decision === 'FIX_REQUIRED' ? 'Нужны правки перед показом.' : 'Полный отчёт заблокирован.')),
    criticalIssues,
    warnings,
    requiredEdits,
    issues: allIssues,
    safeUserSummary: asRecord(obj.safeUserSummary).status
      ? obj.safeUserSummary as QaGateFullResult['safeUserSummary']
      : fallbackSafeSummary(snapshot, hardValidation),
  };
}

function buildLocalQaResult(snapshot: AnalysisSnapshot, hardValidation: HardValidatorResult, reason: string): QaGateFullResult {
  const decision: QaDecision = hardValidation.block ? 'BLOCK' : hardValidation.canShowFullReport ? 'PASS' : 'FIX_REQUIRED';
  const criticalIssues = hardValidation.issues
    .filter((issue: { severity: string }) => issue.severity === 'critical' || issue.severity === 'high')
    .map((issue: { field: string; problem: string }) => `${issue.field}: ${issue.problem}`);
  const warnings = [
    ...hardValidation.issues.filter((issue: { severity: string }) => issue.severity === 'medium' || issue.severity === 'low').map((issue: { field: string; problem: string }) => `${issue.field}: ${issue.problem}`),
    ...hardValidation.warnings.map((issue: { field: string; problem: string }) => `${issue.field}: ${issue.problem}`),
  ];
  const requiredEdits = hardValidation.issues.map((issue: { action: string }) => issue.action);

  return {
    decision,
    canShowToUser: decision !== 'BLOCK',
    qualityScore: decision === 'PASS' ? 7 : decision === 'FIX_REQUIRED' ? 5 : 2,
    confidence: decision === 'PASS' ? 'medium' : 'high',
    summary: reason,
    criticalIssues,
    warnings,
    requiredEdits,
    issues: [...criticalIssues, ...warnings],
    safeUserSummary: fallbackSafeSummary(snapshot, hardValidation),
  };
}

export async function runQaGate(
  snapshot: AnalysisSnapshot,
  artifacts: QaInputArtifacts,
  hardValidatorResult?: HardValidatorResult,
): Promise<QaResult> {
  const hardValidation = hardValidatorResult ?? runHardValidator({ analysisSnapshot: snapshot, artifacts });

  if (hardValidation.block) {
    return buildLocalQaResult(snapshot, hardValidation, 'Hard Validator заблокировал полный отчёт до LLM QA.') as unknown as QaResult;
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return buildLocalQaResult(snapshot, hardValidation, 'QA Gate выполнен в локальном режиме: OPENROUTER_API_KEY не задан.') as unknown as QaResult;
  }

  const input = JSON.stringify({
    analysisSnapshot: snapshot,
    generatedArtifacts: artifacts,
    hardValidatorResult: hardValidation,
  }, null, 0).slice(0, 9000);
  const prompt = QA_GATE_PROMPT + '\n\nDATA:\n' + input;

  for (const model of QA_MODELS) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          max_tokens: 2200,
          temperature: 0.1,
          messages: [
            { role: 'system', content: 'Ты — QA-ревьюер CardZip. Верни СТРОГО JSON.' },
            { role: 'user', content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(18_000),
      });
      if (!res.ok) {
        console.log(`[qa-gate] ${model} HTTP ${res.status}`);
        continue;
      }
      const data = await res.json() as { choices?: { message?: { content?: string } }[] };
      const raw = data.choices?.[0]?.message?.content ?? '';
      const parsed = JSON.parse(cleanJson(raw));
      const qa = normalizeQaResult(parsed, snapshot, hardValidation);
      console.log(`[qa-gate] ${model} | ${qa.decision} | score: ${qa.qualityScore}/10 | issues: ${qa.issues.length}`);
      return qa as unknown as QaResult;
    } catch (err) {
      console.log(`[qa-gate] ${model} error: ${err instanceof Error ? err.message : err}`);
      continue;
    }
  }

  return buildLocalQaResult(snapshot, hardValidation, 'QA fallback: все LLM-модели QA Gate не ответили валидно.') as unknown as QaResult;
}

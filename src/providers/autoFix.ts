import type { AnalysisSnapshot, QaResult } from '../types';
import { runHardValidator } from '../core/reportValidator';

const FIX_MODELS = [
  'google/gemini-2.5-flash-lite',
  'zhipu-ai/glm-4.5-air',
  'qwen/qwen3-235b-a22b',
];

function cleanJson(raw: string): string {
  return raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
}

const AUTO_FIX_PROMPT = `# CardZip Auto-Fix Prompt v1

Ты — редактор и корректировщик CardZip.

Твоя задача — исправить пользовательские материалы по результатам Expert QA Gate.

Ты не должен заново анализировать товар. Ты должен применить только те правки, которые указаны в QA result, и сохранить смысл AnalysisSnapshot.

---

# 1. Вход

Тебе передаются:

1. AnalysisSnapshot — источник правды.
2. GeneratedArtifacts — текущие тексты:

   * UserCard
   * ExpertReport
   * WbMaterials
   * BuyerBrief
   * SupplierMessage
   * LastMessage
3. QaResult — результат проверки:

   * decision
   * criticalIssues
   * warnings
   * requiredEdits
   * safeUserSummary

---

# 2. Главные правила

1. AnalysisSnapshot — источник правды.
2. Не придумывай новые данные.
3. Не добавляй неподтверждённые свойства.
4. Не меняй числа, если они не указаны в AnalysisSnapshot или requiredEdits.
5. Не считай экономику.
6. Не считай ROI.
7. Не меняй структуру без необходимости.
8. Исправляй только проблемные места.
9. Если правка невозможна без новых данных, замени уверенную формулировку на осторожную.
10. Пользовательский текст должен стать безопасным, понятным и непротиворечивым.

---

# 3. Что исправлять обязательно

Обязательно удалить или заменить:

* \`0 ¥\`;
* \`0 кг\`;
* \`NaN\`;
* \`undefined\`;
* \`null\`;
* длинные float-значения;
* raw debug-output;
* неподтверждённые claims;
* противоречивые MOQ/цены/вес/WB-метрики;
* ROI/маржу без подтверждённого рынка;
* “можно закупать”, если данные неполные;
* raw китайские атрибуты в пользовательской карточке без перевода.

---

# 4. Как исправлять

Примеры:

Если цена отсутствует:

* не писать \`0 ¥\`;
* писать \`цена уточняется\` или \`—\`.

Если вес отсутствует:

* не писать \`0 кг\`;
* писать \`вес уточняется\` или \`—\`.

Если рынок не подтверждён:

* не писать “рыночная цена”;
* писать “прямые аналоги не подтверждены”;
* ROI и маржу не выводить.

Если экономика предварительная:

* писать “предварительно”;
* добавить дисклеймер.

Если SKU не выбран:

* писать “финальная цена зависит от выбранного SKU”.

Если есть broad category:

* писать “широкая категория не используется для экономики”.

Если есть cross-border:

* писать “cross-border не используется для экономики локального WB”.

---

# 5. Верни исправленные материалы

Верни строго JSON:

{
"fixed": true,
"summary": "что исправлено",
"artifacts": {
"UserCard": "...",
"ExpertReport": "...",
"WbMaterials": "...",
"BuyerBrief": "...",
"SupplierMessage": "...",
"LastMessage": "..."
},
"remainingRisks": [
"..."
],
"needsSecondQa": true
}

---

# Вход

Исправь материалы ниже.

DATA:

{{AUTO_FIX_PACKAGE}}
`;


type AutoFixResult = {
  fixed: boolean;
  summary: string;
  artifacts: Record<string, unknown>;
  remainingRisks: string[];
  needsSecondQa: boolean;
};

const GARBAGE_RE = /\b(?:NaN|undefined|null)\b/gi;
const ROI_LINE_RE = /\b(?:ROI|марж[аиу]|прибыль|рентабельность)\b[^\n\r]*(?:\d|%|₽)/i;
const POSITIVE_BUY_RE = /\b(?:можно\s+(?:закупать|брать|тестировать)|заказать\s+тест\s*\d|закупка\s+целесообразна)\b/gi;
const PUBLIC_CHINESE_RE = /[\u3400-\u9FFF]/;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(',', '.').replace(/[^\d.-]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function collectIssues(qaResult: QaResult): string[] {
  const obj = qaResult as unknown as Record<string, unknown>;
  return [
    ...asArray(obj.issues),
    ...asArray(obj.criticalIssues),
    ...asArray(obj.warnings),
    ...asArray(obj.requiredEdits),
  ].map((issue) => String(issue ?? '').trim()).filter(Boolean);
}

function cleanPublicText(text: string, snapshot: AnalysisSnapshot): string {
  const market = asRecord((snapshot as unknown as Record<string, unknown>).market);
  const economics = asRecord((snapshot as unknown as Record<string, unknown>).economics);
  const directAnalogsCount = asNumber(market.directAnalogsCount) ?? 0;
  const marketConfirmed = Boolean(market.marketConfirmed);
  const canShowRoi = Boolean(economics.canShowRoi) && directAnalogsCount > 0 && marketConfirmed;

  let fixed = text
    .replace(GARBAGE_RE, '—')
    .replace(/\b0(?:[,.]0+)?\s*[¥￥]/gi, 'цена уточняется')
    .replace(/\b0(?:[,.]0+)?\s*₽/gi, 'цена уточняется')
    .replace(/\b0(?:[,.]0+)?\s*(?:кг|kg)\b/gi, 'вес уточняется')
    .replace(/\d+([,.]\d{4,})/g, (match) => {
      const parsed = Number(match.replace(',', '.'));
      return Number.isFinite(parsed) ? String(Math.round(parsed * 100) / 100).replace('.', ',') : '—';
    })
    .replace(/^.*(?:debug|quote_type|rawPriceFields|extraInfoKeys|object Object).*$/gim, '')
    .replace(POSITIVE_BUY_RE, 'проверять дальше');

  if (!canShowRoi) {
    fixed = fixed
      .split('\n')
      .filter((line) => !ROI_LINE_RE.test(line))
      .join('\n');
  }

  fixed = fixed
    .replace(/\bрыночная\s+цена\s*[:—-]?\s*\d[^\n]*/gi, marketConfirmed ? '$&' : 'рыночная цена не подтверждена')
    .replace(/\bможно\s+считать\s+ROI\b/gi, canShowRoi ? 'можно считать ROI' : 'ROI считать нельзя')
    .replace(/\bможно\s+считать\s+марж[уи]\b/gi, canShowRoi ? 'можно считать маржу' : 'маржу считать нельзя');

  if (PUBLIC_CHINESE_RE.test(fixed)) {
    fixed = fixed
      .split('\n')
      .filter((line) => !PUBLIC_CHINESE_RE.test(line))
      .join('\n');
  }

  return fixed.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function deterministicSanitize(value: unknown, snapshot: AnalysisSnapshot): unknown {
  if (typeof value === 'string') return cleanPublicText(value, snapshot);
  if (Array.isArray(value)) return value.map((item) => deterministicSanitize(item, snapshot)).filter((item) => item !== '' && item !== null && item !== undefined);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const cleanKey = cleanPublicText(key, snapshot);
      if (!cleanKey) continue;
      const cleanValue = deterministicSanitize(child, snapshot);
      if (cleanValue === '' || cleanValue === null || cleanValue === undefined) continue;
      out[cleanKey] = cleanValue;
    }
    return out;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
  return value;
}

function buildDeterministicFix(snapshot: AnalysisSnapshot, artifacts: Record<string, unknown>, qaResult: QaResult, summary: string): AutoFixResult {
  const fixedArtifacts = deterministicSanitize(artifacts, snapshot) as Record<string, unknown>;
  const hardValidation = runHardValidator({ analysisSnapshot: snapshot, artifacts: fixedArtifacts });
  const issues = collectIssues(qaResult);
  const hasHighSeverity = issues.some((issue) => /critical|high|критич|0\s*[¥₽]|0\s*кг|roi|закуп|рын/i.test(issue));

  return {
    fixed: true,
    summary,
    artifacts: fixedArtifacts,
    remainingRisks: [
      ...hardValidation.issues.map((issue: { field: string; problem: string }) => `${issue.field}: ${issue.problem}`),
      ...hardValidation.warnings.map((issue: { field: string; problem: string }) => `${issue.field}: ${issue.problem}`),
    ].slice(0, 30),
    needsSecondQa: hasHighSeverity || hardValidation.issues.some((issue: { severity: string }) => issue.severity === 'critical' || issue.severity === 'high'),
  };
}

function safeJsonParse(raw: string): Record<string, unknown> | null {
  const cleaned = cleanJson(raw);
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  const candidate = first >= 0 && last > first ? cleaned.slice(first, last + 1) : cleaned;
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function normalizeAutoFixResult(parsed: Record<string, unknown>, snapshot: AnalysisSnapshot, fallbackArtifacts: Record<string, unknown>, qaResult: QaResult): AutoFixResult {
  const rawArtifacts = asRecord(parsed.artifacts);
  const artifacts = Object.keys(rawArtifacts).length ? rawArtifacts : fallbackArtifacts;
  const fixedArtifacts = deterministicSanitize(artifacts, snapshot) as Record<string, unknown>;
  const hardValidation = runHardValidator({ analysisSnapshot: snapshot, artifacts: fixedArtifacts });
  const issues = collectIssues(qaResult);

  return {
    fixed: parsed.fixed !== false,
    summary: String(parsed.summary || 'Материалы исправлены и дополнительно очищены deterministic sanitizer.'),
    artifacts: fixedArtifacts,
    remainingRisks: [
      ...asArray(parsed.remainingRisks).map((risk) => String(risk ?? '').trim()).filter(Boolean),
      ...hardValidation.issues.map((issue: { field: string; problem: string }) => `${issue.field}: ${issue.problem}`),
      ...hardValidation.warnings.map((issue: { field: string; problem: string }) => `${issue.field}: ${issue.problem}`),
    ].filter((value, index, arr) => value && arr.indexOf(value) === index).slice(0, 30),
    needsSecondQa: Boolean(parsed.needsSecondQa) || issues.some((issue: string) => /critical|high|критич|0\s*[¥₽]|0\s*кг|roi|закуп|рын/i.test(issue)),
  };
}

export async function runAutoFix(
  snapshot: AnalysisSnapshot,
  artifacts: Record<string, unknown>,
  qaResult: QaResult,
): Promise<Record<string, unknown> | null> {
  if (qaResult.decision !== 'FIX_REQUIRED') {
    return null;
  }

  const issues = collectIssues(qaResult);
  if (issues.length === 0) {
    return buildDeterministicFix(snapshot, artifacts, qaResult, 'QA не передал список правок, применена безопасная deterministic-очистка.');
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return buildDeterministicFix(snapshot, artifacts, qaResult, 'OPENROUTER_API_KEY не задан, применена deterministic-очистка без LLM.');
  }

  const input = JSON.stringify({
    analysisSnapshot: snapshot,
    generatedArtifacts: artifacts,
    qaResult,
    issues,
    hardValidatorBeforeFix: runHardValidator({ analysisSnapshot: snapshot, artifacts }),
  }, null, 0).slice(0, 8500);

  const prompt = AUTO_FIX_PROMPT + '\n\nDATA:\n' + input;

  for (const model of FIX_MODELS) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          max_tokens: 3200,
          temperature: 0.1,
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
      const parsed = safeJsonParse(raw);
      if (parsed) {
        const normalized = normalizeAutoFixResult(parsed, snapshot, artifacts, qaResult);
        console.log(`[auto-fix] ${model} fixed ${Object.keys(normalized.artifacts).length} artifact field(s)`);
        return normalized as Record<string, unknown>;
      }
    } catch { continue; }
  }

  return buildDeterministicFix(snapshot, artifacts, qaResult, 'LLM Auto-Fix не вернул валидный JSON, применена deterministic-очистка.');
}

import type { AnalysisSnapshot, QaResult } from '../types';

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
    snapshot: {
      purchasePrice: snapshot.purchasePrice,
      weight: snapshot.weight,
      market: snapshot.market,
      economics: snapshot.economics,
      riskFlags: snapshot.riskFlags,
    },
  }, null, 0).slice(0, 6000);

  const prompt = AUTO_FIX_PROMPT + '\n\nDATA:\n' + input;

  for (const model of FIX_MODELS) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          max_tokens: 3000,
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
      const parsed = JSON.parse(cleanJson(raw));
      if (parsed && typeof parsed === 'object') {
        console.log(`[auto-fix] ${model} fixed ${Object.keys(parsed).length} field(s)`);
        return parsed as Record<string, unknown>;
      }
    } catch { continue; }
  }
  return null;
}

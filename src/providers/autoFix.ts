import type { AnalysisSnapshot, QaResult } from '../types';

const FIX_MODELS = [
  'google/gemini-2.5-flash-lite',
  'zhipu-ai/glm-4.5-air',
  'qwen/qwen3-235b-a22b',
];

function cleanJson(raw: string): string {
  return raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
}

const AUTO_FIX_PROMPT = `Ты — автокорректор CardZip. Исправь артефакты по списку ошибок от QA.

## ПРАВИЛА:
1. Применяй ТОЛЬКО исправления из списка issues/requiredEdits. Не добавляй новую информацию.
2. Замены: 0¥ → "уточняется", 0kg → "—", NaN → "—", undefined → "—", null → "—".
3. Удаляй неподтверждённые утверждения (сертификаты, гарантии прибыли, объёмы продаж).
4. Убирай китайские raw-коды (颜色分类:, 尺码:) — замени на русские аналоги если понятно, иначе удали.
5. Если ROI нельзя показывать — убери строки с ROI/маржой из userCard.
6. НЕ придумывай данные. Если не знаешь значение — ставь "уточняется" или удали строку.
7. Сохраняй структуру и форматирование исходных артефактов.

Верни JSON с исправлёнными полями (только те, что изменились):
{
  "userCard": "исправленный HTML если менялся",
  "seoTitle": "исправленный если менялся",
  ...
}
Возвращай ТОЛЬКО изменённые поля.`;

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

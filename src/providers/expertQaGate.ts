import type { AnalysisSnapshot, QaResult, GeneratedArtifacts } from '../types';

const QA_MODELS = [
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-chat-v3.2',
  'qwen/qwen3-235b-a22b',
];

function cleanJson(raw: string): string {
  return raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
}

const QA_GATE_PROMPT = `Ты — QA-ревьюер CardZip. Проверь сгенерированные артефакты на ошибки и несоответствия.

## ВХОДНЫЕ ДАННЫЕ:
1. AnalysisSnapshot — исходные данные анализа
2. Артефакты — сгенерированный контент (userCard, SEO, buyerBrief и т.д.)

## КРИТИЧЕСКИЕ ПРОВЕРКИ (→ BLOCK если найдены):
- 0¥, 0₽, 0kg, NaN, undefined, null в пользовательском тексте
- "можно закупать" / "рекомендуем закупку" без подтверждённых SKU+цена+вес+рынок
- ROI/маржа показаны при economics.canShowRoi=false или market.confirmedCount=0
- Гарантии прибыли или продаж
- Придуманные сертификаты, ГОСТы, объёмы продаж (нет в snapshot)

## СЕРЬЁЗНЫЕ ПРОВЕРКИ (→ FIX_REQUIRED):
- Китайские raw-коды атрибутов в userCard (例: 颜色分类:, 尺码:)
- Противоречия между блоками (цена в userCard ≠ цена в snapshot)
- Пустые обязательные поля (userCard, seoTitle, seoBullets)
- Cross-border аналоги представлены как локальные
- Вес/цена в тексте не совпадают с snapshot
- verdict не соответствует данным (✅ при отсутствии рынка)

## ЛЁГКИЕ ПРОВЕРКИ (→ FIX_REQUIRED при ≥3 штук):
- Буллеты без эмодзи
- seoKeywords < 5 штук
- supplierQuestions < 3 штук
- buyerBrief без ссылки на товар

## РЕШЕНИЕ:
- PASS: нет критических и серьёзных ошибок, qualityScore ≥ 7
- FIX_REQUIRED: есть исправимые ошибки, перечисли requiredEdits
- BLOCK: критические ошибки, нельзя показывать пользователю

## ФОРМАТ requiredEdits:
Каждый edit: { field: "имя поля", action: "replace|remove|add", description: "что исправить" }

Верни строго JSON:
{
  "decision": "PASS|FIX_REQUIRED|BLOCK",
  "qualityScore": 0-10,
  "issues": ["описание проблемы 1", "описание проблемы 2"],
  "requiredEdits": [
    {"field": "userCard", "action": "replace", "description": "заменить 0¥ на 'уточняется'"}
  ]
}`;

export async function runQaGate(
  snapshot: AnalysisSnapshot,
  artifacts: Record<string, unknown>,
): Promise<QaResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return { decision: 'PASS', qualityScore: 5, issues: ['QA skipped: no API key'] };
  }

  const input = JSON.stringify({ snapshot, artifacts }, null, 0).slice(0, 8000);
  const prompt = QA_GATE_PROMPT + '\n\nDATA:\n' + input;

  for (const model of QA_MODELS) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          max_tokens: 2000,
          temperature: 0.1,
          messages: [
            { role: 'system', content: 'Ты — QA-ревьюер CardZip. Верни СТРОГО JSON.' },
            { role: 'user', content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(20_000),
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

  // Fallback: pass through if all models fail
  return { decision: 'PASS', qualityScore: 5, issues: ['QA fallback: all models failed'] };
}

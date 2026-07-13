import type { AnalysisSnapshot } from '../core/analysisSnapshot';
import type { QaResult } from '../types';
import { AutoFixResultSchema, parseLlmJson } from '../core/llmSchemas';

const FIX_MODELS = [
  'google/gemini-3.1-flash-lite',
  'openai/gpt-5-mini',
  'qwen/qwen3.7-plus',
];

const AUTO_FIX_PROMPT = `CardZip Auto-Fix.

Роль: редактор качества. Исправь только пользовательские тексты по результатам QA. Не анализируй товар заново. Не меняй productKind, SKU, цену, вес, материалы и выводы, если этого нет в snapshot.

Цель: сделать тексты безопасными, чистыми и пригодными для пользователя.

Исправь:
- debug, raw-коды, NaN, undefined, null, пустые значения;
- 0 ¥, 0 ₽, 0 кг, если это не реальное значение из snapshot;
- дубли вопросов, характеристик, рисков и чек-листов;
- служебные слова: Product Intelligence, AI-черновик, debug, raw, source;
- смешение языков в русских блоках;
- латиницу внутри русских слов: поставщpику → поставщику;
- dangerous claims как факт: медицинский, ортопедический, лечебный, антибактериальный, сертифицированный, гипоаллергенный, безопасный для детей, профессиональный, оригинальный бренд, 100% водонепроницаемый, UPF50+, дезинфекция, стерилизация;
- призыв “закупать партию”, если не подтверждены SKU, вес, упаковка или образец;
- “из карточки 1688”, cross-border и технические labels в пользовательском тексте.

Как исправлять:
- claim как факт → “заявлено, нужно подтвердить”;
- “закупать партию” → “запросить данные / заказать 1–2 образца”;
- повторяющиеся пункты объединяй в один;
- сохраняй полезные факты из snapshot;
- не добавляй новые факты, цифры, материалы, сертификаты или свойства;
- если блок невозможно исправить безопасно — удали проблемный блок и добавь причину в remainingRisks.

Верни строго JSON без markdown:
{
  "fixed": true,
  "summary": "коротко, что исправлено",
  "userCard": "...",
  "seoText": "...",
  "buyerBrief": "...",
  "supplierQuestions": "...",
  "cargoBrief": "...",
  "sampleChecklist": "...",
  "readme": "...",
  "remainingRisks": [],
  "needsSecondQa": false
}

Правила ответа:
- Возвращай только поля, которые были во входных данных.
- Не возвращай null, undefined или пустые строки.
- Если правок не было, fixed=false и summary="правки не требуются".
- needsSecondQa=true только если остались сомнительные claims, языковая мешанина или удалён важный блок.

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
      factSheet: (snapshot as any).factSheet,
      categoryPolicy: (snapshot as any).categoryPolicy,
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
          max_tokens: 5000,
          temperature: 0.0,
          messages: [
            { role: 'system', content: 'Ты — автокорректор CardZip. Верни СТРОГО JSON с исправленными полями.' },
            { role: 'user', content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(26_000),
      });
      if (!res.ok) continue;
      const data = await res.json() as { choices?: { message?: { content?: string } }[] };
      const raw = data.choices?.[0]?.message?.content ?? '';
      const parsed = parseLlmJson(AutoFixResultSchema, raw);
      if (parsed && typeof parsed === 'object') {
        console.log(`[auto-fix] ${model} fixed ${Object.keys(parsed).length} field(s)`);
        return parsed as Record<string, unknown>;
      }
    } catch { continue; }
  }
  return null;
}

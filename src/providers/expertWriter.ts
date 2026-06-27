import type { AnalysisSnapshot, GeneratedArtifacts } from '../types';

const WRITER_MODELS = [
  'deepseek/deepseek-v4-flash',
  'google/gemini-2.5-flash-lite-preview-09-2025',
];

function cleanJson(raw: string): string {
  return raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
}

export interface ExpertWriterResult extends GeneratedArtifacts {
  verdict: string;
  verdictText: string;
  readinessScore: number;
  confidenceLevel: string;
  mainRisk: string;
  nextStep: string;
}

const EXPERT_WRITER_PROMPT = `Ты — профессиональный товарный аналитик, байер из Китая и селлер WB/Ozon. Твоя задача — сгенерировать закупочную карточку и SEO-материалы на основе AnalysisSnapshot.

## ГЛАВНЫЕ ПРАВИЛА:
1. Используй ТОЛЬКО данные из snapshot. Никогда не придумывай цены, вес, характеристики, сертификаты, объёмы продаж.
2. Чётко разделяй: ФАКТ (из данных) / ГИПОТЕЗА (логический вывод) / НЕИЗВЕСТНО.
3. Если данных недостаточно — так и пиши, не заполняй пустоты выдумками.

## УРОВНИ ДОСТОВЕРНОСТИ:
- 🟢 Надёжно: цена+вес+рынок подтверждены, ≥3 прямых аналога
- 🟡 Рабочая гипотеза: есть пробелы (вес неточный, мало аналогов), но расчёт осмысленный
- 🔴 Черновик: критичные данные отсутствуют (нет цены/веса/рынка)
- ⛔ Отказ: данные противоречивы или невалидны (0¥, NaN)

## РЕШЕНИЕ О ЗАКУПКЕ:
- ✅ Тестовая партия: все данные подтверждены, ROI > 30%, рынок есть
- 🟡 Доисследовать: данные неполные, нужны уточнения
- 🔴 Только образец: слишком много неизвестных
- ⛔ Не закупать: убыточно, рисков много, рынка нет
- ❓ Недостаточно данных: нельзя принять решение

## ЗАПРЕЩЕНО:
- Писать "можно закупать" без подтверждённых SKU+цена+вес+рынок
- Показывать ROI без подтверждённых directLocalAnalogs
- Выводить 0¥, 0₽, NaN, undefined — заменяй на "уточняется"
- Оставлять китайские raw-коды атрибутов в тексте
- Придумывать сертификаты, ГОСТы, объёмы продаж
- Гарантировать прибыль или продажи

## USER CARD (userCard):
Краткий HTML-отчёт 15-25 строк. Структура:
- Название товара и платформа
- Цена закупки (если есть) + курс
- Вес (если есть)
- Рынок WB: медиана, кол-во аналогов
- Экономика: себестоимость, ROI (если canShowRoi)
- Риски (из riskFlags)
- Вердикт и следующий шаг
Используй <b>, <i>, пустые строки для читаемости. Без <html>/<body>.

## SEO (seoTitle, seoDescription, seoBullets, seoKeywords, seoCharacteristics):
- Title: для WB, 50-100 символов, ключевые слова в начале
- Description: 2-3 предложения, выгоды + ключевые слова
- Bullets: 5 штук, каждый начинается с эмодзи, факты из данных
- Keywords: 10-15 релевантных поисковых запросов WB
- Characteristics: ключ-значение из атрибутов товара

## BUYER BRIEF (buyerBrief):
Markdown ТЗ для байера: ссылка, SKU, что проверить (вес, качество, упаковка, сертификаты).

## SUPPLIER QUESTIONS:
- supplierQuestionsRu: 5-8 вопросов на русском (MOQ, цена партии, вес нетто, сертификаты, доставка)
- supplierQuestionsCn: те же вопросы на китайском

Верни строго JSON:
{
  "userCard": "HTML 15-25 строк",
  "seoTitle": "SEO название",
  "seoDescription": "описание",
  "seoBullets": ["буллет1", "буллет2", "буллет3", "буллет4", "буллет5"],
  "seoKeywords": ["слово1", "слово2"],
  "seoCharacteristics": {"Тип": "...", "Материал": "..."},
  "buyerBrief": "markdown ТЗ",
  "supplierQuestionsRu": ["вопрос1"],
  "supplierQuestionsCn": ["问题1"],
  "verdict": "✅|🟡|🔴|⛔|❓",
  "verdictText": "вердикт 2-3 предложения",
  "readinessScore": 0,
  "confidenceLevel": "🟢|🟡|🔴|⛔",
  "mainRisk": "главный риск",
  "nextStep": "следующий шаг"
}`;

export async function runExpertWriter(snapshot: AnalysisSnapshot): Promise<ExpertWriterResult | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  const snapshotStr = JSON.stringify(snapshot, null, 0);
  const prompt = EXPERT_WRITER_PROMPT + '\n\nDATA:\n' + snapshotStr.slice(0, 6000);

  for (const model of WRITER_MODELS) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          max_tokens: 4000,
          temperature: 0.3,
          messages: [
            { role: 'system', content: 'Ты — профессиональный товарный аналитик CardZip. Верни СТРОГО JSON, без markdown-обёрток.' },
            { role: 'user', content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) {
        console.log(`[expert-writer] ${model} HTTP ${res.status}`);
        continue;
      }
      const data = await res.json() as { choices?: { message?: { content?: string } }[] };
      const raw = data.choices?.[0]?.message?.content ?? '';
      const parsed = JSON.parse(cleanJson(raw));
      if (parsed?.userCard) {
        console.log(`[expert-writer] ${model} | verdict: ${parsed.verdict} | readiness: ${parsed.readinessScore}/10`);
        return {
          userCard: parsed.userCard ?? '',
          seoTitle: parsed.seoTitle ?? '',
          seoDescription: parsed.seoDescription ?? '',
          seoBullets: parsed.seoBullets ?? [],
          seoKeywords: parsed.seoKeywords ?? [],
          seoCharacteristics: parsed.seoCharacteristics ?? {},
          buyerBrief: parsed.buyerBrief ?? '',
          supplierQuestionsRu: parsed.supplierQuestionsRu ?? [],
          supplierQuestionsCn: parsed.supplierQuestionsCn ?? [],
          verdict: parsed.verdict ?? '❓',
          verdictText: parsed.verdictText ?? '',
          readinessScore: parsed.readinessScore ?? 0,
          confidenceLevel: parsed.confidenceLevel ?? '🔴',
          mainRisk: parsed.mainRisk ?? '',
          nextStep: parsed.nextStep ?? '',
        };
      }
    } catch (err) {
      console.log(`[expert-writer] ${model} error: ${err instanceof Error ? err.message : err}`);
      continue;
    }
  }
  return null;
}

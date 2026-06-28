import { Telegraf } from 'telegraf';
import { redis } from '../lib/redis';

const STEPS = [
  { text: '📡 Загружаем данные с площадки', phase: 'elim' },
  { text: '📡 Читаем карточку товара', phase: 'elim' },
  { text: '📡 Извлекаем характеристики', phase: 'elim' },
  { text: '🤖 Генерируем SEO-контент', phase: 'ai' },
  { text: '🤖 Подбираем ключевые слова', phase: 'ai' },
  { text: '🤖 Анализируем товар', phase: 'ai' },
  { text: '🤖 Готовим вопросы поставщику', phase: 'ai' },
  { text: '🔍 Ищем аналоги на Wildberries', phase: 'market' },
  { text: '🔍 Анализируем цены конкурентов', phase: 'market' },
  { text: '🔍 Фильтруем нерелевантные товары', phase: 'market' },
  { text: '📊 Рассчитываем экономику', phase: 'market' },
  { text: '📝 Готовим отчёт', phase: 'writer' },
  { text: '📝 Генерируем материалы', phase: 'writer' },
  { text: '🔎 Проверяем качество', phase: 'qa' },
  { text: '🔎 Финальная валидация', phase: 'qa' },
  { text: '📦 Отправляем результат', phase: 'qa' },
];

const PHASE_INDEX: Record<string, number> = { elim: 0, ai: 3, market: 7, writer: 11, qa: 13 };

function buildBar(current: number, total: number): string {
  const pct = Math.round((current / total) * 100);
  const filled = Math.round((current / total) * 10);
  const bar = '🟩'.repeat(filled) + '⬜'.repeat(10 - filled);
  return `⏳ ${bar} ${pct}%`;
}

function progressKey(messageId: number): string {
  return `progress:${messageId}`;
}

export function createStepProgress(
  bot: Telegraf,
  chatId: number,
  messageId: number,
  startPhase: string
) {
  const startIdx = PHASE_INDEX[startPhase] ?? 0;
  let localMax = startIdx;
  let initialized = false;

  const init = async () => {
    if (redis) {
      const stored = await redis.get(progressKey(messageId)).catch(() => null);
      const storedMax = stored ? parseInt(String(stored), 10) : 0;
      if (storedMax > localMax) localMax = storedMax;
    }
    initialized = true;
    doEdit(localMax);
  };

  const doEdit = (idx: number) => {
    if (idx < localMax) return;
    localMax = idx;
    if (redis) redis.set(progressKey(messageId), String(idx), { ex: 180 }).catch(() => {});
    const step = STEPS[idx] ?? STEPS[STEPS.length - 1];
    const bar = buildBar(idx + 1, STEPS.length);
    bot.telegram.editMessageText(chatId, messageId, undefined, `${bar}\n\n${step.text}...`).catch(() => {});
    bot.telegram.sendChatAction(chatId, 'typing').catch(() => {});
  };

  init();

  const timer = setInterval(() => {
    if (!initialized) return;
    const next = localMax + 1;
    if (next >= STEPS.length) return;
    doEdit(next);
  }, 7_000);

  return {
    step(phase: string) {
      const newIdx = PHASE_INDEX[phase];
      if (newIdx !== undefined && newIdx >= localMax) {
        doEdit(newIdx);
      }
    },
    stop() {
      clearInterval(timer);
    },
  };
}

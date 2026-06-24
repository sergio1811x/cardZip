import { Telegraf } from 'telegraf';

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
  { text: '📦 Собираем архив с фотографиями', phase: 'send' },
  { text: '📦 Упаковываем материалы', phase: 'send' },
  { text: '✅ Почти готово', phase: 'send' },
];

function buildBar(current: number, total: number): string {
  const pct = Math.round((current / total) * 100);
  const filled = Math.round((current / total) * 10);
  const bar = '🟩'.repeat(filled) + '⬜'.repeat(10 - filled);
  return `⏳ ${bar} ${pct}%`;
}

export function createStepProgress(
  bot: Telegraf,
  chatId: number,
  messageId: number,
  startPhase: string
) {
  const phaseIndex: Record<string, number> = { elim: 0, ai: 3, market: 7, send: 11 };
  let tick = phaseIndex[startPhase] ?? 0;

  let maxTick = tick;

  const edit = (idx: number) => {
    if (idx < maxTick) return; // никогда не откатываемся
    maxTick = idx;
    const step = STEPS[idx] ?? STEPS[STEPS.length - 1];
    const bar = buildBar(idx + 1, STEPS.length);
    const text = `${bar}\n\n${step.text}...`;
    bot.telegram.editMessageText(chatId, messageId, undefined, text).catch(() => {});
    bot.telegram.sendChatAction(chatId, 'typing').catch(() => {});
  };

  edit(tick);

  const timer = setInterval(() => {
    tick++;
    if (tick >= STEPS.length) tick = STEPS.length - 1;
    edit(tick);
  }, 5_000);

  return {
    step(phase: string) {
      const newIdx = phaseIndex[phase];
      if (newIdx !== undefined) {
        tick = Math.max(tick, newIdx);
        edit(tick);
      }
    },
    stop() {
      clearInterval(timer);
    },
  };
}

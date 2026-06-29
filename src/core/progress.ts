import { Telegraf } from 'telegraf';
import { redis } from '../lib/redis';

type ProgressStage = {
  key: string;
  pct: number;
  text: string;
  holdTexts?: string[];
};

// 100% is reserved for the moment when the final Telegram message is already being sent.
// Never auto-advance to 100: otherwise users see “100% / almost ready” while QA/files/Telegram
// can still take 1–2 minutes.
const STAGES: ProgressStage[] = [
  { key: 'elim', pct: 8, text: 'Читаю карточку товара на 1688/Taobao/Tmall' },
  { key: 'elim_attrs', pct: 18, text: 'Извлекаю цену, SKU, поставщика и характеристики' },
  { key: 'elim_done', pct: 28, text: 'Данные карточки получены, подготавливаю нормализацию' },

  { key: 'ai', pct: 36, text: 'Понимаю товар и очищаю китайское название' },
  { key: 'ai_sku', pct: 48, text: 'Разбираю SKU, размеры, цвета и комплектации' },
  { key: 'ai_rules', pct: 60, text: 'Формирую правила: что можно писать, что нужно подтвердить' },

  { key: 'market', pct: 66, text: 'Собираю закупочный пакет без обязательного WB-парсинга' },
  { key: 'package', pct: 72, text: 'Считаю готовность к проверке, риски и cost-only экономику' },

  { key: 'send', pct: 80, text: 'Готовлю основные материалы отчёта' },
  { key: 'writer', pct: 84, text: 'Обогащаю SEO, ТЗ байеру и вопросы поставщику' },
  { key: 'files', pct: 88, text: 'Собираю файлы: SEO, ТЗ байеру, карго, инфографику и чек-листы' },
  { key: 'validate', pct: 91, text: 'Проверяю отчёт кодовым валидатором', holdTexts: [
    'Не зависло: проверяю, чтобы в отчёте не было NaN, 0 ₽, raw-данных и опасных обещаний',
    'Сохраняю полезные данные, но помечаю неподтверждённые свойства как “заявлено/уточнить”',
  ] },
  { key: 'qa', pct: 94, text: 'Финальная QA-проверка перед отправкой', holdTexts: [
    'Финальная проверка может занять дольше: сверяю отчёт, SEO и ТЗ с данными 1688',
    'Проверяю, что отчёт полезный даже без автоматической WB-аналитики',
  ] },
  { key: 'autofix', pct: 96, text: 'Исправляю формулировки после QA, если это нужно', holdTexts: [
    'Не выкидываю данные: перевожу спорные claims в безопасный статус “подтвердить”',
    'Дочищаю текст, чтобы можно было показать полный отчёт, а не safe summary',
  ] },
  { key: 'charge', pct: 97, text: 'Проверяю баланс и готовлю отправку полного пакета' },
  { key: 'telegram', pct: 99, text: 'Отправляю итоговый отчёт в Telegram', holdTexts: [
    'Telegram может принимать большой отчёт чуть дольше — уже отправляю результат',
    'Финальный пакет готов: отправляю сообщение и кнопки действий',
  ] },
  { key: 'sent', pct: 100, text: 'Готово — отчёт отправлен' },
];

const STAGE_INDEX: Record<string, number> = Object.fromEntries(STAGES.map((s, i) => [s.key, i]));
const PHASE_INDEX: Record<string, number> = {
  elim: STAGE_INDEX.elim,
  ai: STAGE_INDEX.ai,
  market: STAGE_INDEX.market,
  package: STAGE_INDEX.package,
  send: STAGE_INDEX.send,
  writer: STAGE_INDEX.writer,
  files: STAGE_INDEX.files,
  validate: STAGE_INDEX.validate,
  qa: STAGE_INDEX.qa,
  autofix: STAGE_INDEX.autofix,
  charge: STAGE_INDEX.charge,
  telegram: STAGE_INDEX.telegram,
  sent: STAGE_INDEX.sent,
};

// Each phase auto-advances only inside a safe band. The loader never reaches 100% by timer.
const PHASE_MAX_INDEX: Record<string, number> = {
  elim: STAGE_INDEX.elim_done,
  ai: STAGE_INDEX.ai_rules,
  market: STAGE_INDEX.package,
  package: STAGE_INDEX.package,
  send: STAGE_INDEX.writer,
  writer: STAGE_INDEX.writer,
  files: STAGE_INDEX.files,
  validate: STAGE_INDEX.validate,
  qa: STAGE_INDEX.qa,
  autofix: STAGE_INDEX.autofix,
  charge: STAGE_INDEX.charge,
  telegram: STAGE_INDEX.telegram,
  sent: STAGE_INDEX.sent,
};

function buildBar(pct: number): string {
  const safePct = Math.max(0, Math.min(100, Math.round(pct)));
  const filled = Math.max(0, Math.min(10, Math.floor(safePct / 10)));
  const bar = '🟩'.repeat(filled) + '⬜'.repeat(10 - filled);
  return `⏳ ${bar} ${safePct}%`;
}

function progressKey(messageId: number): string {
  return `progress:${messageId}`;
}

function progressHoldKey(messageId: number): string {
  return `progress_hold:${messageId}`;
}

export function createStepProgress(
  bot: Telegraf,
  chatId: number,
  messageId: number,
  startPhase: string
) {
  let currentPhase = startPhase;
  let localMax = PHASE_INDEX[startPhase] ?? 0;
  let initialized = false;
  let holdTick = 0;
  let disposed = false;

  const render = (idx: number, holdMessage?: string) => {
    if (disposed) return;
    const stage = STAGES[idx] ?? STAGES[STAGES.length - 2];
    const text = holdMessage || stage.text;
    const body = `${buildBar(stage.pct)}\n\n${text}...`;
    bot.telegram.editMessageText(chatId, messageId, undefined, body).catch(() => {});
    bot.telegram.sendChatAction(chatId, 'typing').catch(() => {});
  };

  const save = (idx: number) => {
    if (!redis) return;
    redis.set(progressKey(messageId), String(idx), { ex: 240 }).catch(() => {});
  };

  const init = async () => {
    if (disposed) return;
    if (redis) {
      const stored = await redis.get(progressKey(messageId)).catch(() => null);
      const storedMax = stored ? parseInt(String(stored), 10) : 0;
      if (Number.isFinite(storedMax) && storedMax > localMax) localMax = storedMax;
      const storedHold = await redis.get(progressHoldKey(messageId)).catch(() => null);
      holdTick = storedHold ? parseInt(String(storedHold), 10) || 0 : 0;
    }
    if (disposed) return;
    initialized = true;
    render(localMax);
    save(localMax);
  };

  const doEdit = (idx: number, force = false) => {
    if (disposed) return;
    const maxIdx = PHASE_MAX_INDEX[currentPhase] ?? STAGE_INDEX.telegram;
    const boundedIdx = Math.min(idx, maxIdx);
    if (!force && boundedIdx < localMax) return;
    localMax = boundedIdx;
    holdTick = 0;
    save(localMax);
    render(localMax);
  };

  init();

  const timer = setInterval(() => {
    if (!initialized) return;
    const maxIdx = PHASE_MAX_INDEX[currentPhase] ?? STAGE_INDEX.telegram;

    if (localMax < maxIdx) {
      doEdit(localMax + 1);
      return;
    }

    // Long-running phase: keep the same percentage, but rotate honest status text.
    const stage = STAGES[localMax] ?? STAGES[STAGE_INDEX.telegram];
    const holdTexts = stage.holdTexts ?? [];
    if (holdTexts.length) {
      const holdMessage = holdTexts[holdTick % holdTexts.length];
      holdTick += 1;
      if (redis) redis.set(progressHoldKey(messageId), String(holdTick), { ex: 240 }).catch(() => {});
      render(localMax, holdMessage);
    } else {
      bot.telegram.sendChatAction(chatId, 'typing').catch(() => {});
    }
  }, 8_000);

  return {
    step(phase: string) {
      const newIdx = PHASE_INDEX[phase];
      if (newIdx === undefined) return;
      currentPhase = phase;
      const target = Math.max(localMax, newIdx);
      doEdit(target, true);
    },
    message(text: string, pct?: number) {
      const synthetic: ProgressStage = {
        key: 'custom',
        pct: pct ?? (STAGES[localMax]?.pct ?? 90),
        text,
      };
      bot.telegram.editMessageText(chatId, messageId, undefined, `${buildBar(synthetic.pct)}\n\n${synthetic.text}...`).catch(() => {});
      bot.telegram.sendChatAction(chatId, 'typing').catch(() => {});
    },
    stop(options?: { clear?: boolean; done?: boolean }) {
      clearInterval(timer);
      if (options?.done) render(STAGE_INDEX.sent);
      disposed = true;
      if (options?.clear !== false && redis) {
        redis.del(progressKey(messageId)).catch(() => {});
        redis.del(progressHoldKey(messageId)).catch(() => {});
      }
    },
  };
}

import type { Telegraf } from 'telegraf';
import { redis } from '../lib/redis';

type ProgressStage = {
  key: string;
  pct: number;
  text: string;
  holdTexts?: string[];
};

// UX rule:
// - Keep the old familiar Telegram visual: ⏳ 🟩🟩🟩⬜⬜ 40%.
// - Never show 100% until the final report has actually been sent.
// - While a long LLM/QA/file stage runs, keep the same percentage but rotate helpful texts.
// This makes the loader feel alive without lying about completion.
const STAGES: ProgressStage[] = [
  { key: 'elim', pct: 6, text: 'Получил ссылку, открываю карточку товара' },
  { key: 'elim_fetch', pct: 10, text: 'Загружаю данные 1688 / Taobao / Tmall' },
  { key: 'elim_attrs', pct: 16, text: 'Извлекаю цену, SKU, поставщика и характеристики' },
  { key: 'elim_photos', pct: 22, text: 'Проверяю фото, остатки, MOQ и данные поставщика' },
  { key: 'elim_done', pct: 28, text: 'Карточка получена, готовлю нормализацию данных' },

  { key: 'ai', pct: 34, text: 'Понимаю товар и очищаю китайское название' },
  { key: 'ai_identity', pct: 40, text: 'Определяю тип товара, назначение и категорию' },
  { key: 'ai_sku', pct: 46, text: 'Разбираю SKU: цвета, размеры, модели и комплектации' },
  { key: 'ai_claims', pct: 52, text: 'Перевожу заявленные свойства в безопасный статус' },
  { key: 'ai_rules', pct: 60, text: 'Формирую правила: что можно писать, что нужно подтвердить' },

  { key: 'market', pct: 64, text: 'Собираю закупочный пакет без обязательного WB-парсинга' },
  { key: 'readiness', pct: 68, text: 'Оцениваю закупочную готовность и главные риски' },
  { key: 'cost', pct: 72, text: 'Считаю предварительную себестоимость без неподтверждённого ROI' },
  { key: 'package', pct: 76, text: 'Готовлю вывод: что понятно, что мешает закупке, что делать дальше' },

  { key: 'send', pct: 80, text: 'Собираю главное сообщение для Telegram' },
  { key: 'writer', pct: 84, text: 'Обогащаю SEO, ТЗ байеру и вопросы поставщику', holdTexts: [
    'Дополняю SEO полезными характеристиками из 1688, ничего важного не выкидываю',
    'Структурирую ТЗ байеру: SKU, цена, риски, что проверить на образце',
    'Готовлю вопросы поставщику на основе выбранного SKU и недостающих данных',
    'Перевожу спорные claims в формат “заявлено поставщиком / подтвердить”',
  ] },
  { key: 'files', pct: 88, text: 'Собираю файлы: SEO, ТЗ байеру, карго, инфографику и чек-листы', holdTexts: [
    'Формирую SEO-черновик, ТЗ байеру, ТЗ карго и риск-чеклист',
    'Собираю материалы так, чтобы их можно было переслать байеру без ручной чистки',
    'Проверяю, чтобы в файлах не было пустых значений, raw SKU и китайского мусора',
    'Готовлю рекомендации по образцу и ТЗ для инфографики',
  ] },
  { key: 'validate', pct: 91, text: 'Проверяю отчёт кодовым валидатором', holdTexts: [
    'Не зависло: проверяю, чтобы не было NaN, 0 ₽, 0 ¥, undefined и raw-данных',
    'Сохраняю полезные данные, но помечаю неподтверждённые свойства как “заявлено/уточнить”',
    'Проверяю, что отчёт не обещает прибыль и не рекомендует партию без данных',
    'Сверяю main report, SEO и ТЗ с данными карточки 1688',
  ] },
  { key: 'qa', pct: 94, text: 'Финальная QA-проверка перед отправкой', holdTexts: [
    'Финальная проверка может занять дольше: сверяю отчёт, SEO и ТЗ с данными 1688',
    'Проверяю, что отчёт полезный даже без автоматической WB-аналитики',
    'Проверяю, что вопросы поставщику конкретные, а не общие',
    'Контролирую, чтобы медицинские/сертификационные claims не звучали как факт без документов',
  ] },
  { key: 'autofix', pct: 96, text: 'Исправляю формулировки после QA, если это нужно', holdTexts: [
    'Не выкидываю данные: перевожу спорные claims в безопасный статус “подтвердить”',
    'Дочищаю текст, чтобы можно было показать полный отчёт, а не короткое safe summary',
    'Убираю только опасные обещания и технический мусор, полезные факты сохраняю',
    'Финально выравниваю форматирование отчёта и файлов',
  ] },
  { key: 'charge', pct: 97, text: 'Проверяю баланс и готовлю отправку полного пакета', holdTexts: [
    'Пакет почти готов: проверяю кредит и готовлю финальную отправку',
    'Сохраняю результат, чтобы /last показывал тот же отчёт',
  ] },
  { key: 'telegram', pct: 99, text: 'Отправляю итоговый отчёт в Telegram', holdTexts: [
    'Telegram может принимать большой отчёт чуть дольше — уже отправляю результат',
    'Финальный пакет готов: отправляю сообщение, кнопки действий и файлы',
    'Не зависло: большой отчёт может отправляться несколькими сообщениями',
    'Остался последний шаг — доставить результат в чат',
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

// Each phase auto-advances only inside a safe band. 100% is reserved for sent.
const PHASE_MAX_INDEX: Record<string, number> = {
  elim: STAGE_INDEX.elim_done,
  ai: STAGE_INDEX.ai_rules,
  market: STAGE_INDEX.package,
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

function progressKey(messageId: number): string {
  return `progress:${messageId}`;
}

function progressHoldKey(messageId: number): string {
  return `progress_hold:${messageId}`;
}

type ProgressBotLike = Pick<Telegraf, 'telegram'> | { telegram: Telegraf['telegram'] };

export function buildProgressText(pct: number, text: string): string {
  const requestedPct = Math.max(0, Math.min(100, Math.round(pct)));
  // Public loader should never say 100 until the explicit "sent" stage.
  const safePct = requestedPct >= 100 ? 100 : Math.min(99, requestedPct);
  const total = 10;
  const filled = safePct >= 100
    ? total
    : Math.max(0, Math.min(total - 1, Math.floor((safePct / 100) * total)));
  const bar = '🟩'.repeat(filled) + '⬜'.repeat(total - filled);
  return `⏳ ${bar} ${safePct}%\n\n${text}...`;
}


function getHoldTexts(stage: ProgressStage): string[] {
  if (stage.holdTexts?.length) return stage.holdTexts;
  const byKey: Record<string, string[]> = {
    elim: ['Проверяю ссылку и готовлю загрузку карточки', 'Открываю товар и ищу основные данные', 'Начинаю разбирать карточку поставщика'],
    elim_fetch: ['Получаю название, цену и данные поставщика', 'Загружаю карточку: SKU, фото, MOQ и остатки', 'Проверяю, что данные пришли с 1688 корректно'],
    elim_attrs: ['Отделяю цену от вариантов SKU', 'Ищу материалы, размеры, цвета и комплектации', 'Собираю характеристики без китайского хаоса'],
    elim_photos: ['Смотрю количество фото и данные поставщика', 'Проверяю MOQ, продажи и доступные варианты', 'Готовлю карточку к нормализации'],
    elim_done: ['Данные 1688 получены, перехожу к AI-разбору', 'Карточка собрана, дальше очищаю и перевожу', 'Готовлю умный разбор товара для закупочного пакета'],
    ai: ['Очищаю китайское название от мусора', 'Определяю, что это за товар и где его применять', 'Перевожу важные свойства в понятный русский вид'],
    ai_identity: ['Уточняю категорию, назначение и аудиторию', 'Проверяю, чтобы не перепутать товар с похожей категорией', 'Формирую понятное русское название товара'],
    ai_sku: ['Разбираю цвета, размеры, модели и комплектации', 'Нормализую SKU так, чтобы их понял байер', 'Проверяю, от какого SKU зависит цена'],
    ai_claims: ['Опасные обещания перевожу в статус “подтвердить”', 'Сохраняю полезные свойства, но не пишу их как факт без проверки', 'Разделяю факты из карточки и заявления поставщика'],
    ai_rules: ['Готовлю правила для SEO, байера, карго и образца', 'Формирую список того, что нельзя обещать без документов', 'Собираю вопросы поставщику на основе рисков товара'],
    market: ['WB не обязателен: собираю закупочный пакет по данным 1688', 'Фокус на SKU, рисках, образце, карго и документах', 'Готовлю полезный результат без обещаний прибыли'],
    readiness: ['Считаю закупочную готовность 0–100', 'Ищу блокеры перед образцом и партией', 'Формирую следующий шаг для селлера'],
    cost: ['Считаю закупку в рублях и себестоимость без карго', 'Отделяю себестоимость от неподтверждённого ROI', 'Показываю только честные расчёты без псевдо-точности'],
    package: ['Собираю главный отчёт без дублей и лишней простыни', 'Выношу детали в кнопки и файлы', 'Готовлю короткий verdict и next steps'],
    send: ['Формирую сообщение для Telegram', 'Проверяю, чтобы главный отчёт читался быстро', 'Добавляю кнопки: поставщику, файлы, риски, образец'],
  };
  return byKey[stage.key] ?? [stage.text, 'Продолжаю обработку, это может занять чуть дольше', 'Не зависло: готовлю закупочный пакет'];
}

export function createStepProgress(
  bot: ProgressBotLike,
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
    const body = buildProgressText(stage.pct, text);
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
    const holdTexts = getHoldTexts(stage);
    if (holdTexts.length) {
      const holdMessage = holdTexts[holdTick % holdTexts.length];
      holdTick += 1;
      if (redis) redis.set(progressHoldKey(messageId), String(holdTick), { ex: 240 }).catch(() => {});
      render(localMax, holdMessage);
    } else {
      bot.telegram.sendChatAction(chatId, 'typing').catch(() => {});
    }
  }, 5_000);

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
      bot.telegram.editMessageText(chatId, messageId, undefined, buildProgressText(synthetic.pct, synthetic.text)).catch(() => {});
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

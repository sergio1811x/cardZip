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
  { key: 'elim', pct: 6, text: 'Открываю ссылку и загружаю карточку товара' },
  { key: 'elim_fetch', pct: 10, text: 'Получаю цену, SKU, фото и данные поставщика' },
  { key: 'elim_attrs', pct: 16, text: 'Разбираю характеристики, материалы и комплектацию' },
  { key: 'elim_photos', pct: 22, text: 'Проверяю MOQ, остатки, фото и данные продавца' },
  { key: 'elim_done', pct: 28, text: 'Карточка получена, перехожу к разбору товара' },

  { key: 'ai', pct: 34, text: 'Перевожу название и убираю лишний китайский шум' },
  { key: 'ai_identity', pct: 40, text: 'Определяю тип товара, назначение и аудиторию' },
  { key: 'ai_sku', pct: 46, text: 'Раскладываю SKU на цвета, размеры и упаковку' },
  { key: 'ai_claims', pct: 52, text: 'Отмечаю свойства, которые нужно подтвердить' },
  { key: 'ai_rules', pct: 60, text: 'Готовлю вопросы поставщику и правила проверки' },

  { key: 'market', pct: 64, text: 'Собираю закупочный пакет по данным карточки' },
  { key: 'readiness', pct: 68, text: 'Оцениваю готовность товара к образцу' },
  { key: 'cost', pct: 72, text: 'Считаю предварительную себестоимость без карго' },
  { key: 'package', pct: 76, text: 'Формирую короткий отчёт и следующий шаг' },

  { key: 'send', pct: 80, text: 'Готовлю сообщение и кнопки действий' },
  { key: 'writer', pct: 84, text: 'Делаю документы полезнее: SEO, ТЗ и вопросы', holdTexts: [
    'Дополняю SEO понятным описанием, буллетами и ключевыми словами',
    'Собираю ТЗ байеру: что закупаем, какой SKU и что проверить',
    'Готовлю вопросы поставщику по цене, весу, упаковке и материалу',
    'Переношу спорные свойства в формат “заявлено — подтвердить”',
    'Проверяю, чтобы полезные данные не потерялись в отчёте',
  ] },
  { key: 'files', pct: 88, text: 'Собираю закупочный пакет по файлам', holdTexts: [
    'Готовлю вопросы поставщику, ТЗ байеру и ТЗ карго',
    'Собираю риск-чеклист и план проверки образца',
    'Оформляю SEO-черновик и ТЗ для инфографики',
    'Проверяю, чтобы файлы можно было переслать без ручной чистки',
    'Раскладываю материалы по задачам: поставщик, байер, карго, карточка',
  ] },
  { key: 'validate', pct: 91, text: 'Проверяю отчёт перед показом пользователю', holdTexts: [
    'Проверяю, чтобы не было пустых цен, битых значений и дублей',
    'Сверяю, что SKU, цена, вес и материалы показаны понятно',
    'Убираю технические слова и оставляю нормальный текст для селлера',
    'Проверяю, что в отчёте нет обещаний прибыли без данных',
    'Сохраняю полезные свойства товара, но помечаю, что нужно подтвердить',
  ] },
  { key: 'qa', pct: 94, text: 'Финально сверяю качество закупочного пакета', holdTexts: [
    'Проверяю, что главный отчёт короткий и без повторов',
    'Смотрю, чтобы вопросы поставщику были конкретными, а не общими',
    'Проверяю, что SEO похоже на черновик карточки, а не техвыгрузку',
    'Сверяю, что ТЗ байеру, карго и план образца подходят именно этому товару',
    'Проверяю, что документы не содержат чужих категорий и лишних обещаний',
  ] },
  { key: 'autofix', pct: 96, text: 'Дочищаю формулировки и оформление', holdTexts: [
    'Убираю повторы, служебные слова и некрасивые формулировки',
    'Исправляю спорные обещания на “подтвердить у поставщика”',
    'Выравниваю блоки отчёта, чтобы его было удобно читать',
    'Проверяю, что материалы выглядят как документы, а не черновики системы',
  ] },
  { key: 'charge', pct: 97, text: 'Сохраняю результат и готовлю отправку', holdTexts: [
    'Сохраняю анализ, чтобы его можно было открыть через /last',
    'Проверяю баланс и готовлю финальное сообщение',
    'Пакет почти готов: осталось отправить результат в чат',
  ] },
  { key: 'telegram', pct: 99, text: 'Отправляю итоговый отчёт в Telegram', holdTexts: [
    'Отправляю главный отчёт и кнопки следующего шага',
    'Большой закупочный пакет может отправляться чуть дольше',
    'Финальный результат уже готов, доставляю его в чат',
    'Остался последний шаг — показать отчёт пользователю',
  ] },
  { key: 'sent', pct: 100, text: 'Готово — закупочный пакет отправлен' },
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
  // Keep percentage and bar visually consistent:
  // 1–9% already shows one green block, 99% still does not look fully complete.
  const filled = safePct <= 0
    ? 0
    : safePct >= 100
      ? total
      : Math.max(1, Math.min(total - 1, Math.round((safePct / 100) * total)));
  const bar = '🟩'.repeat(filled) + '⬜'.repeat(total - filled);
  const cleanText = String(text || 'Готовлю закупочный пакет').trim().replace(/[.。…]+$/g, '');
  return `⏳ ${bar} ${safePct}%\n\n${cleanText}...`;
}


function getHoldTexts(stage: ProgressStage): string[] {
  if (stage.holdTexts?.length) return stage.holdTexts;
  const byKey: Record<string, string[]> = {
    elim: [
      'Проверяю ссылку и открываю карточку товара',
      'Подключаюсь к источнику и начинаю загрузку данных',
      'Ищу основные данные товара: название, цену и варианты',
      'Готовлю карточку к разбору',
    ],
    elim_fetch: [
      'Получаю название, цену, SKU и данные поставщика',
      'Загружаю фото, MOQ, остатки и варианты товара',
      'Проверяю, что карточка пришла корректно',
      'Собираю данные, которые нужны для закупочного пакета',
    ],
    elim_attrs: [
      'Отделяю цену товара от цены разных SKU',
      'Ищу цвета, размеры, упаковку и комплектацию',
      'Собираю материалы и важные характеристики',
      'Привожу данные карточки к понятному виду',
    ],
    elim_photos: [
      'Проверяю фото товара и данные продавца',
      'Смотрю MOQ, продажи, остатки и доступные варианты',
      'Собираю всё, что поможет байеру проверить товар',
      'Готовлю данные для следующего этапа',
    ],
    elim_done: [
      'Данные карточки получены, перехожу к разбору товара',
      'Теперь очищаю название и разбираю варианты SKU',
      'Готовлю понятный русский закупочный паспорт',
      'Проверяю товар перед созданием вопросов поставщику',
    ],
    ai: [
      'Очищаю название и перевожу важные детали',
      'Понимаю, что это за товар и как его использовать',
      'Отделяю факты из карточки от обещаний поставщика',
      'Делаю товар понятным для селлера, байера и карго',
    ],
    ai_identity: [
      'Определяю категорию, аудиторию и сценарии применения',
      'Проверяю, чтобы не подставить чек-лист чужой категории',
      'Формирую нормальное русское название товара',
      'Выделяю главные свойства, которые важны для закупки',
    ],
    ai_sku: [
      'Раскладываю SKU на цвет, размер, модель и упаковку',
      'Перевожу варианты так, чтобы их понял байер',
      'Проверяю, какой SKU влияет на цену и комплектацию',
      'Выделяю цвета, размеры, pack-count и важные примечания',
    ],
    ai_claims: [
      'Помечаю спорные свойства как “заявлено — подтвердить”',
      'Сохраняю полезные свойства, но не обещаю их как факт',
      'Готовлю список того, что нужно проверить на образце',
      'Отделяю безопасный текст карточки от того, что надо уточнить',
    ],
    ai_rules: [
      'Собираю вопросы поставщику по недостающим данным',
      'Готовлю правила для SEO, байера, карго и образца',
      'Определяю, что можно писать в карточке, а что нужно подтвердить',
      'Формирую закупочный маршрут: вопросы, образец, проверка',
    ],
    market: [
      'Собираю закупочный пакет без обязательной WB-аналитики',
      'Фокусируюсь на данных 1688, SKU, рисках и проверке товара',
      'Готовлю полезный результат без обещаний точной прибыли',
      'Показываю, что уже можно использовать до проверки рынка',
    ],
    readiness: [
      'Считаю готовность товара к закупочному процессу',
      'Ищу блокеры: вес, упаковка, SKU, материал и claims',
      'Определяю, можно ли переходить к образцу',
      'Формирую следующий понятный шаг для пользователя',
    ],
    cost: [
      'Считаю закупку в рублях и себестоимость без карго',
      'Показываю только те расчёты, которые можно обосновать',
      'Отделяю себестоимость от неподтверждённой прибыли',
      'Готовлю список данных, которые нужны для полного расчёта',
    ],
    package: [
      'Собираю короткий главный отчёт без дублей',
      'Выношу подробности в данные товара и материалы',
      'Готовлю verdict и понятный следующий шаг',
      'Проверяю, чтобы отчёт читался быстро',
    ],
    send: [
      'Готовлю сообщение и главное меню действий',
      'Добавляю кнопки: план, поставщику, данные и материалы',
      'Проверяю, чтобы пользователь понимал, что делать первым',
      'Собираю экран без лишних кнопок и перегруза',
    ],
  };
  return byKey[stage.key] ?? [
    stage.text,
    'Продолжаю готовить закупочный пакет',
    'Не зависло: собираю данные для отчёта',
    'Проверяю результат перед отправкой',
  ];
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

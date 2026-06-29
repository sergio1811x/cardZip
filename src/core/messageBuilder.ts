import { Markup } from 'telegraf';
import {
  buildMainReport,
  build1688Detail as render1688Detail,
  buildSafeSummary as renderSafeSummary,
  buildDecisionContext,
  buildCargoBrief,
  buildInfographicBrief,
  buildRiskChecklist,
  buildSampleRecommendation,
} from './decisionLayer';

function detailKeyboard(jobId: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('⬅️ Назад к плану', `proc_plan_${jobId}`)],
    [Markup.button.callback('🏠 К отчёту', `back_main_${jobId}`), Markup.button.callback('📁 Материалы', `materials_${jobId}`)],
    [Markup.button.callback('🔄 Новый товар', 'new_search')],
  ]);
}

function topLevelKeyboard(jobId: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🚀 Дальнейший план', `proc_plan_${jobId}`)],
    [Markup.button.callback('💬 Текст поставщику', 'supplier_questions'), Markup.button.callback('📦 Данные товара', `product_detail_${jobId}`)],
    [Markup.button.callback('📁 Материалы', `materials_${jobId}`), Markup.button.callback('🔄 Новый товар', 'new_search')],
  ]);
}

export function buildMainMessage(product: any, jobId: string, status: any, _category?: any): { text: string; keyboard: any } {
  const text = buildMainReport(product, { creditsRemaining: status?.creditsRemaining });
  const keyboard = topLevelKeyboard(jobId);
  return { text, keyboard };
}

export function buildMessage1(product: any): string {
  return buildMainReport(product, undefined, undefined);
}

export function buildMessage2(product: any): string {
  return render1688Detail(product);
}

export function buildMessage3(status: any): { text: string; keyboard: any } {
  const credits = typeof status?.creditsRemaining === 'number' ? status.creditsRemaining : 0;
  const plan = status?.plan ?? 'free';
  return {
    text: `📦 Осталось: ${credits} анализов\nТариф: ${plan}`,
    keyboard: Markup.inlineKeyboard([[Markup.button.callback('💳 Пополнить', 'tariffs')]]),
  };
}

export function buildEconomicsDetail(product: any, jobId: string): { text: string; keyboard: any } {
  const x = buildDecisionContext(product);
  const lines = ['💸 <b>Предварительная себестоимость</b>', ''];
  if (!x.price.canCalculateCost) lines.push('Себестоимость не рассчитана — нет цены товара.');
  else {
    lines.push(`Цена товара: ${x.price.displayPriceText}`);
    if (x.cost.purchaseRub) lines.push(`Закупка: ${x.cost.purchaseRub.toLocaleString('ru-RU')} ₽`);
    if (x.cost.costWithoutCargoRub) lines.push(`Себестоимость без карго: ${x.cost.costWithoutCargoRub.toLocaleString('ru-RU')} ₽`);
    if (x.cost.cargoRub) lines.push(`Карго: ${x.cost.cargoRub.toLocaleString('ru-RU')} ₽`);
    else lines.push('Карго: не рассчитано — нужен вес с упаковкой.');
    if (x.cost.totalCostRub) lines.push(`Итого с карго: ${x.cost.totalCostRub.toLocaleString('ru-RU')} ₽`);
    if (x.cost.canShowRoi) {
      lines.push(`Сценарная прибыль: ${x.cost.scenarioProfitRub?.toLocaleString('ru-RU')} ₽`);
      lines.push(`Сценарный ROI: ${x.cost.scenarioRoiPercent}%`);
      lines.push('Это расчёт по цене, введённой пользователем, не подтверждённая рыночная цена.');
    } else {
      lines.push('ROI не считаю — рынок и цена продажи не заданы.');
    }
    if (x.cost.warnings.length) lines.push('', ...x.cost.warnings.map((w) => `⚠️ ${w}`));
  }
  lines.push('', 'Что сделать:');
  lines.push('1. Уточните вес у поставщика.');
  lines.push(`2. Или нажмите «⚖️ Указать вес вручную».`);
  return { text: lines.join('\n'), keyboard: detailKeyboard(jobId) };
}

export function buildProcurementPlanDetail(product: any, jobId: string): { text: string; keyboard: any } {
  const x = buildDecisionContext(product);
  const flow = String(product?.procurementStatus ?? product?.procurement_status ?? '').toLowerCase();
  const questionsSent = /waiting_supplier_reply|supplier_reply_received|ready_for_sample|sample_ordered|sample_received|ready_for_test_batch/.test(flow);
  const replyReceived = !!product?.supplierAnswer || /supplier_reply_received|ready_for_sample|sample_ordered|sample_received|ready_for_test_batch/.test(flow);
  const hasWeight = x.weight.canUseForCargo;
  const status = replyReceived ? (hasWeight ? '🧪 Готов к плану образца' : '✅ Ответ получен, нужен вес') : questionsSent ? '⏳ Ждём ответ поставщика' : '🟡 Готов к запросу данных';
  const step1Status = questionsSent ? '✅ вопросы отправлены / можно ждать ответ' : '⏳ нужно сделать';
  const step2Status = replyReceived ? '✅ ответ внесён' : questionsSent ? '⏳ ждём ответ поставщика' : '🔒 сначала отправьте вопросы';
  const step3Status = hasWeight ? '✅ вес есть, себестоимость можно обновлять' : replyReceived ? '⏳ проверьте, есть ли вес в ответе' : '🔒 ждёт вес от поставщика';
  const step4Status = replyReceived || hasWeight ? '🧪 можно готовить заказ 1–2 образцов' : '🔒 после ответа поставщика';

  const lines = [
    '🚀 <b>Дальнейший план закупки</b>',
    '',
    `Статус товара: ${status}`,
    `Готовность: ${x.readiness.score}/100`,
    '',
    '<b>1️⃣ Спросить поставщика</b>',
    'Зачем: без веса, упаковки и точного SKU нельзя понять реальную себестоимость.',
    'Что получим: цену SKU, вес, габариты, материал, комплектацию.',
    `Статус: ${step1Status}`,
    '',
    '<b>2️⃣ Внести ответ поставщика</b>',
    'Зачем: я извлеку из ответа вес, габариты, цену, MOQ и обновлю документы.',
    `Статус: ${step2Status}`,
    '',
    '<b>3️⃣ Обновить себестоимость</b>',
    'Зачем: после веса можно посчитать карго, бюджет образца и тестовой закупки.',
    `Статус: ${step3Status}`,
    '',
    '<b>4️⃣ Заказать образец</b>',
    'Зачем: проверить качество, упаковку и заявленные свойства руками, а не по картинке.',
    `Статус: ${step4Status}`,
    '',
    '<b>5️⃣ Принять решение</b>',
    'Варианты: заказать образец · отправить в доработку · не брать товар.',
    '',
    '<b>Сейчас лучшее действие:</b>',
    questionsSent ? 'Если поставщик уже ответил — нажмите «2️⃣ Внести ответ».' : 'Нажмите «1️⃣ Отправить вопросы» и скопируйте текст в чат 1688.',
  ];
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('1️⃣ Отправить вопросы', 'supplier_questions')],
    [Markup.button.callback('2️⃣ Внести ответ', 'supplier_confirm'), Markup.button.callback('3️⃣ Указать вес', `weight_input:${jobId}`)],
    [Markup.button.callback('4️⃣ План образца', `sample_detail_${jobId}`), Markup.button.callback('💸 Себестоимость', `econ_detail_${jobId}`)],
    [Markup.button.callback('📁 Материалы', `materials_${jobId}`), Markup.button.callback('🏠 К отчёту', `back_main_${jobId}`)],
    [Markup.button.callback('🔄 Новый товар', 'new_search')],
  ]);
  return { text: lines.join('\n'), keyboard };
}

export function buildWbDetail(product: any, jobId: string): { text: string; keyboard: any } {
  const x = buildDecisionContext(product);
  const lines = [
    '🔍 <b>Проверка рынка вручную</b>',
    '',
    'Автоматический WB-поиск больше не является обязательной частью анализа.',
    'Закупочный пакет готов даже без WB/Ozon-аналогов.',
    '',
    'Что можно сделать:',
    '1. Вручную найдите 3–5 конкурентов на WB/Ozon.',
    '2. Нажмите «🔍 Конкуренты вручную» или отправьте ссылки/цены.',
    '3. Бот посчитает сценарий по указанным конкурентам.',
    '',
    `Текущий статус: ${x.readiness.label}`,
    `Готовность к проверке: ${x.readiness.score}/100`,
  ];
  return { text: lines.join('\n'), keyboard: detailKeyboard(jobId) };
}

export function build1688Detail(product: any, jobId?: string): { text: string; keyboard: any } {
  return { text: render1688Detail(product), keyboard: jobId ? detailKeyboard(jobId) : undefined };
}

export function buildCargoDetail(product: any, jobId: string, sourceUrl = ''): { text: string; keyboard: any } {
  return { text: buildCargoBrief(product, sourceUrl), keyboard: detailKeyboard(jobId) };
}

export function buildInfographicDetail(product: any, jobId: string): { text: string; keyboard: any } {
  return { text: buildInfographicBrief(product), keyboard: detailKeyboard(jobId) };
}

export function buildRiskDetail(product: any, jobId: string): { text: string; keyboard: any } {
  return { text: buildRiskChecklist(product), keyboard: detailKeyboard(jobId) };
}

export function buildSampleDetail(product: any, jobId: string): { text: string; keyboard: any } {
  return { text: buildSampleRecommendation(product), keyboard: detailKeyboard(jobId) };
}

export function buildSafeSummary(product: any, reason?: string): string {
  return renderSafeSummary(product, reason);
}

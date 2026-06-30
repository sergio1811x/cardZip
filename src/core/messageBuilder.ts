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
    [Markup.button.callback('💬 Текст поставщику', `supplier_questions_${jobId}`), Markup.button.callback('📦 Данные товара', `product_detail_${jobId}`)],
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
  if (!x.price.canCalculateCost) {
    lines.push('Цена товара не подтверждена — себестоимость пока не считаю.');
    lines.push('', 'Что сделать сейчас: уточните цену выбранного SKU у поставщика.');
  } else {
    lines.push('<b>Цена товара</b>');
    lines.push(`${x.price.displayPriceText}${x.cost.purchaseRub ? ` ≈ ${x.cost.purchaseRub.toLocaleString('ru-RU')} ₽` : ''}`);
    lines.push('');
    lines.push('<b>Сейчас можно посчитать</b>');
    if (x.cost.purchaseRub) lines.push(`• товар: ${x.cost.purchaseRub.toLocaleString('ru-RU')} ₽`);
    if (x.cost.costWithoutCargoRub && x.cost.purchaseRub) {
      const overhead = x.cost.costWithoutCargoRub - x.cost.purchaseRub;
      lines.push(`• банк / подготовка / фулфилмент: ~${Math.max(0, overhead).toLocaleString('ru-RU')} ₽`);
      lines.push(`• итого без карго: ~${x.cost.costWithoutCargoRub.toLocaleString('ru-RU')} ₽ / шт`);
    }
    lines.push('');
    lines.push('<b>Пока не рассчитано</b>');
    if (!x.cost.cargoRub) lines.push('• карго — нет веса с упаковкой');
    else lines.push(`• карго: ~${x.cost.cargoRub.toLocaleString('ru-RU')} ₽`);
    lines.push('• ROI — рынок и цена продажи не заданы');
    if (x.weight.source === 'category_default') lines.push('• грубый ориентир веса не использую для финального расчёта');
    if (x.cost.warnings.length) lines.push('', ...x.cost.warnings.map((w) => `⚠️ ${w}`));
    lines.push('', '<b>Что сделать сейчас:</b> уточните вес у поставщика или укажите вес вручную.');
  }
  return {
    text: lines.join('\n'),
    keyboard: Markup.inlineKeyboard([
      [Markup.button.callback('⚖️ Указать вес', `weight_input:${jobId}`), Markup.button.callback('💬 Спросить поставщика', `supplier_questions_${jobId}`)],
      [Markup.button.callback('⬅️ Назад к плану', `proc_plan_${jobId}`), Markup.button.callback('🏠 К отчёту', `back_main_${jobId}`)],
      [Markup.button.callback('🔄 Новый товар', 'new_search')],
    ]),
  };
}

export function buildProcurementPlanDetail(product: any, jobId: string): { text: string; keyboard: any } {
  const x = buildDecisionContext(product);
  const flow = String(product?.procurementStatus ?? product?.procurement_status ?? '').toLowerCase();
  const questionsOpened = /questions_opened|waiting_supplier_reply|supplier_reply_added|supplier_reply_received|weight_added|sample_ordered|sample_received|ready_for_test_batch/.test(flow);
  const waitingReply = /questions_opened|waiting_supplier_reply/.test(flow);
  const replyReceived = !!product?.supplierAnswer || /supplier_reply_added|supplier_reply_received|weight_added|sample_ordered|sample_received|ready_for_test_batch/.test(flow);
  const hasWeight = x.weight.canUseForCargo;

  const productStatus = replyReceived
    ? (hasWeight ? '🧪 ответ получен, можно готовить образец' : '✅ ответ получен, нужен вес/габариты')
    : questionsOpened
      ? '⏳ ждём ответ поставщика'
      : '🟡 нужно запросить данные';

  const mainAction = replyReceived
    ? (hasWeight ? 'Откройте план образца и проверьте товар руками перед партией.' : 'Проверьте ответ поставщика. Если веса нет — укажите его вручную или запросите повторно.')
    : questionsOpened
      ? 'Когда поставщик ответит — нажмите «📥 Внести ответ» и вставьте текст.'
      : 'Нажмите «1️⃣ Отправить вопросы» и скопируйте текст в чат 1688.';

  const lines = [
    '🚀 <b>Дальнейший план закупки</b>',
    '',
    `Статус товара: ${productStatus}`,
    `Готовность: ${x.readiness.score}/100`,
    '',
    '<b>Сейчас главный шаг</b>',
    replyReceived ? (hasWeight ? '4️⃣ Заказать и проверить образец' : '3️⃣ Обновить себестоимость после веса') : questionsOpened ? '2️⃣ Внести ответ поставщика' : '1️⃣ Спросить поставщика',
    '',
    '<b>Зачем:</b>',
    replyReceived
      ? 'после ответа можно закрыть риски по цене, весу, упаковке и понять, готов ли товар к образцу.'
      : 'без веса, упаковки и точного SKU нельзя понять реальную себестоимость и безопасно заказать образец.',
    '',
    '<b>Что получим:</b>',
    '• цену выбранного SKU',
    '• вес с упаковкой',
    '• габариты упаковки',
    '• материал и комплектацию',
    '• реальные фото/видео, если поставщик их даст',
    '',
    '<b>Маршрут</b>',
    `${questionsOpened ? '✅' : '⏳'} 1. Отправить вопросы поставщику`,
    `${replyReceived ? '✅' : questionsOpened ? '⏳' : '🔒'} 2. Внести ответ поставщика`,
    `${hasWeight ? '✅' : replyReceived ? '⏳' : '🔒'} 3. Обновить себестоимость`,
    `${replyReceived || hasWeight ? '🧪' : '🔒'} 4. Заказать образец`,
    '⚪ 5. Принять решение: тестировать · доработать · не брать',
    '',
    '<b>Что сделать сейчас:</b>',
    mainAction,
  ];

  const rows: any[] = [];
  if (!questionsOpened) {
    rows.push([Markup.button.callback('1️⃣ Отправить вопросы', `supplier_questions_${jobId}`)]);
    rows.push([Markup.button.callback('📁 Материалы', `materials_${jobId}`), Markup.button.callback('🏠 К отчёту', `back_main_${jobId}`)]);
  } else if (!replyReceived) {
    rows.push([Markup.button.callback('📥 Внести ответ', `supplier_confirm_${jobId}`)]);
    rows.push([Markup.button.callback('💬 Показать вопросы', `supplier_questions_${jobId}`), Markup.button.callback('📁 Материалы', `materials_${jobId}`)]);
    rows.push([Markup.button.callback('🏠 К отчёту', `back_main_${jobId}`)]);
  } else {
    rows.push([Markup.button.callback('💸 Себестоимость', `econ_detail_${jobId}`), Markup.button.callback('🧪 План образца', `sample_detail_${jobId}`)]);
    rows.push([Markup.button.callback('⚖️ Указать вес вручную', `weight_input:${jobId}`), Markup.button.callback('📁 Материалы', `materials_${jobId}`)]);
    rows.push([Markup.button.callback('🏠 К отчёту', `back_main_${jobId}`)]);
  }
  rows.push([Markup.button.callback('🔄 Новый товар', 'new_search')]);
  return { text: lines.join('\n'), keyboard: Markup.inlineKeyboard(rows) };
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

import { Markup } from 'telegraf';
import { buildMainReportFromProfile } from './procurementProfile';
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
    [Markup.button.callback('⬅️ Назад', `back_main_${jobId}`)],
    [Markup.button.callback('🏠 К отчёту', `back_main_${jobId}`), Markup.button.callback('📁 Закупочный пакет', `materials_${jobId}`)],
    [Markup.button.callback('🔄 Новый товар', 'new_search')],
  ]);
}

function topLevelKeyboard(jobId: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('💬 Вопросы поставщику', `supplier_questions_${jobId}`)],
    [Markup.button.callback('📁 Закупочный пакет', `materials_${jobId}`), Markup.button.callback('📦 Данные товара', `product_detail_${jobId}`)],
    [Markup.button.callback('🔄 Новый товар', 'new_search')],
  ]);
}


export function buildMainMessage(product: any, jobId: string, status: any, _category?: any): { text: string; keyboard: any } {
  const text = buildMainReportFromProfile(product, { creditsRemaining: status?.creditsRemaining });
  const keyboard = topLevelKeyboard(jobId);
  return { text, keyboard };
}

export function buildMessage1(product: any): string {
  return buildMainReportFromProfile(product, undefined);
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
    lines.push('• продажную цену и рынок проверьте отдельно');
    if (x.weight.source === 'category_default') lines.push('• грубый ориентир веса не использую для финального расчёта');
    if (x.cost.warnings.length) lines.push('', ...x.cost.warnings.map((w) => `⚠️ ${w}`));
    lines.push('', '<b>Что сделать сейчас:</b> уточните вес у поставщика или укажите вес вручную.');
  }
  return {
    text: lines.join('\n'),
    keyboard: Markup.inlineKeyboard([
      [Markup.button.callback('⚖️ Указать вес', `weight_input:${jobId}`), Markup.button.callback('💬 Вопросы поставщику', `supplier_questions_${jobId}`)],
      [Markup.button.callback('⬅️ Назад', `back_main_${jobId}`), Markup.button.callback('🏠 К отчёту', `back_main_${jobId}`)],
      [Markup.button.callback('🔄 Новый товар', 'new_search')],
    ]),
  };
}

export function buildProcurementPlanDetail(product: any, jobId: string): { text: string; keyboard: any } {
  const x = buildDecisionContext(product);
  const lines = [
    '📁 <b>Закупочный пакет</b>',
    '',
    'Главная логика MVP проще: ссылка → разбор → вопросы поставщику → ZIP-пакет.',
    '',
    '<b>Что сделать сейчас:</b>',
    '1. Откройте вопросы поставщику.',
    '2. Отправьте текст в чат 1688.',
    '3. Скачайте закупочный пакет.',
    '',
    `Статус: ${x.price.canCalculateCost && x.weight.canUseForCargo ? '🟢 можно заказывать образец' : '🟡 нужны данные поставщика'}`,
  ];
  return {
    text: lines.join('\n'),
    keyboard: Markup.inlineKeyboard([
      [Markup.button.callback('💬 Вопросы поставщику', `supplier_questions_${jobId}`)],
      [Markup.button.callback('📁 Закупочный пакет', `materials_${jobId}`), Markup.button.callback('🏠 К отчёту', `back_main_${jobId}`)],
      [Markup.button.callback('🔄 Новый товар', 'new_search')],
    ]),
  };
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

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
  return Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', `back_main_${jobId}`), Markup.button.callback('📎 Файлы', `materials_${jobId}`)]]);
}

export function buildMainMessage(product: any, jobId: string, status: any, _category?: any): { text: string; keyboard: any } {
  const text = buildMainReport(product, { creditsRemaining: status?.creditsRemaining });
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('💬 Поставщику', 'supplier_questions'), Markup.button.callback('📥 Внести ответ', 'supplier_confirm')],
    [Markup.button.callback('⚖️ Указать вес', `weight_input:${jobId}`), Markup.button.callback('💰 Моя цена', `manual_price_${jobId}`)],
    [Markup.button.callback('📎 Файлы', `materials_${jobId}`), Markup.button.callback('📦 1688 детали', `product_detail_${jobId}`)],
    [Markup.button.callback('🔍 Конкуренты вручную', `manual_competitors_${jobId}`)],
  ]);
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
  const lines = ['💰 <b>Экономика без автоматического WB</b>', ''];
  if (!x.price.canCalculateCost) lines.push('Экономика не рассчитана — нет цены товара.');
  else {
    lines.push(`Цена: ${x.price.displayPriceText}`);
    if (x.cost.purchaseRub) lines.push(`Закупка: ${x.cost.purchaseRub.toLocaleString('ru-RU')} ₽`);
    if (x.cost.costWithoutCargoRub) lines.push(`Себестоимость без карго: ${x.cost.costWithoutCargoRub.toLocaleString('ru-RU')} ₽`);
    if (x.cost.cargoRub) lines.push(`Карго: ${x.cost.cargoRub.toLocaleString('ru-RU')} ₽`);
    else lines.push('Карго: не рассчитано — нужен вес с упаковкой.');
    if (x.cost.totalCostRub) lines.push(`Итого себестоимость: ${x.cost.totalCostRub.toLocaleString('ru-RU')} ₽`);
    if (x.cost.canShowRoi) {
      lines.push(`Сценарная прибыль: ${x.cost.scenarioProfitRub?.toLocaleString('ru-RU')} ₽`);
      lines.push(`Сценарный ROI: ${x.cost.scenarioRoiPercent}%`);
      lines.push('Это расчёт по цене, введённой пользователем, не подтверждённая рыночная цена.');
    } else {
      lines.push('ROI не считаю — введите предполагаемую цену продажи или добавьте конкурентов вручную.');
    }
    if (x.cost.warnings.length) lines.push('', ...x.cost.warnings.map((w) => `⚠️ ${w}`));
  }
  lines.push('', `Следующий шаг: ${x.cost.nextAction}`);
  return { text: lines.join('\n'), keyboard: detailKeyboard(jobId) };
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

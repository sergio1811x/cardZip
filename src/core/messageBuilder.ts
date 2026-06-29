import { Markup } from 'telegraf';
import { buildMainReport, build1688Detail as render1688Detail, buildSafeSummary as renderSafeSummary, buildDecisionContext } from './decisionLayer';

function detailKeyboard(jobId: string) {
  return Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', `back_main_${jobId}`), Markup.button.callback('📎 Файлы', `materials_${jobId}`)]]);
}

export function buildMainMessage(product: any, jobId: string, status: any, wbCategory?: any): { text: string; keyboard: any } {
  const text = buildMainReport(product, { creditsRemaining: status?.creditsRemaining }, wbCategory);
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('💬 Поставщику', `supplier_questions:${jobId}`), Markup.button.callback('📥 Внести ответ', `supplier_confirm:${jobId}`)],
    [Markup.button.callback('⚖️ Указать вес', `weight_input:${jobId}`), Markup.button.callback('📎 Файлы', `materials_${jobId}`)],
    [Markup.button.callback('🔎 WB детали', `wb_detail_${jobId}`), Markup.button.callback('📦 1688 детали', `product_detail_${jobId}`)],
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
  const lines = ['💰 <b>Экономика</b>', ''];
  if (!x.price.canCalculateCost) lines.push('Экономика не рассчитана — нет цены выбранного SKU.');
  else {
    lines.push(`Цена: ${x.price.displayPriceText}`);
    lines.push(`Вес: ${x.weight.reason}`);
    if (x.economy.costWithoutCargoRub) lines.push(`Себестоимость без карго: ${x.economy.costWithoutCargoRub.toLocaleString('ru-RU')} ₽`);
    if (x.economy.cargoRub) lines.push(`Карго: ${x.economy.cargoRub.toLocaleString('ru-RU')} ₽`);
    if (x.economy.costRub) lines.push(`Себестоимость: ${x.economy.costRub.toLocaleString('ru-RU')} ₽`);
    if (x.economy.canShowRoi) {
      lines.push(`Прибыль: ${x.economy.profitRub?.toLocaleString('ru-RU')} ₽`);
      lines.push(`ROI: ${x.economy.roiPercent}%`);
    } else {
      lines.push('ROI и маржу не считаю: нет полного набора подтверждённых данных.');
    }
    if (x.economy.warnings.length) lines.push('', ...x.economy.warnings.map((w) => `⚠️ ${w}`));
  }
  lines.push('', `Следующий шаг: ${x.economy.nextAction}`);
  return { text: lines.join('\n'), keyboard: detailKeyboard(jobId) };
}

export function buildWbDetail(product: any, jobId: string): { text: string; keyboard: any } {
  const x = buildDecisionContext(product);
  const lines = [
    '🔎 <b>Рынок WB</b>', '',
    `Статус: ${x.market.status}`,
    `Прямые локальные аналоги: ${x.market.confirmedDirectCount}`,
    `Похожие локальные: ${x.market.similarLocalCount}`,
    `Cross-border: ${x.market.crossBorderCount}`,
    `Category-only: ${x.market.categoryOnlyCount}`,
    `Всего кандидатов: ${x.market.rawCandidatesCount}`,
    '',
    x.market.canShowMedianPrice ? `Медиана: ${x.market.medianPriceRub?.toLocaleString('ru-RU')} ₽` : 'Медиану не показываю как рыночную цену: выборка прямых аналогов слабая.',
    '',
    x.market.reason,
  ];
  return { text: lines.join('\n'), keyboard: detailKeyboard(jobId) };
}

export function build1688Detail(product: any, jobId?: string): { text: string; keyboard: any } {
  return { text: render1688Detail(product), keyboard: jobId ? detailKeyboard(jobId) : undefined };
}

export function buildSafeSummary(product: any, reason?: string): string {
  return renderSafeSummary(product, reason);
}

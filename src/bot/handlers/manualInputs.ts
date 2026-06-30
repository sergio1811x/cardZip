import type { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { supabase } from '../../db/supabase';
import { redis } from '../../lib/redis';
import { buildDecisionContext } from '../../core/decisionLayer';
import { buildMainMessage } from '../../core/messageBuilder';

const KEY = (chatId: number) => `manual_input:${chatId}`;

type ManualInputState = {
  type: 'weight' | 'sale_price' | 'competitors';
  jobId: string;
  userId: string;
};

export async function handleManualWeightStart(ctx: Context): Promise<void> {
  const state = await stateFromCallback(ctx, /^weight_input:(.+)$/);
  if (!state) return;
  await saveState(ctx, { ...state, type: 'weight' });
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply(
    '⚖️ <b>Указать вес</b>\n\nВведите вес выбранного SKU с упаковкой.\n\nПримеры:\n• 0.42 кг\n• 420 г\n• 1,2 кг\n\nПосле ввода я обновлю:\n• предварительную себестоимость\n• карго\n• ТЗ байеру\n• ТЗ карго\n• чек-лист образца',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('⬅️ Назад к плану', `proc_plan_${state.jobId}`)],
        [Markup.button.callback('🏠 К отчёту', `back_main_${state.jobId}`), Markup.button.callback('🔄 Новый товар', 'new_search')],
      ]),
    }
  );
}

export async function handleManualSalePriceStart(ctx: Context): Promise<void> {
  const state = await stateFromCallback(ctx, /^manual_price_(.+)$/);
  if (!state) return;
  await saveState(ctx, { ...state, type: 'sale_price' });
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply(
    '💰 <b>Посчитать по моей цене</b>\n\nВведите предполагаемую цену продажи в ₽.\n\nПример: <b>1290</b>\n\nЯ посчитаю ориентир по вашей цене. Это не рыночная аналитика и не обещание прибыли.',
    { parse_mode: 'HTML' }
  );
}

export async function handleManualCompetitorsStart(ctx: Context): Promise<void> {
  const state = await stateFromCallback(ctx, /^manual_competitors_(.+)$/);
  if (!state) return;
  await saveState(ctx, { ...state, type: 'competitors' });
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply(
    '🔍 <b>Конкуренты вручную</b>\n\nВставьте 3–5 ссылок WB/Ozon и цены, если знаете.\n\nПример:\n1) https://www.wildberries.ru/... — 1290 ₽\n2) https://www.ozon.ru/... — 1490 ₽\n\nЕсли цену из ссылки не получится получить автоматически, я использую цены, которые вы указали в тексте.',
    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
  );
}

export async function getPendingManualInput(chatId: number): Promise<ManualInputState | null> {
  if (!redis) return null;
  const raw = await redis.get(KEY(chatId));
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw as any; } catch { return null; }
}

export async function handleManualInputText(ctx: Context, text: string): Promise<boolean> {
  const chatId = ctx.chat?.id;
  if (!chatId) return false;
  const state = await getPendingManualInput(chatId);
  if (!state) return false;
  if (redis) await redis.del(KEY(chatId));

  const { data: job } = await supabase
    .from('jobs')
    .select('id, result_json')
    .eq('id', state.jobId)
    .eq('user_id', state.userId)
    .single();

  if (!job?.result_json) {
    await ctx.reply('⚠️ Анализ не найден. Откройте последний отчёт через /last.');
    return true;
  }

  const result = job.result_json as any;
  const product = result.product ?? result.rawProduct;
  if (!product) {
    await ctx.reply('⚠️ Данные товара недоступны. Вернитесь к последнему отчёту или начните новый товар.');
    return true;
  }

  if (state.type === 'weight') {
    const weightKg = parseWeightKg(text);
    if (!weightKg) {
      await ctx.reply('Не понял вес. Напишите, например: 420 г или 0.42 кг.');
      return true;
    }
    product.manualWeightKg = weightKg;
    product.weightKg = weightKg;
    if (result.rawProduct) {
      result.rawProduct.manualWeightKg = weightKg;
      result.rawProduct.weightKg = weightKg;
      if (result.rawProduct.normalized1688) result.rawProduct.normalized1688.weightKg = weightKg;
    }
    await saveUpdatedJob(state.jobId, result, product);
    await ctx.reply(`✅ Вес сохранён: ${weightKg} кг. Пересчитываю отчёт...`);
    await sendUpdatedMain(ctx, product, state.jobId);
    return true;
  }

  if (state.type === 'sale_price') {
    const priceRub = parseRubPrice(text);
    if (!priceRub) {
      await ctx.reply('Не понял цену. Напишите цену продажи в ₽, например: 1290.');
      return true;
    }
    product.manualSalePriceRub = priceRub;
    result.manualSalePriceRub = priceRub;
    await saveUpdatedJob(state.jobId, result, product);
    await ctx.reply(`✅ Цена продажи сохранена: ${priceRub.toLocaleString('ru-RU')} ₽. Это сценарная цена, не подтверждённый рынок.`);
    await sendUpdatedMain(ctx, product, state.jobId);
    return true;
  }

  const prices = parseRubPrices(text);
  if (!prices.length) {
    await ctx.reply('Не нашёл цены конкурентов. Вставьте ссылки и цены, например: “WB — 1290 ₽, Ozon — 1490 ₽”.');
    return true;
  }
  const sorted = [...prices].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  product.manualCompetitors = { rawText: text.slice(0, 4000), pricesRub: prices, medianPriceRub: median, source: 'user_text' };
  product.manualSalePriceRub = median;
  result.manualCompetitors = product.manualCompetitors;
  result.manualSalePriceRub = median;
  await saveUpdatedJob(state.jobId, result, product);
  await ctx.reply(
    `✅ Принял конкурентов: ${prices.length} цен.\nМедиана по указанным вами конкурентам: ${median.toLocaleString('ru-RU')} ₽.\n\nЭто ручной сценарий, не автоматическая рыночная аналитика.`
  );
  await sendUpdatedMain(ctx, product, state.jobId);
  return true;
}

async function saveState(ctx: Context, state: ManualInputState): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId || !redis) return;
  await redis.set(KEY(chatId), JSON.stringify(state), { ex: 900 });
}

async function stateFromCallback(ctx: Context, re: RegExp): Promise<Omit<ManualInputState, 'type'> | null> {
  const userId = (ctx as any).dbUserId as string | undefined;
  const data = (ctx.callbackQuery as any)?.data ?? '';
  const match = data.match(re);
  if (!userId || !match?.[1]) return null;

  const { data: job } = await supabase
    .from('jobs')
    .select('id')
    .eq('id', match[1])
    .eq('user_id', userId)
    .single();
  if (!job) {
    await ctx.answerCbQuery('Анализ не найден').catch(() => {});
    return null;
  }
  return { jobId: match[1], userId };
}

async function saveUpdatedJob(jobId: string, result: any, product: any): Promise<void> {
  const decisionContext = buildDecisionContext(product);
  const procurementStatus = decisionContext.weight.canUseForCargo ? 'weight_added' : (product?.procurementStatus ?? result?.product?.procurementStatus ?? 'analyzed');
  await supabase.from('jobs').update({
    procurement_status: procurementStatus,
    procurement_score: decisionContext.readiness.score,
    procurement_pipeline: {
      product_data: true,
      sku_parsed: decisionContext.sku.skuCount > 0,
      weight_confirmed: decisionContext.weight.canUseForCargo,
      dimensions_confirmed: !!product?.supplierAnswer?.dimensions,
      supplier_reply_received: !!product?.supplierAnswer,
      sample_ordered: false,
      sample_checked: false,
      test_batch_ready: false,
    },
    result_json: { ...result, product: { ...product, procurementStatus }, decisionContext },
  }).eq('id', jobId);
}

async function sendUpdatedMain(ctx: Context, product: any, jobId: string): Promise<void> {
  const { text, keyboard } = buildMainMessage(product, jobId, {});
  await ctx.reply(text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...keyboard });
}

function parseWeightKg(text: string): number | null {
  const normalized = text.replace(',', '.').toLowerCase();
  const kg = normalized.match(/(\d+(?:\.\d+)?)\s*(?:кг|kg|кил)/i);
  if (kg) return roundKg(Number(kg[1]));
  const g = normalized.match(/(\d+(?:\.\d+)?)\s*(?:г|гр|gram|g)\b/i);
  if (g) return roundKg(Number(g[1]) / 1000);
  const n = Number(normalized.match(/\d+(?:\.\d+)?/)?.[0]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return roundKg(n > 20 ? n / 1000 : n);
}

function parseRubPrice(text: string): number | null {
  const prices = parseRubPrices(text);
  return prices[0] ?? null;
}

function parseRubPrices(text: string): number[] {
  const matches = text.match(/\d[\d\s]{1,8}(?:[,.]\d{1,2})?\s*(?:₽|руб|р\b)?/gi) ?? [];
  return matches
    .map((s) => Number(s.replace(/[^\d,.]/g, '').replace(',', '.')))
    .map((n) => Math.round(n))
    .filter((n) => Number.isFinite(n) && n >= 50 && n <= 500000);
}

function roundKg(n: number): number | null {
  if (!Number.isFinite(n) || n <= 0 || n > 200) return null;
  return Math.round(n * 1000) / 1000;
}

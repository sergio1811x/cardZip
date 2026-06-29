import type { Context } from 'telegraf';
import { supabase } from '../../db/supabase';
import { calcEconomics, calcBudgetScenarios, calcMaxPurchasePrice } from '../../core/economicsCalc';
import { buildConclusion } from '../../core/verdict';
import { buildRiskFlags } from '../../core/riskFlags';
import { buildMainMessage } from '../../core/messageBuilder';
import type { ProductWithContent } from '../../types';

export async function handleQuickTariff(ctx: Context) {
  const match = (ctx as any).match as RegExpMatchArray | undefined;
  if (!match) return;

  const type = match[1] as string;
  const value = parseFloat(match[2]);
  const jobId = match[3] as string;

  if (isNaN(value)) return;

  try {
    const { data: job } = await supabase.from('jobs').select('result_json').eq('id', jobId).single();
    if (!job?.result_json) {
      await ctx.answerCbQuery('Товар не найден');
      return;
    }

    const result = job.result_json as any;
    const raw = result.rawProduct;
    const product = result.product;
    if (!raw || !product) {
      await ctx.answerCbQuery('Данные не найдены');
      return;
    }

    const tariffs = {
      cargoPerKgUsd: type === 'cargo' ? value : undefined,
      fulfillmentRub: type === 'ff' ? value : undefined,
    };

    const wbFiltered = product.wbFiltered;
    const economics = await calcEconomics({
      platform: raw.platform,
      priceYuan: raw.priceYuan,
      weightKg: raw.weightKg,
      categoryHint: raw.categoryName,
      tariffs,
      ...(wbFiltered?.medianPrice > 0 ? { wbMedianPrice: wbFiltered.medianPrice } : {}),
    });

    const riskFlags = product.riskFlags ?? buildRiskFlags(raw, wbFiltered);
    const budgets = calcBudgetScenarios(economics.costRub, economics.weightMissing, raw.moq);
    const maxPurchasePrice = wbFiltered?.medianPrice
      ? calcMaxPurchasePrice(wbFiltered.medianPrice, raw.weightKg, economics.yuanToRub, tariffs, raw.priceYuan)
      : null;
    const conclusion = buildConclusion(raw.platform, economics, wbFiltered, riskFlags);

    const updatedProduct: ProductWithContent = {
      ...product,
      ...raw,
      economics,
      budgets,
      maxPurchasePrice,
      conclusion,
      riskFlags,
    };

    const { text: newText, keyboard } = buildMainMessage(updatedProduct, jobId, {});

    await ctx.editMessageText(newText, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...keyboard,
    });

    await ctx.answerCbQuery(`${type === 'cargo' ? 'Карго' : 'Фулфилмент'}: ${value}${type === 'cargo' ? '$/кг' : '₽'}`);
  } catch (e) {
    console.error('[quickTariff]', e);
    await ctx.answerCbQuery('Ошибка пересчёта').catch(() => {});
  }
}

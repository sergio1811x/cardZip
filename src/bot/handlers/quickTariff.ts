import type { Context } from 'telegraf';
import { supabase } from '../../db/supabase';
import { calcEconomics, calcBudgetScenarios, calcMaxPurchasePrice } from '../../core/economicsCalc';
import { buildConclusion } from '../../core/verdict';
import { buildRiskFlags } from '../../core/riskFlags';
import { buildMainMessage } from '../../core/messageBuilder';
import type { ProductWithContent } from '../../types';

function canUseWbMedian(wbFiltered: any): boolean {
  if (!wbFiltered || !(Number(wbFiltered.medianPrice) > 0)) return false;
  if (wbFiltered.marketConfirmed === false || wbFiltered.canUseForEconomics === false) return false;
  if (typeof wbFiltered.directAnalogsCount === 'number' && wbFiltered.directAnalogsCount < 3) return false;
  if (typeof wbFiltered.reliableCount === 'number' && wbFiltered.reliableCount < 3) return false;
  return true;
}

function parseQuickTariff(type: string, raw: string): number | null {
  const value = Number.parseFloat(String(raw).replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) return null;
  if (type === 'cargo') return value <= 30 ? value : null;
  if (type === 'ff') return value <= 1000 ? value : null;
  return null;
}

export async function handleQuickTariff(ctx: Context) {
  const userId = (ctx as any).dbUserId as string | undefined;
  if (!userId) return;

  const match = (ctx as any).match as RegExpMatchArray | undefined;
  if (!match) return;

  const type = match[1] as string;
  const value = parseQuickTariff(type, match[2]);
  const jobId = match[3] as string;

  if (value == null) {
    await ctx.answerCbQuery('Некорректное значение');
    return;
  }

  try {
    const { data: job } = await supabase
      .from('jobs')
      .select('result_json')
      .eq('id', jobId)
      .eq('user_id', userId)
      .single();

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
      ...(canUseWbMedian(wbFiltered) ? { wbMedianPrice: wbFiltered.medianPrice } : {}),
    });

    const riskFlags = product.riskFlags ?? buildRiskFlags(raw, wbFiltered);
    const budgets = calcBudgetScenarios(economics.costRub, economics.weightMissing, raw.moq);
    const maxPurchasePrice = canUseWbMedian(wbFiltered)
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

    await supabase.from('jobs').update({
      result_json: { ...result, product: updatedProduct },
    }).eq('id', jobId).eq('user_id', userId);

    const { text: newText, keyboard } = buildMainMessage(updatedProduct, jobId);

    await ctx.editMessageText(newText, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...keyboard,
    }).catch(() => ctx.reply(newText, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...keyboard }));

    await ctx.answerCbQuery(`${type === 'cargo' ? 'Карго' : 'Фулфилмент'}: ${value}${type === 'cargo' ? '$/кг' : '₽'}`);
  } catch (e) {
    console.error('[quickTariff]', e);
    await ctx.answerCbQuery('Ошибка пересчёта').catch(() => {});
  }
}

import type { Context } from 'telegraf';
import { supabase } from '../../db/supabase';
import { calcEconomics, calcTestPurchase } from '../../core/economicsCalc';
import { buildVerdict } from '../../core/verdict';
import { buildRiskFlags } from '../../core/riskFlags';
import { filterWbData } from '../../core/wbFilter';
import { buildMessage1, buildEconomicsKeyboard } from '../../core/messageBuilder';
import type { ProductWithContent, WbFilterKeywords } from '../../types';

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
    const seoContent = result.seoContent ?? result.product?.seoContent;
    const product = result.product;
    if (!raw || !product) {
      await ctx.answerCbQuery('Данные не найдены');
      return;
    }

    // Пересчёт с новым тарифом
    const tariffs = {
      cargoPerKgUsd: type === 'cargo' ? value : undefined,
      fulfillmentRub: type === 'ff' ? value : undefined,
    };

    const wbFiltered = product.wbFiltered;
    const economics = await calcEconomics({
      priceYuan: raw.priceYuan,
      weightKg: raw.weightKg,
      categoryHint: raw.categoryName,
      tariffs,
      ...(wbFiltered?.medianPrice > 0 ? { wbMedianPrice: wbFiltered.medianPrice } : {}),
    });

    const riskFlags = product.riskFlags ?? buildRiskFlags(raw, wbFiltered);
    const testPurchase = calcTestPurchase(economics.costRub, economics.weightMissing, raw.moq);
    const { score, verdict } = buildVerdict(economics, wbFiltered, riskFlags);

    const updatedProduct: ProductWithContent = {
      ...product,
      ...raw,
      economics,
      testPurchase,
      score,
      verdict,
      riskFlags,
    };

    const newText = buildMessage1(updatedProduct);
    const keyboard = buildEconomicsKeyboard(jobId);

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

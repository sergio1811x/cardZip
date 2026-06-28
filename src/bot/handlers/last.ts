import type { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { supabase } from '../../db/supabase';
import { track } from '../../services/analyticsService';
import { formatWeightKg, formatRubPrice } from '../../lib/formatters';
import { resolvePurchasePrice } from '../../core/priceResolver';

export async function handleLast(ctx: Context): Promise<void> {
  const userId = (ctx as any).dbUserId as string | undefined;
  if (!userId) return;

  track(userId, 'last_used');

  // Read from the last completed job — single source of truth
  const { data: lastJob } = await supabase
    .from('jobs')
    .select('id, result_json, created_at')
    .eq('user_id', userId)
    .in('status', ['done', 'sent', 'qa_pending'])
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (!lastJob?.result_json) {
    await ctx.reply('У вас пока нет завершённых анализов. Отправьте ссылку на товар с 1688.');
    return;
  }

  const result = lastJob.result_json as any;
  const raw = result.rawProduct;
  const product = result.product;

  if (!raw) {
    await ctx.reply('Данные последнего анализа не найдены. Отправьте ссылку заново.');
    return;
  }

  // Use the same price resolver as the main card
  const resolved = resolvePurchasePrice(raw);
  const priceLabel = resolved.displayLabel;
  const weightLabel = formatWeightKg(raw.weightKg);

  // WB market data from the saved analysis (same source as main card)
  const wbFiltered = product?.wbFiltered;
  const wbMedian = wbFiltered?.medianPrice;
  const marketConfirmed = wbFiltered?.marketConfirmed !== false && wbFiltered?.canUseForEconomics !== false;

  const title = product?.titleRu || raw.titleCn || raw.productId;
  const date = new Date(lastJob.created_at).toLocaleDateString('ru-RU');

  const lines: string[] = [];
  lines.push(`📋 <b>Последний анализ</b>`);
  lines.push('');
  lines.push(`<b>${escHtml(title)}</b>`);
  lines.push('');
  lines.push(`Цена: ${priceLabel}`);
  lines.push(`Вес: ${weightLabel}`);
  if (marketConfirmed && wbMedian && wbMedian > 0) {
    lines.push(`Медиана WB: ${formatRubPrice(wbMedian)}`);
  } else if (wbMedian && wbMedian > 0) {
    lines.push('WB-цена: не подтверждена прямыми аналогами');
  }

  // Economics summary from saved data
  const economics = product?.economics;
  if (economics?.costRub > 0) {
    const prefix = economics.weightMissing ? '~' : '';
    lines.push(`Себестоимость: ${prefix}${formatRubPrice(economics.costRub)}`);
    if (marketConfirmed && economics.roiPercent && !economics.isSyntheticPrice && !economics.weightMissing && economics.canShowRoi !== false) {
      lines.push(`ROI: ${economics.roiPercent}%`);
    }
  }

  lines.push('');
  lines.push(`Анализ от ${date}`);

  const buttons: any[][] = [
    [
      Markup.button.callback('📦 Данные 1688', `product_detail_${lastJob.id}`),
      Markup.button.callback('🔎 WB-рынок', `wb_detail_${lastJob.id}`),
    ],
    [
      Markup.button.callback('💰 Экономика', `econ_detail_${lastJob.id}`),
      Markup.button.callback('💬 Поставщику', 'supplier_questions'),
    ],
    [
      Markup.button.callback('📎 Файлы', `materials_${lastJob.id}`),
      Markup.button.callback('🔄 Новый товар', 'new_search'),
    ],
  ];

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons),
  });
}

function escHtml(str: unknown): string {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

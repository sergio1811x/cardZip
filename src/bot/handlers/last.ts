import type { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { supabase } from '../../db/supabase';
import { track } from '../../services/analyticsService';
import { buildDecisionContext } from '../../core/decisionLayer';

export async function handleLast(ctx: Context): Promise<void> {
  const userId = (ctx as any).dbUserId as string | undefined;
  if (!userId) return;

  track(userId, 'last_used');

  const { data: lastJob } = await supabase
    .from('jobs')
    .select('id, result_json, created_at')
    .eq('user_id', userId)
    .in('status', ['done', 'sent'])
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (!lastJob?.result_json) {
    await ctx.reply('У вас пока нет завершённых анализов. Отправьте ссылку на товар с 1688.');
    return;
  }

  const result = lastJob.result_json as any;
  const raw = result.rawProduct;
  const product = result.product ?? raw;

  if (!raw && !product) {
    await ctx.reply('Данные последнего анализа не найдены. Отправьте ссылку заново.');
    return;
  }

  const x = buildDecisionContext(product);
  const title = x.intelligence.cleanTitles?.titleForReport || product?.titleRu || raw?.titleCn || raw?.productId || 'Товар';
  const date = new Date(lastJob.created_at).toLocaleDateString('ru-RU');

  const lines: string[] = [];
  lines.push('📋 <b>Последний анализ</b>');
  lines.push('');
  lines.push(`<b>${escHtml(title)}</b>`);
  lines.push('');
  lines.push(`Цена: ${escHtml(x.price.displayPriceText)}`);
  lines.push(`SKU: ${escHtml(x.sku.skuSummary)}`);
  lines.push(`Вес: ${escHtml(x.weight.displayText)}`);
  lines.push(`${escHtml(x.readiness.label)} · готовность ${x.readiness.score}/100`);

  if (x.cost.purchaseRub) {
    lines.push(`Закупка: ${fmtRub(x.cost.purchaseRub)}`);
  }
  if (x.cost.costWithoutCargoRub) {
    lines.push(`Себестоимость без карго: ${fmtRub(x.cost.costWithoutCargoRub)}`);
  }
  lines.push('Следующий шаг: открыть дальнейший план и отправить вопросы поставщику.');

  lines.push('');
  lines.push(`Анализ от ${date}`);

  const buttons: any[][] = [
    [Markup.button.callback('🚀 Дальнейший план', `proc_plan_${lastJob.id}`)],
    [
      Markup.button.callback('💬 Текст поставщику', `supplier_questions_${lastJob.id}`),
      Markup.button.callback('📦 Данные товара', `product_detail_${lastJob.id}`),
    ],
    [
      Markup.button.callback('📁 Материалы', `materials_${lastJob.id}`),
      Markup.button.callback('🔄 Новый товар', 'new_search'),
    ],
  ];

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons),
  });
}

function fmtRub(n: number): string {
  return `${Math.round(n).toLocaleString('ru-RU')} ₽`;
}

function escHtml(str: string): string {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

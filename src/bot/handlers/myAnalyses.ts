import type { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { getUserAnalyses } from '../../db/queries/jobs';
import { track } from '../../services/analyticsService';
import { buildDecisionContext } from '../../core/decisionLayer';

const PAGE_SIZE = 5;

export async function handleMyAnalyses(ctx: Context, page = 0): Promise<void> {
  const userId = (ctx as any).dbUserId as string | undefined;
  if (!userId) return;

  track(userId, 'my_analyses' as any);

  const analyses = await getUserAnalyses(userId, PAGE_SIZE + 1, page * PAGE_SIZE);
  if (analyses.length === 0 && page === 0) {
    await ctx.reply('У вас пока нет анализов. Отправьте ссылку на товар — и он появится здесь.');
    return;
  }

  const hasMore = analyses.length > PAGE_SIZE;
  const items = analyses.slice(0, PAGE_SIZE);

  const lines = items.map((a, i) => {
    const num = page * PAGE_SIZE + i + 1;
    const result = a.result_json as any;
    const product = result?.product ?? result?.rawProduct;
    const x = product ? buildDecisionContext(product) : null;
    const title = x?.intelligence.cleanTitles?.titleForReport || product?.titleRu || extractDomain(a.input_url);
    const date = new Date(a.created_at).toLocaleDateString('ru-RU');
    const price = x?.price?.displayPriceText ? ` · ${stripPricePrefix(x.price.displayPriceText)}` : '';
    const readiness = x?.readiness ? ` · ${x.readiness.score}/100` : '';

    return `${num}. <b>${escHtml(truncate(title, 40))}</b>\n` +
      `   ${date}${price}${readiness}`;
  });

  const text = `📊 <b>Мои анализы</b> (последние 30 дней)\n\n${lines.join('\n\n')}`;

  const buttons = items.map((a, i) => {
    const result = a.result_json as any;
    const product = result?.product ?? result?.rawProduct;
    const title = product ? (buildDecisionContext(product).intelligence.cleanTitles?.titleForReport ?? `Анализ ${i + 1}`) : `Анализ ${i + 1}`;
    const label = truncate(title || `Анализ ${i + 1}`, 30);
    return [Markup.button.callback(`📋 ${label}`, `analysis_${a.id}`)];
  });

  const navRow = [];
  if (page > 0) navRow.push(Markup.button.callback('⬅️ Назад', `analyses_page_${page - 1}`));
  if (hasMore) navRow.push(Markup.button.callback('➡️ Далее', `analyses_page_${page + 1}`));
  if (navRow.length) buttons.push(navRow);

  const keyboard = Markup.inlineKeyboard(buttons);

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() =>
      ctx.reply(text, { parse_mode: 'HTML', ...keyboard })
    );
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
  }
}

export async function handleAnalysisDetail(ctx: Context): Promise<void> {
  const userId = (ctx as any).dbUserId as string | undefined;
  if (!userId) return;

  const match = (ctx.callbackQuery as any)?.data?.match(/^analysis_(.+)$/);
  if (!match) return;

  const jobId = match[1];

  const { supabase } = require('../../db/supabase');
  const { data: job } = await supabase
    .from('jobs')
    .select('id, input_url, result_json, telegram_file_ids, created_at')
    .eq('id', jobId)
    .eq('user_id', userId)
    .single();

  if (!job) {
    await ctx.answerCbQuery('Анализ не найден');
    return;
  }

  const result = job.result_json as any;
  const product = result?.product ?? result?.rawProduct;
  if (!product) {
    await ctx.answerCbQuery('Данные недоступны');
    return;
  }

  const x = buildDecisionContext(product);
  const date = new Date(job.created_at).toLocaleDateString('ru-RU');

  let text = `📋 <b>${escHtml(x.intelligence.cleanTitles?.titleForReport || 'Товар')}</b>\n\n`;
  text += `🔗 ${escHtml(job.input_url)}\n`;
  text += `📅 ${date}\n\n`;
  text += `Цена: ${escHtml(x.price.displayPriceText)}\n`;
  text += `SKU: ${escHtml(x.sku.skuSummary)}\n`;
  text += `Вес: ${escHtml(x.weight.displayText)}\n`;
  text += `${escHtml(x.readiness.label)} · готовность ${x.readiness.score}/100\n`;

  if (x.cost.costWithoutCargoRub) {
    text += `Себестоимость без карго: ${fmtRub(x.cost.costWithoutCargoRub)}\n`;
  }
  text += 'Следующий шаг: открыть дальнейший план и отправить вопросы поставщику.\n';

  if (x.readiness.nextActions.length) {
    text += '\nЧто сделать:\n' + x.readiness.nextActions.slice(0, 3).map((a, i) => `${i + 1}. ${escHtml(a)}`).join('\n');
  }

  const buttons = [];
  buttons.push([Markup.button.callback('🚀 Дальнейший план', `proc_plan_${job.id}`)]);
  buttons.push([Markup.button.callback('💬 Текст поставщику', `supplier_questions_${job.id}`), Markup.button.callback('📦 Данные товара', `product_detail_${job.id}`)]);
  buttons.push([Markup.button.callback('📁 Материалы', `materials_${job.id}`)]);
  buttons.push([Markup.button.callback('⬅️ К списку', 'my_analyses')]);

  const keyboard = Markup.inlineKeyboard(buttons);

  await ctx.editMessageText(text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...keyboard,
  }).catch(() => ctx.reply(text, { parse_mode: 'HTML', ...keyboard }));
}

function escHtml(str: string): string {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

function extractDomain(url: string): string {
  try { return new URL(url).hostname; } catch { return url.slice(0, 30); }
}

function fmtRub(n: number): string {
  return Math.round(n).toLocaleString('ru-RU') + ' ₽';
}

function stripPricePrefix(s: string): string {
  return s.replace(/^Цена:\s*/i, '').replace(/^Цена по SKU:\s*/i, '').replace(/^Цена выбранного SKU:\s*/i, '').slice(0, 28);
}

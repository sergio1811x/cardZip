import type { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { getUserAnalyses } from '../../db/queries/jobs';
import { track } from '../../services/analyticsService';
import type { ProductWithContent } from '../../types';

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
    const product = (a.result_json as any)?.product as ProductWithContent | undefined;
    const title = product?.titleRu || extractDomain(a.input_url);
    const date = new Date(a.created_at).toLocaleDateString('ru-RU');
    const priceValue = Number(product?.priceYuan);
    const price = Number.isFinite(priceValue) && priceValue > 0 ? `${priceValue} ¥` : '';
    const platform = product?.platform?.toUpperCase() ?? '';

    return `${num}. <b>${escHtml(truncate(title, 40))}</b>\n` +
      `   ${platform} ${price ? '· ' + price : ''} · ${date}`;
  });

  let text = `📊 <b>Мои анализы</b> (последние 30 дней)\n\n${lines.join('\n\n')}`;

  const buttons = items.map((a, i) => {
    const product = (a.result_json as any)?.product as ProductWithContent | undefined;
    const label = truncate(product?.titleRu || `Анализ ${i + 1}`, 30);
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

  const product = (job.result_json as any)?.product as ProductWithContent | undefined;
  if (!product) {
    await ctx.answerCbQuery('Данные недоступны');
    return;
  }

  const date = new Date(job.created_at).toLocaleDateString('ru-RU');
  const eco = product.economics;

  let text = `📋 <b>${escHtml(product.titleRu || 'Товар')}</b>\n\n`;
  text += `🔗 ${escHtml(job.input_url)}\n`;
  text += `📅 ${date}\n`;
  text += `🏷 ${product.platform?.toUpperCase() ?? ''}\n\n`;

  if (product.priceYuan) text += `Цена: ${product.priceYuan} ¥\n`;
  if (product.weightKg) text += `Вес: ${product.weightKg} кг\n`;

  if (eco) {
    if (eco.costRub) text += `Себестоимость: ${fP(eco.costRub)}\n`;
    if (eco.grossProfitRub) text += `Прибыль: ${fP(eco.grossProfitRub)}\n`;
    if (eco.roiPercent) text += `ROI: ${eco.roiPercent}%\n`;
  }

  if (product.conclusion) {
    text += `\n${product.conclusion.icon} ${escHtml(product.conclusion.headline)}\n`;
  }

  const buttons = [];
  buttons.push([Markup.button.callback('📎 Файлы', `materials_${job.id}`)]);
  buttons.push([Markup.button.callback('⬅️ К списку', 'my_analyses')]);

  const keyboard = Markup.inlineKeyboard(buttons);

  await ctx.editMessageText(text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...keyboard,
  }).catch(() => ctx.reply(text, { parse_mode: 'HTML', ...keyboard }));
}


function escHtml(str: unknown): string {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(str: string | undefined, max: number): string {
  str = String(str ?? '');
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

function extractDomain(url: string): string {
  try { return new URL(url).hostname; } catch { return url.slice(0, 30); }
}

function fP(n: number): string {
  return Math.round(Number(n) || 0).toLocaleString('ru-RU') + ' ₽';
}

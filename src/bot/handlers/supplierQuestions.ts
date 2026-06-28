import { Markup } from 'telegraf';
import type { Context } from 'telegraf';
import { supabase } from '../../db/supabase';
import { getCategoryRules, detectCategoryFromAttributes, type ProductCategoryType } from '../../core/categoryRules';
import { resolvePurchasePrice } from '../../core/priceResolver';

async function findLastJob(userId: string) {
  const { data } = await supabase
    .from('jobs')
    .select('result_json')
    .eq('user_id', userId)
    .in('status', ['done', 'sent', 'qa_pending'])
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  return data;
}

function escHtml(str: unknown): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function cleanQuestion(q: unknown): string {
  return escHtml(String(q ?? '')
    .replace(/\b(undefined|null|NaN)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim());
}

function dedupeQuestions(questions: unknown[], limit = 8): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of questions) {
    const q = cleanQuestion(raw).replace(/[.。?？]+$/g, '').trim();
    if (!q) continue;
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
    if (out.length >= limit) break;
  }
  return out;
}

function getPriceLabel(data: any, product: any): string | null {
  try {
    const resolved = resolvePurchasePrice(data.rawProduct ?? product ?? {});
    return resolved.valueCny && resolved.valueCny > 0 ? resolved.displayLabel : null;
  } catch {
    const price = Number(product?.priceYuan ?? data.rawProduct?.priceYuan);
    return Number.isFinite(price) && price > 0 ? `${price} ¥` : null;
  }
}

export async function handleSupplierQuestions(ctx: Context) {
  const userId = (ctx as any).dbUserId as string | undefined;
  if (!userId) {
    await ctx.reply('❌ Не удалось определить пользователя. Попробуй /start');
    return;
  }

  await ctx.reply(
    '📩 <b>Вопросы поставщику</b>\n\n' +
    'Скопируйте и отправьте поставщику на 1688.\n' +
    'Выберите язык:',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🇷🇺 На русском', 'sq_ru'), Markup.button.callback('🇨🇳 На китайском', 'sq_cn')],
      ]),
    }
  );
}

export async function handleSupplierQuestionsLang(ctx: Context) {
  const userId = (ctx as any).dbUserId as string | undefined;
  if (!userId) {
    await ctx.reply('❌ Не удалось определить пользователя.');
    return;
  }

  const match = (ctx as any).match as RegExpMatchArray | undefined;
  const lang = match?.[1] as 'ru' | 'cn' | undefined;
  if (!lang) return;

  try {
    const lastJob = await findLastJob(userId);
    if (!lastJob?.result_json) {
      await ctx.reply('Нет сохранённых товаров. Отправь ссылку на товар с 1688.');
      return;
    }

    const data = lastJob.result_json as any;
    const product = data.product;

    const catType: ProductCategoryType = product?.categoryType ??
      detectCategoryFromAttributes(
        product?.categoryName ?? data.rawProduct?.categoryName,
        product?.attributes ?? data.rawProduct?.attributes ?? [],
        product?.titleCn ?? data.rawProduct?.titleCn ?? '',
      );

    const rules = getCategoryRules(catType);
    const priceStr = getPriceLabel(data, product);
    const intel = product?.intelligence;

    let text: string;
    if (intel?.supplierQuestions?.ru?.length && lang === 'ru') {
      const lines = ['📩 <b>Что уточнить у поставщика</b>', ''];
      lines.push(priceStr
        ? `1. Подтвердите цену ${escHtml(priceStr)} для выбранного варианта и MOQ.`
        : '1. Укажите цену выбранного варианта и MOQ.');
      dedupeQuestions(intel.supplierQuestions.ru).forEach((q, i) => lines.push(`${i + 2}. ${q}`));
      text = lines.join('\n');
    } else if (intel?.supplierQuestions?.cn?.length && lang === 'cn') {
      const lines = ['📩 <b>发给供应商的问题</b>', ''];
      lines.push(priceStr
        ? `1. 请确认所选颜色和尺码在起订量下的价格是否为 ${escHtml(priceStr.replace('¥', '元'))}？`
        : '1. 请告诉我所选颜色和尺码的价格和起订量。');
      dedupeQuestions(intel.supplierQuestions.cn).forEach((q, i) => lines.push(`${i + 2}. ${q}`));
      text = lines.join('\n');
    } else if (lang === 'ru') {
      const lines = ['📩 <b>Что уточнить у поставщика</b>', ''];
      lines.push('Здравствуйте. Хотим уточнить товар перед заказом:', '');
      lines.push(priceStr
        ? `1. Подтвердите цену ${escHtml(priceStr)} для выбранного цвета/размера и MOQ.`
        : '1. Укажите цену выбранного цвета/размера и MOQ.');
      dedupeQuestions(rules.supplierQuestions.ru).forEach((q, i) => {
        lines.push(`${i + 2}. ${q[0]?.toUpperCase() ?? ''}${q.slice(1)}.`);
      });
      text = lines.join('\n');
    } else {
      const lines = ['📩 <b>发给供应商的问题</b>', ''];
      lines.push('您好，我们想下单前确认一下这个产品：', '');
      lines.push(priceStr
        ? `1. 请确认所选颜色和尺码在起订量下的价格是否为 ${escHtml(priceStr.replace('¥', '元'))}？`
        : '1. 请告诉我所选颜色和尺码的价格和起订量。');
      dedupeQuestions(rules.supplierQuestions.cn).forEach((q, i) => {
        lines.push(`${i + 2}. ${q}`);
      });
      text = lines.join('\n');
    }

    const afterText = text + '\n\nПосле ответа поставщика нажмите 📥';
    await ctx.reply(afterText, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📥 Внести ответ поставщика', 'supplier_confirm')],
      ]),
    });
  } catch (e) {
    console.error('[supplier_questions]', e);
    await ctx.reply('❌ Не удалось сформировать вопросы. Попробуйте позже.');
  }
}

import { Markup } from 'telegraf';
import type { Context } from 'telegraf';
import { supabase } from '../../db/supabase';
import { buildRiskFlags } from '../../core/riskFlags';
import { buildFallbackQuestions, formatQuestionsRu, formatQuestionsCn } from '../../core/supplierQuestions';
import type { RawProduct1688, SupplierQuestions, WbFilteredResult } from '../../types';

async function findLastJob(userId: string) {
  const { data } = await supabase
    .from('jobs')
    .select('result_json')
    .eq('user_id', userId)
    .in('status', ['done', 'sent'])
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  return data;
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

    // Приоритет: AI-сгенерированные вопросы
    const aiQuestions: SupplierQuestions | undefined =
      product?.seoContent?.supplierQuestions ??
      data.seoContent?.supplierQuestions;

    let questions: SupplierQuestions;

    if (aiQuestions?.ru?.length && aiQuestions?.cn?.length) {
      questions = aiQuestions;
    } else {
      const raw: Partial<RawProduct1688> = product ?? data.rawProduct ?? {};
      const wbFiltered: WbFilteredResult | null = product?.wbFiltered ?? null;
      const flags = buildRiskFlags(raw as RawProduct1688, wbFiltered);
      questions = buildFallbackQuestions(flags);
    }

    const text = lang === 'ru' ? formatQuestionsRu(questions) : formatQuestionsCn(questions);
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

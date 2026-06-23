import { Markup } from 'telegraf';
import type { Context } from 'telegraf';
import { findLastProductByUser } from '../../db/queries/products';
import { buildRiskFlags } from '../../core/riskFlags';
import { buildFallbackQuestions, formatQuestionsRu, formatQuestionsCn } from '../../core/supplierQuestions';
import type { RawProduct1688, SupplierQuestions, WbFilteredResult } from '../../types';

export async function handleSupplierQuestions(ctx: Context) {
  const userId = (ctx as any).dbUserId as string | undefined;
  if (!userId) {
    await ctx.reply('❌ Не удалось определить пользователя. Попробуй /start');
    return;
  }

  await ctx.reply(
    '📩 Выберите язык вопросов:',
    Markup.inlineKeyboard([
      [Markup.button.callback('🇷🇺 Русский', 'sq_ru')],
      [Markup.button.callback('🇨🇳 中文', 'sq_cn')],
    ])
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
    const lastProduct = await findLastProductByUser(userId);
    if (!lastProduct) {
      await ctx.reply('Нет сохранённых товаров. Отправь ссылку на товар с 1688.');
      return;
    }

    const data = lastProduct.data_json as any;

    // Приоритет: AI-сгенерированные вопросы из seoContent
    const aiQuestions: SupplierQuestions | undefined =
      data?.seoContent?.supplierQuestions ??
      data?.product?.seoContent?.supplierQuestions;

    let questions: SupplierQuestions;

    if (aiQuestions?.ru?.length && aiQuestions?.cn?.length) {
      questions = aiQuestions;
    } else {
      // Fallback: генерируем из riskFlags
      const raw: Partial<RawProduct1688> = data?.rawProduct ?? data ?? {};
      const wbFiltered: WbFilteredResult | null = data?.wbFiltered ?? data?.product?.wbFiltered ?? null;
      const flags = buildRiskFlags(raw as RawProduct1688, wbFiltered);
      questions = buildFallbackQuestions(flags);
    }

    const text = lang === 'ru' ? formatQuestionsRu(questions) : formatQuestionsCn(questions);
    await ctx.reply(text, { parse_mode: 'HTML' });
  } catch (e) {
    console.error('[supplier_questions]', e);
    await ctx.reply('❌ Не удалось сформировать вопросы. Попробуйте позже.');
  }
}

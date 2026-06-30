import { Markup } from 'telegraf';
import type { Context } from 'telegraf';
import { supabase } from '../../db/supabase';
import { buildSupplierQuestions, buildDecisionContext } from '../../core/decisionLayer';

async function findJob(userId: string, jobId?: string) {
  let query = supabase
    .from('jobs')
    .select('id, result_json, procurement_status')
    .eq('user_id', userId)
    .in('status', ['done', 'sent']);

  if (jobId) {
    const { data } = await query.eq('id', jobId).single();
    return data;
  }

  const { data } = await query
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  return data;
}

function callbackJobId(ctx: Context): string | undefined {
  const match = (ctx as any).match as RegExpMatchArray | undefined;
  return match?.[1] || match?.[2];
}

export async function handleSupplierQuestions(ctx: Context) {
  const userId = (ctx as any).dbUserId as string | undefined;
  if (!userId) {
    await ctx.reply('Не удалось определить пользователя. Нажмите /start и попробуйте снова.');
    return;
  }

  const jobId = callbackJobId(ctx);
  const job = await findJob(userId, jobId).catch(() => null);
  if (jobId && !job) {
    await ctx.reply('⚠️ Товар не найден. Вернитесь к отчёту или начните новый товар.', {
      ...Markup.inlineKeyboard([[Markup.button.callback('🔄 Новый товар', 'new_search')]]),
    });
    return;
  }

  await ctx.reply(
    '💬 <b>Текст поставщику</b>\n\n' +
    'Сейчас главный шаг — отправить вопросы поставщику в чат 1688.\n\n' +
    'Зачем это нужно:\n' +
    '• подтвердить цену выбранного SKU\n' +
    '• получить вес и габариты упаковки\n' +
    '• проверить материал, комплектацию и реальные фото\n\n' +
    'Выберите язык. После ответа поставщика нажмите «📥 Внести ответ».',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('🇷🇺 Русский текст', job?.id ? `sq_ru_${job.id}` : 'sq_ru'),
          Markup.button.callback('🇨🇳 Китайский текст', job?.id ? `sq_cn_${job.id}` : 'sq_cn'),
        ],
        ...(job?.id ? [[Markup.button.callback('⬅️ Назад к плану', `proc_plan_${job.id}`), Markup.button.callback('🏠 К отчёту', `back_main_${job.id}`)]] : []),
        [Markup.button.callback('🔄 Новый товар', 'new_search')],
      ]),
    }
  );
}

export async function handleSupplierQuestionsLang(ctx: Context) {
  const userId = (ctx as any).dbUserId as string | undefined;
  if (!userId) {
    await ctx.reply('Не удалось определить пользователя. Нажмите /start и попробуйте снова.');
    return;
  }

  const match = (ctx as any).match as RegExpMatchArray | undefined;
  const lang = match?.[1] as 'ru' | 'cn' | undefined;
  const jobId = match?.[2];
  if (!lang) return;

  try {
    const job = await findJob(userId, jobId);
    if (!job?.result_json) {
      await ctx.reply('Нет сохранённых товаров. Отправь ссылку на товар с 1688.');
      return;
    }

    const data = job.result_json as any;
    const product = data.product ?? data.rawProduct;
    const x = buildDecisionContext(product ?? {});
    const questionSet = buildSupplierQuestions(product ?? {});
    const questions = (lang === 'cn' ? questionSet.cn : questionSet.ru).slice(0, 12);

    let text: string;
    if (lang === 'cn') {
      text = [
        '📩 <b>发给供应商的问题</b>',
        '',
        '您好，我们想下单前确认一下这个产品：',
        '',
        ...questions.map((q: string, i: number) => `${i + 1}. ${q.replace(/^\d+[.)]\s*/, '')}`),
      ].join('\n');
    } else {
      text = [
        '📩 <b>Что уточнить у поставщика</b>',
        '',
        'Здравствуйте. Хотим уточнить товар перед заказом:',
        '',
        ...questions.map((q: string, i: number) => `${i + 1}. ${q.replace(/^\d+[.)]\s*/, '')}`),
        '',
        `Товар: ${x.title}`,
      ].join('\n');
    }

    // Mark the product as waiting for supplier reply once the user opens the ready-to-send text.
    try {
      const updatedProduct = { ...(product ?? {}), procurementStatus: 'waiting_supplier_reply' };
      await supabase.from('jobs').update({
        procurement_status: 'waiting_supplier_reply',
        result_json: { ...data, product: updatedProduct },
      }).eq('id', job.id).eq('user_id', userId);
    } catch {}

    const afterText = text + '\n\nПосле ответа поставщика нажмите «📥 Внести ответ» — обновлю закупочный пакет.';
    await ctx.reply(afterText, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Я отправил вопросы / жду ответ', `proc_plan_${job.id}`)],
        [Markup.button.callback('📥 Внести ответ поставщика', `supplier_confirm_${job.id}`)],
        [Markup.button.callback('🚀 Дальнейший план', `proc_plan_${job.id}`), Markup.button.callback('🏠 К отчёту', `back_main_${job.id}`)],
        [Markup.button.callback('🔄 Новый товар', 'new_search')],
      ]),
    });
  } catch (e) {
    console.error('[supplier_questions]', e);
    await ctx.reply('⚠️ Не удалось открыть вопросы поставщику. Данные анализа сохранены — вернитесь к последнему отчёту или попробуйте ещё раз.', { ...Markup.inlineKeyboard([[Markup.button.callback('🏠 К отчёту', 'last')], [Markup.button.callback('🔄 Новый товар', 'new_search')]]) });
  }
}

import { Markup } from 'telegraf';
import type { Context } from 'telegraf';
import { supabase } from '../../db/supabase';
import { buildSupplierQuestionsFromProfile, ensureProductProcurementProfile } from '../../core/procurementProfile';

async function findJob(userId: string, jobId?: string) {
  if (jobId) {
    const { data } = await supabase
      .from('jobs')
      .select('id, result_json, procurement_status')
      .eq('user_id', userId)
      .eq('id', jobId)
      .single();
    return data;
  }

  // New MVP buttons must always carry analysisId/jobId. Do not silently open
  // the latest product from a generic callback: it can show the wrong analysis.
  return null;
}

function callbackJobId(ctx: Context): string | undefined {
  const match = (ctx as any).match as RegExpMatchArray | undefined;
  return match?.[2] || match?.[1];
}

async function replyOpenSectionFallback(ctx: Context, jobId?: string) {
  const keyboard = jobId
    ? Markup.inlineKeyboard([
        [Markup.button.callback('🏠 К отчёту', `back_main:${jobId}`), Markup.button.callback('📁 Закупочный пакет', `package:${jobId}`)],
        [Markup.button.callback('🔄 Новый товар', 'new_search')],
      ])
    : Markup.inlineKeyboard([
        [Markup.button.callback('🏠 К отчёту', 'last')],
        [Markup.button.callback('🔄 Новый товар', 'new_search')],
      ]);
  await ctx.reply('⚠️ <b>Не удалось открыть раздел.</b>\n\nНо анализ сохранён. Попробуйте открыть отчёт заново или начните новый товар.', {
    parse_mode: 'HTML',
    ...keyboard,
  });
}

export async function handleSupplierQuestions(ctx: Context) {
  const userId = (ctx as any).dbUserId as string | undefined;
  if (!userId) {
    await ctx.reply('Не удалось определить пользователя. Нажмите /start и попробуйте снова.');
    return;
  }

  const jobId = callbackJobId(ctx);
  const job = await findJob(userId, jobId).catch(() => null);
  if (!job) {
    await replyOpenSectionFallback(ctx, jobId);
    return;
  }

  const data = job.result_json as any;
  const product = data.product ?? data.rawProduct ?? {};
  ensureProductProcurementProfile(product, { sourceUrl: data.input_url });
  const questionSet = buildSupplierQuestionsFromProfile(product);
  const firstRow = questionSet.cnValid
    ? [Markup.button.callback('📋 Скопировать RU', `sq_ru:${job.id}`), Markup.button.callback('📋 Скопировать CN', `sq_cn:${job.id}`)]
    : [Markup.button.callback('📋 Скопировать RU', `sq_ru:${job.id}`)];

  await ctx.reply(
    `${questionSet.cnValid ? '💬 <b>Вопросы поставщику RU/CN</b>' : '💬 <b>Вопросы поставщику RU</b>'}\n\n` +
    'Скопируйте текст и отправьте поставщику в чат 1688.\n\n' +
    (questionSet.cnValid ? 'Китайская версия прошла проверку.\n\n' : 'Китайская версия не сформирована безопасно — используйте русский текст или передайте байеру.\n\n') +
    'После ответа поставщика можно обновить закупочный пакет: я попробую извлечь вес, габариты, цену, MOQ и обновить ТЗ.\n\n' +
    '<b>Что делать сейчас:</b> откройте текст и отправьте его поставщику.',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        firstRow,
        [Markup.button.callback('📥 Обновить по ответу', `supplier_confirm:${job.id}`)],
        [Markup.button.callback('⬅️ Назад', `back_main:${job.id}`), Markup.button.callback('📁 Закупочный пакет', `package:${job.id}`)],
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
      await replyOpenSectionFallback(ctx, jobId);
      return;
    }

    const data = job.result_json as any;
    const product = data.product ?? data.rawProduct ?? {};
    const profile = ensureProductProcurementProfile(product, { sourceUrl: data.input_url });
    const questionSet = buildSupplierQuestionsFromProfile(product);
    const questions = (lang === 'cn' ? questionSet.cn : questionSet.ru).slice(0, 10);

    if (lang === 'cn' && !questionSet.cnValid) {
      await ctx.reply('⚠️ Китайская версия не сформирована — используйте русскую версию или переведите через байера.', {
        ...Markup.inlineKeyboard([[Markup.button.callback('📋 Скопировать RU', `sq_ru:${job.id}`)], [Markup.button.callback('⬅️ Назад', `supplier_questions:${job.id}`)]])
      });
      return;
    }

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
        `Товар: ${profile.identity.titleForReport}`,
      ].join('\n');
    }

    // Mark the product as waiting for supplier reply once the user opens the ready-to-send text.
    try {
      const updatedProduct = { ...(product ?? {}), procurementStatus: 'waiting_supplier_reply', productProcurementProfile: profile, procurementProfile: profile };
      await supabase.from('jobs').update({
        procurement_status: 'waiting_supplier_reply',
        result_json: { ...data, product: updatedProduct, productProcurementProfile: profile },
      }).eq('id', job.id).eq('user_id', userId);
    } catch {}

    const afterText = text + '\n\nПосле ответа поставщика нажмите «📥 Обновить по ответу» — обновлю закупочный пакет.';
    await ctx.reply(afterText, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📥 Обновить пакет по ответу', `supplier_confirm:${job.id}`)],
        [Markup.button.callback('⬅️ Назад', `supplier_questions:${job.id}`), Markup.button.callback('🏠 К отчёту', `back_main:${job.id}`)],
        [Markup.button.callback('📁 Закупочный пакет', `package:${job.id}`), Markup.button.callback('🔄 Новый товар', 'new_search')],
      ]),
    });
  } catch (e) {
    console.error('[supplier_questions]', e);
    await replyOpenSectionFallback(ctx, jobId);
  }
}

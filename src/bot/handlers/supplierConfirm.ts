import type { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { supabase } from '../../db/supabase';
import { redis } from '../../lib/redis';
import { buildDecisionContext } from '../../core/decisionLayer';
import { buildProductProcurementProfile, validateProfile } from '../../core/procurementProfile';
import { buildMainMessage } from '../../core/messageBuilder';
import type { ProductWithContent } from '../../types';

function confirmKey(chatId: number): string {
  return `confirm_pending:${chatId}`;
}

async function findJobForConfirm(userId: string, jobId?: string) {
  if (jobId) {
    const { data } = await supabase
      .from('jobs')
      .select('id, result_json, procurement_status, procurement_pipeline')
      .eq('user_id', userId)
      .eq('id', jobId)
      .single();
    return data;
  }
  return null;
}

async function replyOpenSectionFallback(ctx: Context, jobId?: string) {
  const keyboard = jobId
    ? Markup.inlineKeyboard([
        [Markup.button.callback('🏠 К отчёту', `back_main_${jobId}`), Markup.button.callback('📁 Закупочный пакет', `materials_${jobId}`)],
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

export async function handleSupplierConfirmStart(ctx: Context) {
  const userId = (ctx as any).dbUserId as string | undefined;
  if (!userId) return;

  const match = (ctx as any).match as RegExpMatchArray | undefined;
  const callbackJobId = match?.[1];
  const job = await findJobForConfirm(userId, callbackJobId).catch(() => null);

  if (!job) {
    await replyOpenSectionFallback(ctx, callbackJobId);
    return;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const product = ((job as any).result_json as any)?.product ?? ((job as any).result_json as any)?.rawProduct;
  const rawStatus = String((job as any).procurement_status ?? product?.procurementStatus ?? '').toLowerCase();
  const pipeline = (job as any).procurement_pipeline ?? ((job as any).result_json as any)?.procurement_pipeline ?? {};
  const questionsAlreadySent = /questions_opened|waiting_supplier_reply|supplier_reply_added|supplier_reply_received|weight_added|sample_ordered|sample_received|ready_for_test_batch/.test(rawStatus)
    || !!pipeline?.questions_opened
    || !!pipeline?.supplier_questions_opened
    || !!pipeline?.supplier_reply_received
    || !!product?.supplierAnswer;

  if (!questionsAlreadySent) {
    await ctx.reply(
      '📥 <b>Обновить пакет по ответу</b>\n\n' +
      'Сначала отправьте вопросы поставщику. После ответа вернитесь сюда и вставьте текст.\n\n' +
      'Что сделать сейчас:\n' +
      '1. Нажмите «💬 Вопросы поставщику».\n' +
      '2. Скопируйте вопросы.\n' +
      '3. Отправьте их в чат 1688.\n' +
      '4. Когда поставщик ответит — нажмите «📥 Обновить по ответу».',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('💬 Открыть вопросы', `supplier_questions_${job.id}`)],
          [Markup.button.callback('⬅️ Назад', `supplier_questions_${job.id}`), Markup.button.callback('🏠 К отчёту', `back_main_${job.id}`)],
          [Markup.button.callback('🔄 Новый товар', 'new_search')],
        ]),
      },
    );
    return;
  }

  if (redis) {
    await redis.set(confirmKey(chatId), JSON.stringify({ jobId: job.id, userId }), { ex: 900 });
  }

  await ctx.reply(
    '📥 <b>Обновить пакет по ответу</b>\n\nВставьте сюда ответ поставщика.\n\n' +
    'Я попробую извлечь:\n\n' +
    '• цену выбранного SKU\n' +
    '• вес с упаковкой\n' +
    '• габариты упаковки\n' +
    '• MOQ\n' +
    '• сроки отгрузки\n' +
    '• комплектацию\n' +
    '• материал\n' +
    '• упаковку\n' +
    '• фото/видео/документы\n\n' +
    'После этого обновлю:\n' +
    '• предварительную себестоимость\n' +
    '• статус закупки\n' +
    '• ТЗ байеру\n' +
    '• ТЗ карго\n' +
    '• чек-лист образца\n\n' +
    '<i>Можно отправить текст на русском, китайском или английском.</i>',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('💬 Вопросы поставщику', `supplier_questions_${job.id}`)],
        [Markup.button.callback('⬅️ Назад', `supplier_questions_${job.id}`), Markup.button.callback('📁 Закупочный пакет', `materials_${job.id}`)],
        [Markup.button.callback('🔄 Новый товар', 'new_search')],
      ]),
    }
  );

}

export async function getPendingConfirm(chatId: number): Promise<{ jobId: string; userId: string } | null> {
  if (!redis) return null;
  const raw = await redis.get(confirmKey(chatId));
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw as any;
  } catch {
    return null;
  }
}

export async function handleSupplierConfirmText(ctx: Context, text: string): Promise<boolean> {
  const chatId = ctx.chat?.id;
  if (!chatId) return false;

  const pending = await getPendingConfirm(chatId);
  if (!pending) return false;

  // Очищаем pending
  if (redis) await redis.del(confirmKey(chatId));

  await ctx.reply('🔄 Извлекаю данные из ответа поставщика...');

  try {
    // LLM извлечение структурированных данных
    const extracted = await extractSupplierData(text);

    if (!extracted) {
      await ctx.reply('⚠️ Не нашёл вес, габариты или цену в ответе. Можно вставить ответ ещё раз, вручную указать вес или отправить поставщику уточняющий вопрос.', { ...Markup.inlineKeyboard([[Markup.button.callback('📁 Открыть пакет', `materials_${pending.jobId}`)]]) });
      return true;
    }

    // Загружаем job
    const { data: job } = await supabase.from('jobs').select('*').eq('id', pending.jobId).single();
    if (!job?.result_json) {
      await replyOpenSectionFallback(ctx, pending.jobId);
      return true;
    }

    const result = job.result_json as any;
    const raw = result.rawProduct ?? result.product ?? {};
    const product = result.product ?? raw;

    // Обновляем данные
    if (extracted.weightKg && extracted.weightKg > 0) raw.weightKg = extracted.weightKg;
    if (extracted.priceCny && extracted.priceCny > 0) raw.priceYuan = extracted.priceCny;
    if (extracted.moq && extracted.moq > 0) raw.moq = extracted.moq;
    if (raw.normalized1688) {
      if (extracted.weightKg && extracted.weightKg > 0) raw.normalized1688.weightKg = extracted.weightKg;
      if (extracted.priceCny && extracted.priceCny > 0) {
        raw.normalized1688.pricing.displayPriceYuan = extracted.priceCny;
        raw.normalized1688.pricing.selectedSkuPriceYuan = extracted.priceCny;
      }
      if (extracted.moq && extracted.moq > 0) raw.normalized1688.moq = extracted.moq;
    }

    // Обновляем закупочный пакет без обязательного WB: решения пересчитываются из raw/product.
    const updatedProduct: ProductWithContent = {
      ...product,
      ...raw,
      manualWeightKg: extracted.weightKg && extracted.weightKg > 0 ? extracted.weightKg : product?.manualWeightKg,
      supplierAnswer: {
        ...(product?.supplierAnswer ?? {}),
        weightKg: extracted.weightKg,
        priceCny: extracted.priceCny,
        moq: extracted.moq,
        composition: extracted.composition,
        dimensions: extracted.dimensions,
        packaging: extracted.packaging,
        deliveryDays: extracted.deliveryDays,
        documents: extracted.documents,
        photosOrVideos: extracted.photosOrVideos,
        sizes: extracted.sizes,
        productionDays: extracted.productionDays,
      },
    } as any;
    const updatedProfile = buildProductProcurementProfile(updatedProduct, { sourceUrl: result.input_url ?? (job as any).input_url, intelligence: (updatedProduct as any).intelligence });
    const profileValidation = validateProfile(updatedProfile);
    if (!profileValidation.ok) console.warn('[supplier-confirm-profile]', profileValidation.errors.join('; '));
    (updatedProduct as any).productProcurementProfile = profileValidation.fixedProfile;
    (updatedProduct as any).procurementProfile = profileValidation.fixedProfile;
    const decisionContext = buildDecisionContext(updatedProduct);
    (updatedProduct as any).procurementStatus = 'supplier_reply_added';

    // Сохраняем обновлённый job
    await supabase.from('jobs').update({
      procurement_status: 'supplier_reply_added',
      procurement_score: decisionContext.readiness.score,
      procurement_pipeline: {
        product_data: true,
        sku_parsed: decisionContext.sku.skuCount > 0,
        weight_confirmed: decisionContext.weight.canUseForCargo,
        dimensions_confirmed: !!extracted.dimensions,
        supplier_reply_received: true,
        sample_ordered: false,
        sample_checked: false,
        test_batch_ready: false,
      },
      result_json: { ...result, rawProduct: raw, product: updatedProduct, decisionContext, productProcurementProfile: profileValidation.fixedProfile, procurementProfile: profileValidation.fixedProfile },
    }).eq('id', pending.jobId);

    // Формируем ответ
        const confirmedLines: string[] = ['✅ <b>Закупочный пакет обновлён</b>', ''];
    confirmedLines.push('Извлечено:');
    if (extracted.weightKg) confirmedLines.push(`• вес с упаковкой: ${extracted.weightKg} кг`);
    if (extracted.priceCny) confirmedLines.push(`• цена SKU: ${extracted.priceCny} ¥`);
    if (extracted.moq) confirmedLines.push(`• MOQ: ${extracted.moq} шт.`);
    if (extracted.composition) confirmedLines.push(`• материал: ${extracted.composition}`);
    if (extracted.productionDays) confirmedLines.push(`• срок отгрузки/производства: ${extracted.productionDays} дн.`);
    if (extracted.deliveryDays) confirmedLines.push(`• срок отгрузки: ${extracted.deliveryDays} дн.`);
    if (extracted.sizes) confirmedLines.push(`• размеры: ${extracted.sizes}`);
    if (extracted.dimensions) confirmedLines.push(`• габариты упаковки: ${extracted.dimensions}`);
    if (extracted.packaging) confirmedLines.push(`• упаковка: ${extracted.packaging}`);
    if (extracted.documents) confirmedLines.push(`• документы/сертификаты: ${extracted.documents}`);
    if (extracted.photosOrVideos) confirmedLines.push(`• фото/видео: ${extracted.photosOrVideos}`);
    if (confirmedLines.length <= 3) confirmedLines.push('• конкретные числовые данные не найдены — сохранён текст ответа для проверки');
    confirmedLines.push('');
    confirmedLines.push('Изменилось:');
    if (extracted.weightKg) confirmedLines.push('• вес добавлен');
    if (extracted.weightKg) confirmedLines.push('• карго можно пересчитать по введённому весу');
    if (extracted.weightKg) confirmedLines.push('• риск “нет веса” закрыт');
    confirmedLines.push('• предварительная себестоимость обновлена');
    confirmedLines.push('• ТЗ байеру');
    confirmedLines.push('• ТЗ карго');
    confirmedLines.push('• чек-лист образца');
    confirmedLines.push('• закупочный пакет');
    confirmedLines.push('');
    confirmedLines.push(`Новый статус: ${decisionContext.readiness.label}`);
    confirmedLines.push('Теперь можно скачать обновлённый ZIP.');


    await ctx.reply(confirmedLines.join('\n'), { parse_mode: 'HTML' });

    const { text: msgText, keyboard } = buildMainMessage(updatedProduct, pending.jobId, {});
    await ctx.reply(msgText, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...keyboard,
    });

  } catch (e) {
    console.error('[supplier-confirm-error]', e);
    await ctx.reply('⚠️ Не удалось обработать ответ поставщика. Данные анализа сохранены — вернитесь к отчёту или откройте пакет ещё раз.', {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🏠 К отчёту', `back_main_${pending.jobId}`), Markup.button.callback('📁 Закупочный пакет', `materials_${pending.jobId}`)],
        [Markup.button.callback('🔄 Новый товар', 'new_search')],
      ]),
    });
  }

  return true;
}

// ─── LLM extraction ─────────────────────────────────────────────────────────

interface ExtractedData {
  weightKg?: number;
  composition?: string;
  priceCny?: number;
  moq?: number;
  productionDays?: number;
  deliveryDays?: number;
  sizes?: string;
  dimensions?: string;
  packaging?: string;
  documents?: string;
  photosOrVideos?: string;
}

const EXTRACT_MODELS = [
  { base: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-v4-flash', key: 'OPENROUTER_API_KEY' },
  { base: 'https://openrouter.ai/api/v1', model: 'google/gemini-2.5-flash-lite-preview-09-2025', key: 'OPENROUTER_API_KEY' },
  { base: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-4-scout', key: 'OPENROUTER_API_KEY' },
  { base: 'https://api.fireworks.ai/inference/v1', model: 'accounts/fireworks/models/deepseek-v4-flash', key: 'FIREWORKS_API_KEY' },
];

const EXTRACT_PROMPT = `Извлеки из текста ответа поставщика:
- weightKg: вес 1 единицы с упаковкой в кг (число)
- composition: состав ткани/материала (строка)
- priceCny: цена в юанях при оптовом заказе (число)
- moq: минимальный заказ в штуках (число)
- productionDays: срок производства в днях (число)
- deliveryDays: срок отгрузки/доставки до склада в днях (число)
- sizes: доступные размеры (строка)
- dimensions: габариты индивидуальной упаковки (строка, например 28×18×6 см)
- packaging: тип упаковки/комплектация упаковки (строка)
- documents: документы/сертификаты/протоколы, если поставщик упомянул (строка)
- photosOrVideos: фото/видео/реальные снимки, если поставщик упомянул (строка)

Если данных нет — не включай поле. Верни ТОЛЬКО JSON.`;

async function extractSupplierData(text: string): Promise<ExtractedData | null> {
  for (const cfg of EXTRACT_MODELS) {
    const apiKey = process.env[cfg.key];
    if (!apiKey) continue;

    try {
      const res = await fetch(`${cfg.base}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model, max_tokens: 500, temperature: 0,
          messages: [
            { role: 'system', content: 'Извлеки данные из ответа поставщика. ТОЛЬКО JSON.' },
            { role: 'user', content: `${EXTRACT_PROMPT}\n\nТекст: ${text.slice(0, 2000)}` },
          ],
        }),
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) continue;
      const data = await res.json() as any;
      const raw = data.choices?.[0]?.message?.content ?? '';
      const cleaned = raw.replace(/```json\s*/i, '').replace(/```\s*$/i, '').trim();
      const parsed = JSON.parse(cleaned);
      if (parsed) return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

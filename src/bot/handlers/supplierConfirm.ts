import type { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { supabase } from '../../db/supabase';
import { redis } from '../../lib/redis';
import { buildDecisionContext } from '../../core/decisionLayer';
import { buildMainMessage } from '../../core/messageBuilder';
import type { ProductWithContent } from '../../types';

function confirmKey(chatId: number): string {
  return `confirm_pending:${chatId}`;
}

export async function handleSupplierConfirmStart(ctx: Context) {
  const userId = (ctx as any).dbUserId as string | undefined;
  if (!userId) return;

  // Найти последний job
  const { data: job } = await supabase
    .from('jobs')
    .select('id')
    .eq('user_id', userId)
    .in('status', ['done', 'sent'])
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (!job) {
    await ctx.reply('Нет товаров для обновления. Сначала отправьте ссылку.');
    return;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) return;

  if (redis) {
    await redis.set(confirmKey(chatId), JSON.stringify({ jobId: job.id, userId }), { ex: 300 });
  }

  await ctx.reply(
    '📥 <b>Ответ поставщика</b>\n\n' +
    'Вставьте сюда ответ поставщика.\n' +
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
    '• экономику\n' +
    '• статус закупки\n' +
    '• ТЗ байеру\n' +
    '• ТЗ карго\n' +
    '• риск-чеклист\n\n' +
    '<i>Можно отправить текст на русском, китайском или английском.</i>',
    { parse_mode: 'HTML' }
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
      await ctx.reply('❌ Не удалось извлечь данные. Попробуйте отправить текст ещё раз.');
      return true;
    }

    // Загружаем job
    const { data: job } = await supabase.from('jobs').select('*').eq('id', pending.jobId).single();
    if (!job?.result_json) {
      await ctx.reply('❌ Товар не найден.');
      return true;
    }

    const result = job.result_json as any;
    const raw = result.rawProduct;
    const product = result.product;

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
        sizes: extracted.sizes,
        productionDays: extracted.productionDays,
      },
    } as any;
    const decisionContext = buildDecisionContext(updatedProduct);

    // Сохраняем обновлённый job
    await supabase.from('jobs').update({
      procurement_status: decisionContext.readiness.canRecommendSample ? 'ready_for_sample' : 'supplier_reply_received',
      procurement_score: decisionContext.readiness.score,
      procurement_pipeline: {
        product_data: true,
        sku_parsed: decisionContext.sku.skuCount > 0,
        weight_confirmed: decisionContext.weight.canUseForCargo,
        dimensions_confirmed: false,
        supplier_reply_received: true,
        sample_ordered: false,
        sample_checked: false,
        test_batch_ready: false,
      },
      result_json: { ...result, rawProduct: raw, product: updatedProduct, decisionContext },
    }).eq('id', pending.jobId);

    // Формируем ответ
    const previousScore = buildDecisionContext(product as any).readiness.score;
    const newScore = decisionContext.readiness.score;
    const confirmedLines: string[] = ['✅ <b>Закупочный пакет обновлён</b>', ''];
    confirmedLines.push('Извлечено:');
    if (extracted.weightKg) confirmedLines.push(`• вес с упаковкой: ${extracted.weightKg} кг`);
    if (extracted.priceCny) confirmedLines.push(`• цена SKU: ${extracted.priceCny} ¥`);
    if (extracted.moq) confirmedLines.push(`• MOQ: ${extracted.moq} шт.`);
    if (extracted.composition) confirmedLines.push(`• материал: ${extracted.composition}`);
    if (extracted.productionDays) confirmedLines.push(`• срок отгрузки/производства: ${extracted.productionDays} дн.`);
    if (extracted.sizes) confirmedLines.push(`• размеры: ${extracted.sizes}`);
    if (confirmedLines.length <= 3) confirmedLines.push('• конкретные числовые данные не найдены — сохранён текст ответа для проверки');
    confirmedLines.push('');
    confirmedLines.push('Обновил:');
    confirmedLines.push('• экономику');
    confirmedLines.push('• ТЗ байеру');
    confirmedLines.push('• ТЗ карго');
    confirmedLines.push('• риск-чеклист');
    confirmedLines.push('• статус закупки');
    confirmedLines.push('');
    confirmedLines.push(`Новый статус: ${decisionContext.readiness.label}`);
    confirmedLines.push(`Готовность: ${previousScore}/100 → ${newScore}/100`);


    await ctx.reply(confirmedLines.join('\n'), { parse_mode: 'HTML' });

    const { text: msgText, keyboard } = buildMainMessage(updatedProduct, pending.jobId, {});
    await ctx.reply(msgText, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...keyboard,
    });

  } catch (e) {
    console.error('[confirm]', e);
    await ctx.reply('❌ Ошибка при обработке. Попробуйте ещё раз.');
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
  sizes?: string;
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
- sizes: доступные размеры (строка)

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

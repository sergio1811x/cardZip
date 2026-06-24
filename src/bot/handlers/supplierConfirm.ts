import type { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { supabase } from '../../db/supabase';
import { redis } from '../../lib/redis';
import { calcEconomics, calcBudgetScenarios, calcMaxPurchasePrice } from '../../core/economicsCalc';
import { buildConclusion } from '../../core/verdict';
import { buildRiskFlags } from '../../core/riskFlags';
import { buildMessage1, buildMessage2 } from '../../core/messageBuilder';
import { getUserTariffs } from '../../db/queries/userSettings';
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
    '📩 <b>Пришлите ответ поставщика</b>\n\n' +
    'Скопируйте текст ответа из чата 1688/WeChat и отправьте сюда.\n' +
    'Бот извлечёт: вес, состав, цену партии, MOQ, размеры.\n\n' +
    '<i>Можно отправить текст на любом языке.</i>',
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

    // Пересчитываем экономику
    const tariffs = await getUserTariffs(pending.userId).catch(() => null);
    const wbFiltered = product?.wbFiltered ?? null;

    const economics = await calcEconomics({
      platform: raw.platform,
      priceYuan: raw.priceYuan,
      weightKg: raw.weightKg,
      categoryHint: raw.categoryName,
      tariffs: tariffs ?? undefined,
      ...(wbFiltered?.medianPrice > 0 ? { wbMedianPrice: wbFiltered.medianPrice } : {}),
    });

    const riskFlags = buildRiskFlags(raw, wbFiltered);
    const budgets = calcBudgetScenarios(economics.costRub, economics.weightMissing, raw.moq);
    const maxPurchasePrice = wbFiltered?.medianPrice
      ? calcMaxPurchasePrice(wbFiltered.medianPrice, raw.weightKg, economics.yuanToRub, tariffs ?? undefined, raw.priceYuan)
      : null;
    const conclusion = buildConclusion(raw.platform, economics, wbFiltered, riskFlags);

    const updatedProduct: ProductWithContent = {
      ...product,
      ...raw,
      economics,
      budgets,
      maxPurchasePrice,
      conclusion,
      riskFlags,
    };

    // Сохраняем обновлённый job
    await supabase.from('jobs').update({
      result_json: { ...result, rawProduct: raw, product: updatedProduct },
    }).eq('id', pending.jobId);

    // Формируем ответ
    const confirmedLines: string[] = ['🟢 <b>Данные подтверждены поставщиком</b>', ''];
    if (extracted.weightKg) confirmedLines.push(`Вес: ${extracted.weightKg} кг`);
    if (extracted.composition) confirmedLines.push(`Состав: ${extracted.composition}`);
    if (extracted.priceCny) confirmedLines.push(`Цена: ${extracted.priceCny} ¥`);
    if (extracted.moq) confirmedLines.push(`MOQ: ${extracted.moq} шт.`);
    if (extracted.productionDays) confirmedLines.push(`Срок: ${extracted.productionDays} дн.`);
    if (extracted.sizes) confirmedLines.push(`Размеры: ${extracted.sizes}`);
    confirmedLines.push('');
    confirmedLines.push('Теперь доступен полный расчёт экономики.');

    await ctx.reply(confirmedLines.join('\n'), { parse_mode: 'HTML' });

    // Отправляем обновлённую экономику
    const msg1 = buildMessage1(updatedProduct);
    const msg2 = buildMessage2(updatedProduct, pending.jobId);
    await ctx.reply(msg1 + '\n\n' + msg2.text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...msg2.keyboard,
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

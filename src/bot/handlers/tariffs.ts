import { Markup } from 'telegraf';
import type { Context } from 'telegraf';
import { getUserTariffs, saveUserTariffs } from '../../db/queries/userSettings';
import { redis } from '../../lib/redis';
import type { UserTariffs } from '../../types';

const TARIFF_FIELDS: Array<{ key: keyof UserTariffs; label: string; unit: string; hint: string }> = [
  { key: 'cargoPerKgUsd', label: 'Карго', unit: '$/кг', hint: 'Стоимость доставки из Китая за 1 кг (в долларах). Обычно $3–6.' },
  { key: 'fulfillmentRub', label: 'Фулфилмент', unit: '₽/шт', hint: 'Упаковка + приёмка на складе за 1 единицу (в рублях). Обычно 50–150₽.' },
  { key: 'taxPercent', label: 'Налог', unit: '%', hint: 'Ставка налога (УСН 6% или 7%). Введите число без знака %.' },
  { key: 'targetMarginPercent', label: 'Целевая маржа', unit: '%', hint: 'Желаемая маржинальность для расчёта рекомендуемой цены. Обычно 25–40%.' },
  { key: 'drrPercent', label: 'ДРР (реклама)', unit: '%', hint: 'Доля рекламных расходов от цены продажи. На WB обычно 10–20%.' },
];

function pendingKey(chatId: number): string {
  return `tariff_pending:${chatId}`;
}

export async function handleTariffsMenu(ctx: Context) {
  const userId = (ctx as any).dbUserId as string | undefined;
  if (!userId) {
    await ctx.reply('❌ Не удалось определить пользователя.');
    return;
  }

  const tariffs = await getUserTariffs(userId);
  const val = (key: string, def: string, unit: string) => {
    const v = tariffs ? (tariffs as any)[key] : undefined;
    return v ? `<b>${v} ${unit}</b> (ваш)` : `<b>${def} ${unit}</b> (авто)`;
  };

  const lines = [
    '⚙️ <b>Параметры расчёта экономики</b>',
    '',
    'Эти значения бот использует для расчёта себестоимости, прибыли и ROI.',
    '',
    `🚚 Карго из Китая: ${val('cargoPerKgUsd', '~4', '$/кг')}`,
    'Стоимость доставки товара из Китая до РФ.',
    '',
    `📦 Фулфилмент: ${val('fulfillmentRub', '80', '₽/шт')}`,
    'Подготовка и обработка 1 товара перед отправкой на WB.',
    '',
    `🏦 Налог: ${val('taxPercent', '7', '%')}`,
    'Налог с продажи.',
    '',
    `🎯 Желаемая маржа: ${val('targetMarginPercent', '35', '%')}`,
    'Какую прибыльность вы хотите получить.',
    '',
    `📣 Реклама / ДРР: ${val('drrPercent', '15', '%')}`,
    'Доля расходов на рекламу от выручки.',
    '',
    'Нажмите на параметр, чтобы изменить.',
  ];

  const btn = (key: string, emoji: string, label: string, def: string, unit: string) => {
    const v = tariffs ? (tariffs as any)[key] : undefined;
    const display = v ? `${v} ${unit}` : `авто · ${def} ${unit}`;
    return Markup.button.callback(`${emoji} ${label}: ${display}`, `edit_tariff_${key}`);
  };

  const buttons = [
    [btn('cargoPerKgUsd', '🚚', 'Карго', '$4', '/кг')],
    [btn('fulfillmentRub', '📦', 'Фулфилмент', '80', '₽/шт')],
    [btn('taxPercent', '🏦', 'Налог', '7', '%')],
    [btn('targetMarginPercent', '🎯', 'Маржа', '35', '%')],
    [btn('drrPercent', '📣', 'Реклама', '15', '%')],
    [Markup.button.callback('🔄 Сбросить на авто', 'reset_tariffs')],
  ];

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons),
  });
}

export async function handleEditTariff(ctx: Context) {
  const userId = (ctx as any).dbUserId as string | undefined;
  if (!userId) return;

  const match = (ctx as any).match as RegExpMatchArray | undefined;
  const fieldKey = match?.[1] as keyof UserTariffs | undefined;
  if (!fieldKey) return;

  const field = TARIFF_FIELDS.find((f) => f.key === fieldKey);
  if (!field) return;

  const chatId = ctx.chat?.id;
  if (!chatId) return;

  // Сохраняем в Redis что ожидаем ввод
  if (redis) {
    await redis.set(pendingKey(chatId), JSON.stringify({ field: fieldKey, userId }), { ex: 120 });
  }

  await ctx.reply(
    `📝 <b>${field.label}</b>\n${field.hint}\n\nВведите новое значение (${field.unit}):`,
    { parse_mode: 'HTML' }
  );
}

export async function getPendingEdit(chatId: number): Promise<{ field: keyof UserTariffs; userId: string } | null> {
  if (!redis) return null;
  const raw = await redis.get(pendingKey(chatId));
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw as any;
  } catch {
    return null;
  }
}

export async function handleTariffInput(ctx: Context, text: string): Promise<boolean> {
  const chatId = ctx.chat?.id;
  if (!chatId) return false;

  const pending = await getPendingEdit(chatId);
  if (!pending) return false;

  const value = parseFloat(text.replace(',', '.').replace(/[^0-9.]/g, ''));
  if (isNaN(value) || value <= 0 || value > 1000) {
    await ctx.reply('❌ Введите корректное число. Попробуйте ещё раз.');
    return true;
  }

  const tariffs = await getUserTariffs(pending.userId) ?? {};
  tariffs[pending.field] = value;
  await saveUserTariffs(pending.userId, tariffs);

  // Очищаем pending
  if (redis) await redis.del(pendingKey(chatId));

  const field = TARIFF_FIELDS.find((f) => f.key === pending.field);

  await ctx.reply(
    `✅ ${field?.label ?? pending.field} установлен: <b>${value} ${field?.unit ?? ''}</b>\n\nНовые тарифы применятся к следующим расчётам.`,
    { parse_mode: 'HTML' }
  );

  return true;
}

export async function handleResetTariffs(ctx: Context) {
  const userId = (ctx as any).dbUserId as string | undefined;
  if (!userId) return;

  await saveUserTariffs(userId, {});
  await ctx.reply('🔄 Все тарифы сброшены на автоматические.');
}

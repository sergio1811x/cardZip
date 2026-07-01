import { Markup } from 'telegraf';
import type { Context } from 'telegraf';
import { getUserTariffs, saveUserTariffs } from '../../db/queries/userSettings';
import { redis } from '../../lib/redis';
import type { UserTariffs } from '../../types';

const TARIFF_FIELDS: Array<{ key: keyof UserTariffs; label: string; unit: string; hint: string }> = [
  { key: 'cargoPerKgUsd', label: 'Карго', unit: '$/кг', hint: 'Стоимость доставки из Китая за 1 кг. Обычно $3–6, но точный тариф уточняется у карго.' },
  { key: 'fulfillmentRub', label: 'Обработка/упаковка', unit: '₽/шт', hint: 'Ориентировочные расходы на обработку, упаковку и подготовку 1 единицы товара.' },
  { key: 'taxPercent', label: 'Налог', unit: '%', hint: 'Ставка налога для предварительного cost-only расчёта. Введите число без знака %.' },
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
    '⚙️ <b>Параметры предварительной себестоимости</b>',
    '',
    'Эти значения используются только для закупочного cost-only расчёта: закупка, доставка, упаковка и налог.',
    'CardZip не рассчитывает прибыльность и не обещает рыночную цену.',
    '',
    `🚚 Карго из Китая: ${val('cargoPerKgUsd', '~4', '$/кг')}`,
    'Ориентир доставки товара из Китая до РФ.',
    '',
    `📦 Обработка/упаковка: ${val('fulfillmentRub', '80', '₽/шт')}`,
    'Ориентировочные расходы на подготовку 1 единицы товара.',
    '',
    `🏦 Налог: ${val('taxPercent', '7', '%')}`,
    'Налог для предварительного расчёта себестоимости.',
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
    [btn('fulfillmentRub', '📦', 'Обработка', '80', '₽/шт')],
    [btn('taxPercent', '🏦', 'Налог', '7', '%')],
    [Markup.button.callback('🔄 Сбросить на авто', 'reset_tariffs')],
  ];

  if (ctx.callbackQuery) {
    await ctx.editMessageText(lines.join('\n'), {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttons),
    }).catch(() => {});
  } else {
    await ctx.reply(lines.join('\n'), {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttons),
    });
  }
}

export async function handleEditTariff(ctx: Context) {
  const userId = (ctx as any).dbUserId as string | undefined;
  if (!userId) return;

  const match = (ctx as any).match as RegExpMatchArray | undefined;
  const fieldKey = match?.[1] as keyof UserTariffs | undefined;
  if (!fieldKey) return;

  const field = TARIFF_FIELDS.find((f) => f.key === fieldKey);
  if (!field) {
    await ctx.reply('Этот параметр больше не редактируется в MVP. Используйте карго, обработку и налог.');
    return;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) return;

  if (redis) {
    await redis.set(pendingKey(chatId), JSON.stringify({ field: fieldKey, userId }), { ex: 120 });
  }

  if (ctx.callbackQuery) {
    await ctx.editMessageText(
      `📝 <b>${field.label}</b>\n${field.hint}\n\nВведите новое значение (${field.unit}):`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  } else {
    await ctx.reply(
      `📝 <b>${field.label}</b>\n${field.hint}\n\nВведите новое значение (${field.unit}):`,
      { parse_mode: 'HTML' }
    );
  }
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

  const field = TARIFF_FIELDS.find((f) => f.key === pending.field);
  if (!field) {
    if (redis) await redis.del(pendingKey(chatId));
    await ctx.reply('Этот параметр больше не редактируется в MVP.');
    return true;
  }

  const value = parseFloat(text.replace(',', '.').replace(/[^0-9.]/g, ''));
  if (isNaN(value) || value <= 0 || value > 1000) {
    await ctx.reply('❌ Введите корректное число. Попробуйте ещё раз.');
    return true;
  }

  const tariffs = await getUserTariffs(pending.userId) ?? {};
  tariffs[pending.field] = value;
  await saveUserTariffs(pending.userId, tariffs);

  if (redis) await redis.del(pendingKey(chatId));

  await ctx.reply(
    `✅ ${field.label} установлен: <b>${value} ${field.unit}</b>\n\nНовое значение применится к следующим предварительным расчётам себестоимости.`,
    { parse_mode: 'HTML' }
  );

  return true;
}

export async function handleResetTariffs(ctx: Context) {
  const userId = (ctx as any).dbUserId as string | undefined;
  if (!userId) return;

  await saveUserTariffs(userId, {});

  if (ctx.callbackQuery) {
    await handleTariffsMenu(ctx);
  } else {
    await ctx.reply('🔄 Все параметры себестоимости сброшены на автоматические.');
  }
}

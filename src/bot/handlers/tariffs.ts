import { Markup } from 'telegraf';
import type { Context } from 'telegraf';
import { getUserTariffs, saveUserTariffs } from '../../db/queries/userSettings';
import type { UserTariffs } from '../../types';

const TARIFF_FIELDS: Array<{ key: keyof UserTariffs; label: string; unit: string; hint: string }> = [
  { key: 'cargoPerKgUsd', label: 'Карго', unit: '$/кг', hint: 'Стоимость доставки из Китая за 1 кг (в долларах). Обычно $3–6.' },
  { key: 'fulfillmentRub', label: 'Фулфилмент', unit: '₽/шт', hint: 'Упаковка + приёмка на складе за 1 единицу (в рублях). Обычно 50–150₽.' },
  { key: 'taxPercent', label: 'Налог', unit: '%', hint: 'Ставка налога (УСН 6% или 7%). Введите число без знака %.' },
  { key: 'targetMarginPercent', label: 'Целевая маржа', unit: '%', hint: 'Желаемая маржинальность для расчёта рекомендуемой цены. Обычно 25–40%.' },
];

// Показать текущие настройки + кнопки
export async function handleTariffsMenu(ctx: Context) {
  const userId = (ctx as any).dbUserId as string | undefined;
  if (!userId) {
    await ctx.reply('❌ Не удалось определить пользователя.');
    return;
  }

  const tariffs = await getUserTariffs(userId);
  const lines = [
    '⚙️ <b>Ваши тарифы для расчёта экономики</b>',
    '',
    `Карго: <b>${tariffs?.cargoPerKgUsd ?? '~4'} $/кг</b> ${tariffs?.cargoPerKgUsd ? '(ваш)' : '(авто)'}`,
    `Фулфилмент: <b>${tariffs?.fulfillmentRub ?? '80'} ₽/шт</b> ${tariffs?.fulfillmentRub ? '(ваш)' : '(авто)'}`,
    `Налог: <b>${tariffs?.taxPercent ?? '7'}%</b> ${tariffs?.taxPercent ? '(ваш)' : '(авто)'}`,
    `Целевая маржа: <b>${tariffs?.targetMarginPercent ?? '35'}%</b> ${tariffs?.targetMarginPercent ? '(ваш)' : '(авто)'}`,
    '',
    'Нажмите на параметр, чтобы изменить:',
  ];

  const buttons = TARIFF_FIELDS.map((f) => [
    Markup.button.callback(
      `${f.label}: ${tariffs?.[f.key] ?? 'авто'} ${f.unit}`,
      `edit_tariff_${f.key}`
    ),
  ]);
  buttons.push([Markup.button.callback('🔄 Сбросить все на авто', 'reset_tariffs')]);

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons),
  });
}

// Состояние ожидания ввода (в памяти — serverless, поэтому через jobs/temp)
// Для serverless используем простой подход: callback ставит флаг, следующее текстовое сообщение — значение
const pendingEdits = new Map<number, { field: keyof UserTariffs; userId: string }>();

export function getPendingEdit(chatId: number) {
  return pendingEdits.get(chatId);
}

export function clearPendingEdit(chatId: number) {
  pendingEdits.delete(chatId);
}

// Обработчик нажатия на конкретный тариф
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

  pendingEdits.set(chatId, { field: fieldKey, userId });

  await ctx.reply(
    `📝 <b>${field.label}</b>\n${field.hint}\n\nВведите новое значение (${field.unit}):`,
    { parse_mode: 'HTML' }
  );
}

// Обработчик текстового ввода значения
export async function handleTariffInput(ctx: Context, text: string): Promise<boolean> {
  const chatId = ctx.chat?.id;
  if (!chatId) return false;

  const pending = pendingEdits.get(chatId);
  if (!pending) return false;

  const value = parseFloat(text.replace(',', '.').replace(/[^0-9.]/g, ''));
  if (isNaN(value) || value <= 0 || value > 1000) {
    await ctx.reply('❌ Введите корректное число. Попробуйте ещё раз.');
    return true;
  }

  const tariffs = await getUserTariffs(pending.userId) ?? {};
  tariffs[pending.field] = value;
  await saveUserTariffs(pending.userId, tariffs);

  const field = TARIFF_FIELDS.find((f) => f.key === pending.field);
  pendingEdits.delete(chatId);

  await ctx.reply(
    `✅ ${field?.label ?? pending.field} установлен: <b>${value} ${field?.unit ?? ''}</b>\n\nНовые тарифы будут использоваться во всех следующих расчётах.`,
    { parse_mode: 'HTML' }
  );

  return true;
}

// Сброс всех тарифов
export async function handleResetTariffs(ctx: Context) {
  const userId = (ctx as any).dbUserId as string | undefined;
  if (!userId) return;

  await saveUserTariffs(userId, {});
  await ctx.reply('🔄 Все тарифы сброшены на автоматические.');
}

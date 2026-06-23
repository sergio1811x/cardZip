import { Telegraf } from 'telegraf';

const STEP_MESSAGES: Record<string, string[]> = {
  elim: [
    '🔄 Загружаем данные с площадки...',
    '🔄 Читаем карточку товара...',
    '🔄 Извлекаем характеристики...',
    '🔄 Парсим цены и фотографии...',
    '🔄 Обрабатываем данные поставщика...',
    '🔄 Определяем вес и размеры...',
    '🔄 Проверяем атрибуты товара...',
    '🔄 Нормализуем китайский текст...',
    '🔄 Почти загрузили...',
  ],
  process: [
    '🔄 Генерируем SEO-контент...',
    '🔄 Подбираем ключевые слова для WB...',
    '🔄 Ищем похожие товары на Wildberries...',
    '🔄 Анализируем цены конкурентов...',
    '🔄 Составляем описание карточки...',
    '🔄 Фильтруем нерелевантные товары...',
    '🔄 Формируем буллеты для инфографики...',
    '🔄 Рассчитываем юнит-экономику...',
    '🔄 Оцениваем качество выборки WB...',
    '🔄 Готовим вопросы поставщику...',
    '🔄 Проверяем риски товара...',
    '🔄 Считаем тестовую закупку...',
  ],
  send: [
    '🔄 Собираем архив с фотографиями...',
    '🔄 Скачиваем изображения товара...',
    '🔄 Формируем SEO-файл...',
    '🔄 Упаковываем материалы...',
    '🔄 Почти готово, отправляем...',
  ],
};

export function createStepProgress(
  bot: Telegraf,
  chatId: number,
  messageId: number,
  step: string
) {
  const messages = STEP_MESSAGES[step] ?? ['🔄 Обрабатываем...'];
  let index = 0;

  bot.telegram.editMessageText(chatId, messageId, undefined, messages[0], { parse_mode: 'HTML' }).catch(() => {});

  const timer = setInterval(() => {
    index = (index + 1) % messages.length;
    bot.telegram.editMessageText(chatId, messageId, undefined, messages[index], { parse_mode: 'HTML' }).catch(() => {});
  }, 5_000);

  return { stop: () => clearInterval(timer) };
}

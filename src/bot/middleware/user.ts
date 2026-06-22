import type { Context, MiddlewareFn } from 'telegraf';
import { ensureUser } from '../../services/userService';

/**
 * Запускается на каждое сообщение.
 * Кладёт dbUserId в ctx для использования в handlers.
 */
export const userMiddleware: MiddlewareFn<Context> = async (ctx, next) => {
  const tgId = ctx.from?.id;
  if (!tgId) return next();

  try {
    const user = await ensureUser(tgId);
    (ctx as any).dbUserId = user.id;
  } catch (e) {
    console.error('[middleware/user] Не удалось upsert пользователя:', e);
    // Не блокируем — пробуем продолжить
  }

  return next();
};

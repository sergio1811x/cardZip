import { insertEvent } from '../db/queries/events';
import type { EventName } from '../types';

/**
 * Fire-and-forget: никогда не бросает, не блокирует pipeline.
 * Логируем ошибки в консоль — на MVP этого достаточно.
 */
export function track(
  userId: string,
  event: EventName,
  payload: Record<string, unknown> = {}
): void {
  insertEvent(userId, event, payload).catch((err) => {
    console.error('[analytics] Не удалось записать событие', event, err);
  });
}

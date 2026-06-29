import { insertEvent } from '../db/queries/events';
import type { EventName } from '../types';

export async function track(
  userId: string,
  event: EventName,
  payload: Record<string, unknown> = {}
): Promise<void> {
  try {
    await insertEvent(userId, event, payload);
  } catch (err) {
    console.error('[analytics] Не удалось записать событие', event, err);
  }
}

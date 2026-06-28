import { insertEvent } from '../db/queries/events';
import type { EventName } from '../types';

const MAX_PAYLOAD_STRING = 800;
const MAX_PAYLOAD_KEYS = 40;

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (depth > 3) return '[truncated]';

  if (typeof value === 'string') {
    return value.length > MAX_PAYLOAD_STRING ? `${value.slice(0, MAX_PAYLOAD_STRING)}…` : value;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'boolean') return value;

  if (Array.isArray(value)) {
    return value.slice(0, 30).map((item) => sanitizeValue(item, depth + 1));
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, MAX_PAYLOAD_KEYS)) {
      out[key] = sanitizeValue(item, depth + 1);
    }
    return out;
  }

  return String(value);
}

function sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  return sanitizeValue(payload) as Record<string, unknown>;
}

export async function track(
  userId: string,
  event: EventName,
  payload: Record<string, unknown> = {}
): Promise<void> {
  if (!userId) return;

  try {
    await insertEvent(userId, event, sanitizePayload(payload));
  } catch (err) {
    console.error('[analytics] Не удалось записать событие', event, err);
  }
}

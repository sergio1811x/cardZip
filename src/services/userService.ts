import { getOrCreateUser } from '../db/queries/users';
import type { DbUser } from '../types';

export async function ensureUser(tgId: number): Promise<DbUser> {
  if (!Number.isSafeInteger(tgId) || tgId <= 0) {
    throw new Error('Invalid Telegram user id');
  }

  return getOrCreateUser(tgId);
}

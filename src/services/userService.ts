import { getOrCreateUser } from '../db/queries/users';
import type { DbUser } from '../types';

export async function ensureUser(tgId: number): Promise<DbUser> {
  return getOrCreateUser(tgId);
}

import type { VercelRequest, VercelResponse } from '@vercel/node';
import step5Handler, { config } from './step5-qa';

/**
 * Legacy compatibility route.
 * The production send path is api/step5-qa.ts.  Keeping this file as a
 * delegate prevents old queued jobs or stale webhooks from bypassing QA,
 * Hard Validator, Auto-Fix and post-QA credit charging.
 */
export { config };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return step5Handler(req, res);
}

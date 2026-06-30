import type { VercelRequest, VercelResponse } from '@vercel/node';

export const config = { maxDuration: 10 };

// Legacy sender is intentionally disabled.
// The active procurement UX sends only the main report first; materials and ZIP are
// delivered from explicit button handlers (`materials_doc_*`, `materials_zip_*`).
export default async function handler(_req: VercelRequest, res: VercelResponse) {
  return res.status(410).json({
    ok: false,
    disabled: true,
    reason: 'legacy_send_results_disabled_explicit_materials_flow_only',
  });
}

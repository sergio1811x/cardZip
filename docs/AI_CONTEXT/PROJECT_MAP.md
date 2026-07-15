# Project map

CardZip is a TypeScript Telegram bot that turns a 1688/Taobao/Tmall product link into a procurement package.

- `src/bot/` — Telegram handlers and middleware.
- `src/providers/` — external data and LLM stages; `productRolePipeline.ts` orchestrates product understanding.
- `src/core/` — product profile, deterministic document/report builders, validation, category rules, and quality logic.
- `src/services/`, `src/db/`, `src/lib/` — persistence, integrations, and infrastructure helpers.
- `api/` — deployed step/webhook endpoints.
- `supabase/`, `schema.sql` — database schema.
- `*.test.ts` next to core/provider modules — Vitest regression coverage.

Primary flow: provider raw data → normalized product/SKU → ProductProcurementProfile → deterministic builders → validators → Telegram report and ZIP.

Commands: `npm run typecheck`, `npm test`, `npm run test:quality`, `npm run build`.

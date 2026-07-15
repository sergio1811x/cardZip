# Quality gates

Run the narrowest applicable gate first; run broader checks before handoff when shared contracts changed.

| Change | Required check |
| --- | --- |
| TypeScript code | `npm run typecheck` |
| Affected behavior | focused `npx vitest run <test-file> --config vitest.config.ts` |
| Procurement/report/document rules | `npm run test:quality` |
| Broad or build-sensitive change | `npm test` and `npm run build` |

Also inspect changed output contracts: selected SKU/price consistency, localized supplier type, no unsupported claims, no duplicate questions, `analysisId` in scoped callbacks, and valid ZIP/document content where affected.

Report checks run and any checks intentionally not run with the reason.

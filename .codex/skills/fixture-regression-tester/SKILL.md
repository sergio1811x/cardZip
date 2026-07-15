---
name: fixture-regression-tester
description: Create or run focused Vitest fixture regressions for CardZip parsing, product profiling, reports, documents, supplier questions, and output validators. Use when fixing a reproducible defect or protecting an output contract.
---

# Fixture regression testing

1. Find the nearest `*.test.ts` and reuse its fixture style.
2. Make the fixture minimal and representative: raw input/profile → exact invariant or output fragment.
3. Assert the defect is absent and the desired contract is present; avoid brittle snapshots of unrelated prose.
4. Run the focused test with `npx vitest run <file> --config vitest.config.ts`.
5. Run `npm run test:quality` when procurement/report/document quality rules are touched.

Prefer deterministic fixtures. Never encode an unverified LLM response as canonical truth without schema/validator coverage.

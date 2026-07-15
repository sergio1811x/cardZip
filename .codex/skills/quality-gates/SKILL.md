---
name: quality-gates
description: Select and run CardZip validation checks before a handoff, especially after TypeScript, procurement-domain, report, document, ZIP, callback, or shared-contract changes.
---

# Quality gates

Read `docs/AI_CONTEXT/QUALITY_GATES.md`. Identify the changed contract and run the narrowest relevant test first, then the broader required gate.

For output changes, also verify the semantic contract: no unsupported claims, consistent SKU/price, localized supplier labels, no duplicate questions, and `analysisId` in analysis-scoped callbacks.

Do not claim a gate passed unless its command succeeded. In the final response, list checks run and skipped checks with reasons.

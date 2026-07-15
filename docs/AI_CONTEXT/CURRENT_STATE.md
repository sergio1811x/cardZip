# Current state

## Product focus

The MVP is a procurement assistant: a Chinese marketplace link becomes a usable procurement package. Marketplace analytics, ROI, and GO/NO-GO verdicts are not the product core.

## Architectural invariant

`ProductProcurementProfile` is the single source of truth after Product Intelligence. Downstream reports, supplier questions, buyer/cargo briefs, sample checklist, and SEO must consume it rather than reclassify the product.

## Current priorities

- Preserve one selected SKU, price, supplier representation, and product kind across every output.
- Keep product-specific fields and questions; do not leak fields from another category.
- Produce validated Russian outputs and Chinese supplier questions; omit a broken block rather than send it.
- Keep analysis-specific Telegram callbacks keyed by `analysisId`, recoverable from storage rather than only session state.

## Package quality architecture

Step 5 now uses a package-level LLM editor after the factual profile and deterministic baseline are built. The editor produces all five procurement artifacts from the same profile; an independent LLM reviewer scores each artifact and may request one bounded revision. Existing deterministic validators remain the final factual-safety firewall, and the baseline remains the fallback when the LLM is unavailable.

Update this file after a substantial architecture, workflow, priority, or known-state change. Do not record secrets or transient command output.

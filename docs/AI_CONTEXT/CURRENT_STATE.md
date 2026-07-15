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

Downloads must use the reviewed `generatedFiles` saved by Step 5. Rebuilding documents from the profile at download time loses the editorial pass and is only a fallback for legacy or partial results. SEO uses structured JSON output, evidence-first copy, and no generic filler padding.

LLM SEO is an untrusted language candidate: before delivery it is reprojected through `ProductProcurementProfile`. Product-specific terms in unresolved supplier questions are a deny-source for sales claims, so an open question about a capability, inclusion, power source, or mode cannot become an assertion in title, prose, bullets, keywords, or infographic ideas.

Cargo and sample documents are also profile projections, not free-form LLM artifacts. The LLM may enrich structured domain rules, but the final operational document applies role separation and semantic slot deduplication from the profile.

The profile's `criticalConfirmations` are a cross-artifact spine. A package editor cannot replace the profile-derived supplier questions or buyer brief; the main report, buyer brief and cargo brief preserve applicable critical confirmations even when a short supplier chat is capped. SEO treats every unresolved supplier, sample, or cargo check as negative evidence for publication across prose, keywords, and infographic ideas.

Step 5 does not run secondary fact-authoring generators or a package rewriter after Product Intelligence: their lossy input could overwrite the canonical profile with incompatible questions, cargo detail, or SEO claims. User-facing artifacts are projections of the canonical structured profile. Cargo prioritizes applicable critical confirmations before generic logistics lines; inferred use cases are blocked from SEO until confirmed.

For the structured classification, SKU-resolution, and policy-guard roles, the fallback order is GPT-5 mini, Qwen 3.7 Plus, then Gemini 3.1 Flash-Lite. These stages accept the first valid JSON response, so the strongest instruction-following models must be tried before the low-latency fallback. The multimodal canonicalizer keeps GPT-5.4 mini first, followed by Gemini 3.1 Flash-Lite and Gemini 2.5 Flash.

SKU translation is also non-authoritative: a translated option must be informative and preserve the source option's compound structure. Empty, punctuation-only, truncated, or partially translated labels fall back to the supplier's original SKU instead of changing the user's selectable configuration.

Update this file after a substantial architecture, workflow, priority, or known-state change. Do not record secrets or transient command output.

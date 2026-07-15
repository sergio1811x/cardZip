# Decisions

- The product is a procurement-package assistant, not a WB analytics product.
- `ProductProcurementProfile` owns classification, SKU, pricing, supplier, procurement, cargo, content, and data-quality facts.
- Main reports and package documents are deterministic builders; LLMs supply structured inputs only.
- Validate, repair once, validate again; remove an invalid optional block instead of delivering corrupt output.
- UI displays localized supplier types: seller → продавец, merchant → проверенный продавец, factory → фабрика, unknown → не указан.
- Every analysis-scoped callback carries `analysisId`.
- Procurement documents are improved as one profile-grounded package: writer → independent reviewer → at most one revision → deterministic validators. Do not add per-product or per-category prompt branches to this editorial layer.
- The saved reviewed package is the canonical user-facing artifact for a completed job. Profile builders may regenerate only when that artifact is unavailable.
- LLM SEO cannot bypass profile-grounding. A supplier question indicates unresolved evidence and blocks its product-specific terms from unhedged marketing copy.
- Cargo and sample checklists use LLM-derived structured facts only; final text is generated from the profile so procurement-quality questions cannot leak into logistics and duplicate logistics slots collapse.
# Critical profile spine and SEO evidence boundary

Free-form package editing may improve wording but must not replace profile projections for operational artifacts. `criticalConfirmations` are generated once from the LLM's structured product-nature analysis and are then fanned into the user-facing report, supplier workflow, buyer brief, and cargo requests; a capped chat list cannot erase them.

For SEO, any detail still requested from a supplier, sample, or cargo is publication-negative evidence. It may be displayed as an item to clarify, but cannot appear as a consumer claim, keyword, or infographic idea until the profile is refreshed with confirmation.

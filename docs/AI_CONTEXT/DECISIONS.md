# Decisions

- The product is a procurement-package assistant, not a WB analytics product.
- `ProductProcurementProfile` owns classification, SKU, pricing, supplier, procurement, cargo, content, and data-quality facts.
- Main reports and package documents are deterministic builders; LLMs supply structured inputs only.
- Validate, repair once, validate again; remove an invalid optional block instead of delivering corrupt output.
- UI displays localized supplier types: seller → продавец, merchant → проверенный продавец, factory → фабрика, unknown → не указан.
- Every analysis-scoped callback carries `analysisId`.
- Procurement documents are improved as one profile-grounded package: writer → independent reviewer → at most one revision → deterministic validators. Do not add per-product or per-category prompt branches to this editorial layer.

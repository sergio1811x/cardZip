---
name: procurement-domain-rules
description: Apply CardZip product-procurement, supplier-question, SEO-claim, SKU, and cargo constraints. Use when modifying or reviewing ProductProcurementProfile, category rules, reports, documents, supplier questions, or product-specific output.
---

# Procurement rules

Read `docs/AI_CONTEXT/PRODUCT_DOMAIN_RULES.md` and the relevant `src/core` profile/category/validator code.

- Treat `ProductProcurementProfile` as the downstream source of truth; do not reclassify or select another SKU.
- Keep facts, claims, and uncertainty distinct. Unsupported claims stay forbidden or “подтвердить”.
- Apply fields and questions only for the actual product kind; reject category leakage.
- Preserve one SKU/price/supplier representation across report and ZIP artifacts.
- Deduplicate and validate supplier questions; if Chinese output fails validation, retain Russian only.

Add or adjust a focused regression test whenever a domain-rule defect is fixed.

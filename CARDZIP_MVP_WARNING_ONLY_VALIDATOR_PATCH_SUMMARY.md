# CardZip — warning-only validator patch

## Problem

A fresh successful product analysis could be stopped by the hard validator / QA gate and show:

```text
⚠️ Анализ требует уточнения
...
Кредит не списан.
```

This was wrong for the no-WB MVP. Missing supplier confirmations, risky/unconfirmed claims, no weight, weak selected SKU, or absent WB/Ozon market data must become warnings inside the report/package, not a reason to stop the procurement package.

## What changed

1. `api/step5-qa.ts`
   - Hard validator blocks are downgraded to warning-only by default.
   - QA `BLOCK` is downgraded to warning-only by default.
   - AutoFix hard blocks are downgraded to warning-only by default.
   - Fail-closed behavior is still available only when explicitly enabled:
     - `CARDZIP_VALIDATOR_FAIL_CLOSED=true`
     - `CARDZIP_QA_FAIL_CLOSED=true`
   - Successfully parsed products now continue to credit charge + report + ZIP send flow.

2. `src/core/decisionLayer.ts`
   - Removed old user-facing copy `⚠️ Анализ требует уточнения`.
   - Removed `Кредит не списан` from safe fallback summary.
   - New fallback copy says analysis is not lost and user can return to the report.

3. `.env.example`
   - `CARDZIP_EXPERT_WRITER_MODE=off` by default.
   - `CARDZIP_QA_GATE_MODE=critical_only` by default.
   - Added explicit fail-closed flags with default `false`.

## Expected behavior

For a product like a dish warmer with unconfirmed child/audience claims:

- the bot must not stop the analysis;
- the main report must be sent;
- the procurement package must be available;
- risky claims must be shown as “confirm with supplier/documents” or removed by validators;
- no `Анализ требует уточнения` stop card should be shown;
- no `Кредит не списан` should be shown for validator/QA caution.

## Sandbox check

```text
TypeScript transpileModule: PASS
JS parse after transpile: PASS
Checked TS files: 92
Errors: 0
```

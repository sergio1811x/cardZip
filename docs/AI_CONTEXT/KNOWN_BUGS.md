# Known bugs and regression risks

- `💬 Вопросы поставщику` can fall back when an analysis is unavailable from session state; recover by `analysisId` from durable storage/cache.
- Credits must be deducted exactly once per successful analysis.
- Avoid duplicate “Осталось” lines and malformed price text such as `Цена: Выбранный SKU: ...`.
- Do not expose untranslated supplier labels (`seller`, `merchant`, `factory`), category-default weight, mixed Cyrillic/Latin Russian text, duplicate questions, or duplicated characteristics.
- Ensure ZIP filenames are UTF-8; use the documented Latin fallback only if required.

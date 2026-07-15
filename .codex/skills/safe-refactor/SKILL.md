---
name: safe-refactor
description: Make minimal, behavior-preserving CardZip refactors with explicit contract tracing and verification. Use for cleanup, extraction, renaming, dependency changes, or internal restructuring without a requested behavior change.
---

# Safe refactor

1. State the invariant and smallest viable scope.
2. Locate symbol definitions, callers, validators, and tests with `rg` before editing.
3. Make one coherent change; retain public interfaces and profile/output contracts unless explicitly changing them.
4. Update focused tests if coverage would otherwise stop protecting behavior.
5. Run applicable quality gates and inspect the diff for unrelated churn.

Stop and ask for direction if the refactor requires changing product rules, external callback formats, persistence contracts, or user-visible output.

---
name: llm-pipeline-debugger
description: Debug CardZip structured LLM stages, schema parsing, product intelligence, and downstream profile corruption. Use when an LLM result is missing, malformed, contradictory, or produces invalid procurement output.
---

# LLM pipeline debugging

Trace one stage at a time: prompt/input → provider response → `parseLlmJson` and Zod schema → normalized result → `ProductProcurementProfile` → deterministic builder → validator.

Use logs or a minimized failing fixture; redact secrets and provider credentials. Distinguish failure types: transport, prompt/input, JSON extraction, schema rejection, mapping/defaulting, or downstream validation.

Fix the earliest responsible boundary. Preserve structured schemas and deterministic validation; do not mask failures with arbitrary text fallbacks. Add a regression test for a reproducible parser, mapping, or validator defect.

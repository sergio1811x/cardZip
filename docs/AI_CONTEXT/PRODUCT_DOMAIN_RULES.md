# Procurement domain rules

## Source of truth and confidence

Use `ProductProcurementProfile` after product intelligence. Preserve uncertainty: unknown weight stays “не указан”; unconfirmed material, certification, and claims must be marked for confirmation. Never invent a category-default weight.

## Claims and language

Do not state medical, orthopedic, therapeutic, antibacterial, certified, hypoallergenic, child-safe, professional, original-brand, 100% waterproof, UPF50+, sterilizing, food-grade silicone, graphene, overheat-protected, fast/even heating, energy-saving, or moisture-protected claims as facts without evidence.

Supplier questions: deduplicate, keep 8–10 maximum, translate separately RU→CN, validate no Cyrillic, no `file://`, no nested numbering, matching question counts, and decimal points. If CN validation fails, return RU only.

## Product specificity

- Footwear: size chart, insole length, upper/sole materials, packed pair weight, odor, molding, real photos. Never add electrical fields.
- Umbrella: packed weight, folded length, canopy diameter, ribs, canopy/rib materials, mechanism, cover; UPF only as unconfirmed.
- Sleep mask: face/inner materials, 3D form, blackout, strap, odor, seams, 10–15-minute comfort, packaging. Never ask expiry, sole, or power.
- Food warmer/small appliance: voltage, wattage, plug/RF-EAEU compatibility, temperature/modes, confirmed overheat protection, instructions, certificates, video, cable/marking, packed dimensions/weight. Treat Korean-standard SKU text as a power/plug variant, never a color.
- Passive insect trap: do not infer power, lamp, charging, or ultrasonic features.

## Deliverables

The ZIP contains instruction, supplier questions, buyer brief, cargo brief, sample checklist, SEO draft, and product photos. Build each from the profile and validate before sending.

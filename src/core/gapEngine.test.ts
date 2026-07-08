import { describe, it, expect } from "vitest";
import { applyUniversalGaps } from "./gapEngine";

describe("gapEngine.applyUniversalGaps — universal procurement basics", () => {
  // Reproduces the real "kitchen knife" complaint: the LLM produced only niche
  // questions (HRC hardness, spine thickness) and the universal basics were
  // missing from the top of the list.
  const knifeNicheOnly = [
    "Какова твердость стали по шкале Роквелла (HRC)?",
    "Какова фактическая толщина обуха ножа в миллиметрах?",
    "Какой тип монтажа рукояти (накладной или всадной)?",
    "Подтвердите цену выбранного SKU — 5,01 ¥.",
  ];

  const knifeCtx = {
    productText: "кухонный нож-топорик 3cr13 сталь нержавеющая для мяса и овощей",
    materials: ["нержавеющая сталь"],
    weightKgKnown: false,
    packageDimsKnown: false,
    priceReliable: true,
    selectedSkuReliable: true,
  };

  it("injects the missing universal basics for a knife", () => {
    const out = applyUniversalGaps(knifeNicheOnly, knifeCtx);
    const j = out.join(" ").toLowerCase();
    expect(j).toMatch(/вес.*упаковк/); // packed weight
    expect(j).toMatch(/габарит.*упаковк/); // package dims
    expect(j).toMatch(/короб/); // carton
    expect(j).toMatch(/остр|лезви/); // sharp-object transport protection
    expect(j).toMatch(/марку|материал/); // exact material grade
    expect(j).toMatch(/длина.*ширин|ширин.*длин/); // full dimensions
  });

  it("preserves the LLM's order and only appends the missing basics after it", () => {
    const out = applyUniversalGaps(knifeNicheOnly, knifeCtx);
    // The LLM's own questions keep their exact positions …
    knifeNicheOnly.forEach((q, i) => expect(out[i]).toBe(q));
    // … so a knife's HRC (LLM question) is NOT pushed below the appended basics.
    const idxHrc = out.findIndex((q) => /hrc|роквелл/i.test(q));
    const idxWeight = out.findIndex((q) => /вес.*упаковк/i.test(q));
    expect(idxHrc).toBeGreaterThanOrEqual(0);
    expect(idxWeight).toBeGreaterThan(idxHrc); // packed weight appended after
  });

  it("does not reorder the LLM's questions (price stays where the LLM put it)", () => {
    const existing = [
      "Какова твёрдость стали по шкале Роквелла (HRC)?",
      "Подтвердите цену выбранного SKU — 5,01 ¥.",
    ];
    const out = applyUniversalGaps(existing, { ...knifeCtx, priceReliable: false });
    expect(out[0]).toBe(existing[0]);
    expect(out[1]).toBe(existing[1]);
    // appended basics (material, dimensions, …) come AFTER the LLM's questions
    const idxMaterial = out.findIndex((q) => /марку|материал/i.test(q));
    expect(idxMaterial).toBeGreaterThan(1);
  });

  it("does not duplicate a slot already covered by an existing question", () => {
    const out = applyUniversalGaps(knifeNicheOnly, knifeCtx);
    // price was already asked and is reliable → no second price question
    const priceCount = out.filter((q) => /подтвердите.*цен|актуальную цену/i.test(q)).length;
    expect(priceCount).toBe(1);
  });

  it("does not invent transport/compliance asks for a neutral soft product", () => {
    const out = applyUniversalGaps([], {
      productText: "плед флисовый для дивана и кровати",
      materials: ["флис"],
      weightKgKnown: true,
      packageDimsKnown: true,
      priceReliable: true,
      selectedSkuReliable: true,
    });
    const j = out.join(" ").toLowerCase();
    expect(j).not.toMatch(/остр|лезви|литиев|герметичн|аэрозол/); // no false hazard
    // Packed weight is ALWAYS asked — the card's bare weight is not the packed
    // weight, which is never on a 1688 card yet required for any cargo quote.
    expect(j).toMatch(/вес.*упаковк/);
    expect(j).toMatch(/материал|марку/); // still asks material
    expect(j).toMatch(/короб/); // still asks carton
  });

  it("detects battery transport constraint from text", () => {
    const out = applyUniversalGaps([], {
      productText: "портативный вентилятор с аккумулятором usb зарядка",
      materials: ["пластик"],
      weightKgKnown: false,
      packageDimsKnown: false,
      priceReliable: true,
      selectedSkuReliable: true,
    });
    const j = out.join(" ").toLowerCase();
    expect(j).toMatch(/литиев|батаре|msds/);
    expect(j).toMatch(/сертификат|деклараци/); // electrical → compliance hint
  });
});

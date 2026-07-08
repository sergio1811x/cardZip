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

  it("ranks universal basics above niche detail (packed weight before HRC)", () => {
    const out = applyUniversalGaps(knifeNicheOnly, knifeCtx);
    const idxWeight = out.findIndex((q) => /вес.*упаковк/i.test(q));
    const idxHrc = out.findIndex((q) => /hrc|роквелл/i.test(q));
    expect(idxWeight).toBeGreaterThanOrEqual(0);
    expect(idxWeight).toBeLessThan(idxHrc);
  });

  it("ranks physical specs (material, dimensions, weight) above the price ask", () => {
    // For the sample decision, what you can only learn from the supplier (grade,
    // dimensions, packed weight) matters more than negotiating the shown price.
    const out = applyUniversalGaps(
      [
        "Какова актуальная оптовая цена за единицу при заказе партии от 100 штук?",
        "Подтвердите цену выбранного SKU — 5,01 ¥.",
      ],
      { ...knifeCtx, priceReliable: false },
    );
    const idxMaterial = out.findIndex((q) => /марку|материал/i.test(q));
    const idxDims = out.findIndex((q) => /длина.*ширин|ширин.*длин|габаритн/i.test(q));
    const idxPrice = out.findIndex((q) => /цен[ауы]|оптов|стоимост/i.test(q));
    expect(idxMaterial).toBeGreaterThanOrEqual(0);
    expect(idxPrice).toBeGreaterThanOrEqual(0);
    expect(idxMaterial).toBeLessThan(idxPrice);
    expect(idxDims).toBeLessThan(idxPrice);
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
    expect(j).not.toMatch(/вес.*упаковк/); // weight already known
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

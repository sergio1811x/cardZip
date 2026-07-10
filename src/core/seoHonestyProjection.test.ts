import { describe, it, expect } from "vitest";
import {
  groundSeoToProfile,
  stripUnconfirmedPackaging,
  buildStructuredTitle,
} from "./procurementProfile";

// The honesty projection is the architectural guarantee that SEO copy stays a
// PROJECTION of the profile: materials are contained to the profile's set and
// seller-claimed features are hedged — regardless of what the LLM produced.
const profile = {
  identity: {
    materials: ["PC, ABS-пластик"],
    claimedFeatures: ["защита от перегрева", "бесщёточный двигатель"],
    unconfirmedFeatures: ["функция ионизации"],
  },
  sku: { selectedSkuReliable: true },
} as any;

describe("groundSeoToProfile — material containment", () => {
  it("replaces an invented material (нейлон PA) with the profile's material set", () => {
    const out = groundSeoToProfile(
      profile,
      "Высокоскоростной фен для укладки. Корпус выполнен из PC, ABS-пластика и нейлона (PA).",
      ["Материал изделия — PC, ABS-пластик и нейлон PA"],
    );
    expect(out.description).not.toMatch(/нейлон/i);
    expect(out.description).not.toMatch(/PA\b/);
    expect(out.description).toMatch(/PC, ABS-пластик/);
    expect(out.bullets[0]).not.toMatch(/нейлон|PA\b/);
    expect(out.bullets[0]).toMatch(/заявленный материал — PC, ABS-пластик/i);
  });

  it("leaves prose untouched when the profile has no confirmed material", () => {
    const p2 = { identity: { materials: ["уточнить"], claimedFeatures: [], unconfirmedFeatures: [] } } as any;
    const text = "Корпус выполнен из нержавеющей стали.";
    expect(groundSeoToProfile(p2, text, []).description).toBe(text);
  });
});

describe("groundSeoToProfile — claimed-feature hedging", () => {
  it("hedges a bullet that asserts a seller-claimed feature as fact", () => {
    const out = groundSeoToProfile(profile, "", [
      "Предусмотрена защита от перегрева и переключение режимов",
    ]);
    expect(out.bullets[0]).toMatch(/\(заявлено\)/);
  });

  it("does not double-hedge an already-declared feature", () => {
    const out = groundSeoToProfile(profile, "", ["Заявленная защита от перегрева"]);
    expect((out.bullets[0].match(/заявл/gi) ?? []).length).toBe(1);
  });

  it("leaves a bullet with no claimed feature untouched", () => {
    const bullet = "Компактный корпус удобно брать с собой в поездки";
    expect(groundSeoToProfile(profile, "", [bullet]).bullets[0]).toBe(bullet);
  });

  it("hedges despite an ё/е mismatch (бесщеточный copy vs бесщёточный claim)", () => {
    // The copy spells it with е; the profile claim with ё. Without ё→е
    // normalization JS treats them as different chars and the claim leaks unhedged.
    const out = groundSeoToProfile(profile, "", [
      "Бесщеточный двигатель работает тихо и долго",
    ]);
    expect(out.bullets[0]).toMatch(/\(заявлено\)/);
  });

  it("hedges a claim stated with a synonym (двигатель vs claimed мотор)", () => {
    const p = {
      identity: { materials: [], claimedFeatures: ["бесщёточный мотор"], unconfirmedFeatures: [] },
      sku: { selectedSkuReliable: true },
    } as any;
    const out = groundSeoToProfile(p, "Бесщёточный двигатель создаёт направленный поток.", []);
    expect(out.description).toMatch(/\(заявлено\)/);
  });

  it("hedges a description sentence stating an unconfirmed power/measurement", () => {
    const p = {
      identity: { materials: [], claimedFeatures: [], unconfirmedFeatures: [] },
      sku: { selectedSkuReliable: true },
    } as any;
    const out = groundSeoToProfile(p, "Двигатель мощностью 1450 Вт создаёт мощный поток воздуха.", []);
    expect(out.description).toMatch(/\(заявлено\)/);
  });
});

describe("packaging guard — unconfirmed variant", () => {
  const unreliable = {
    identity: { materials: [], claimedFeatures: [], unconfirmedFeatures: [] },
    sku: { selectedSkuReliable: false },
  } as any;
  const reliable = {
    identity: { materials: [], claimedFeatures: [], unconfirmedFeatures: [] },
    sku: { selectedSkuReliable: true },
  } as any;

  it("drops bullets that sell the case/gift set when the variant is unconfirmed", () => {
    const out = groundSeoToProfile(unreliable, "", [
      "Переключение горячий/холодный воздух для удобной укладки",
      "Комплектный подарочный футляр делает фен готовым подарком",
      "Насадка-концентратор направляет поток на пряди",
    ]);
    expect(out.bullets).toHaveLength(2);
    expect(out.bullets.some((b) => /футляр|подарочн/i.test(b))).toBe(false);
  });

  it("keeps the case bullet when the variant IS confirmed", () => {
    const out = groundSeoToProfile(reliable, "", [
      "Комплектный подарочный футляр для хранения",
    ]);
    expect(out.bullets).toHaveLength(1);
  });

  it("strips a packaging clause from the title without leaving a dangling preposition", () => {
    const t = stripUnconfirmedPackaging(
      "Фен для волос высокоскоростной в подарочном кейсе для сушки и укладки",
    );
    expect(t).not.toMatch(/кейс|подарочн/i);
    expect(t).not.toMatch(/\sв\s+для/);
    expect(t).toMatch(/фен для волос/i);
  });

  it("drops a packaging sentence from the description when the variant is unconfirmed", () => {
    const unreliable = {
      identity: { materials: [], claimedFeatures: [], unconfirmedFeatures: [] },
      sku: { selectedSkuReliable: false },
    } as any;
    const out = groundSeoToProfile(
      unreliable,
      "Фен для сушки волос. Подарочный футляр в комплекте решает вопрос хранения.",
      [],
    );
    expect(out.description).not.toMatch(/футляр|подарочн/i);
    expect(out.description).toMatch(/фен для сушки/i);
  });
});

describe("safety / effect claims", () => {
  const p = {
    identity: { materials: [], claimedFeatures: [], unconfirmedFeatures: [] },
    sku: { selectedSkuReliable: true },
  } as any;

  it("drops a bullet claiming an effect on the user's hair/health", () => {
    const out = groundSeoToProfile(p, "", [
      "Насадка-концентратор направляет поток на пряди",
      "Защита от перегрева бережно относится к волосам, предотвращая их повреждение",
    ]);
    expect(out.bullets).toHaveLength(1);
    expect(out.bullets[0]).toMatch(/насадка/i);
  });
});

describe("buildStructuredTitle — no claimed features by construction", () => {
  it("excludes claimed features and packaging, stays keyword-present", () => {
    const t = buildStructuredTitle(
      "Высокоскоростной фен с ионизацией",
      ["сушка волос", "укладка"],
      ["ионизация", "бесщёточный двигатель"],
    );
    expect(t).not.toMatch(/ионизац/i);
    expect(t.toLowerCase()).toContain("фен");
    expect(t.toLowerCase()).toMatch(/сушка|укладка/);
  });

  it("does not orphan a synonym when cutting at ' с '", () => {
    const t = buildStructuredTitle("Кухонный нож с бесщёточным мотором", ["нарезка мяса"], [
      "бесщёточный двигатель",
    ]);
    expect(t).not.toMatch(/мотор/i);
    expect(t.toLowerCase()).toContain("нож");
  });

  it("never truncates a word mid-stem (no broken 'Высоко фен')", () => {
    // A claimed feature "высокая скорость" must not chop "Высокоскоростной" into
    // "Высоко" — the strip works word-by-word, so a word is dropped whole or kept whole.
    const t = buildStructuredTitle(
      "Высокоскоростной фен",
      ["сушка волос", "укладка волос"],
      ["высокая скорость потока", "ионизация"],
    );
    expect(t).not.toMatch(/высоко\s+фен/i);
    // Every word of the object part is a whole word from the source (no fragments).
    const objPart = t.split("—")[0].trim().toLowerCase();
    for (const w of objPart.split(/\s+/).filter(Boolean)) {
      expect(["высокоскоростной", "фен"]).toContain(w.replace(/[.,]/g, ""));
    }
  });

  it("drops a packaging/gift use-case from the title", () => {
    const t = buildStructuredTitle(
      "Фен",
      ["сушка волос", "подарочный комплект для ухода за волосами"],
      [],
    );
    expect(t).not.toMatch(/подароч|комплект/i);
    expect(t.toLowerCase()).toMatch(/сушка/);
  });
});

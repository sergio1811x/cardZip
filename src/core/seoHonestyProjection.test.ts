import { describe, it, expect } from "vitest";
import { groundSeoToProfile, stripUnconfirmedPackaging } from "./procurementProfile";

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
});

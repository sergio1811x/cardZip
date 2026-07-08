import { describe, it, expect } from "vitest";
import { groundSeoToProfile } from "./procurementProfile";

// The honesty projection is the architectural guarantee that SEO copy stays a
// PROJECTION of the profile: materials are contained to the profile's set and
// seller-claimed features are hedged — regardless of what the LLM produced.
const profile = {
  identity: {
    materials: ["PC, ABS-пластик"],
    claimedFeatures: ["защита от перегрева", "бесщёточный двигатель"],
    unconfirmedFeatures: ["функция ионизации"],
  },
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

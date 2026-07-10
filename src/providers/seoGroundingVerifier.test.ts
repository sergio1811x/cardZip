import { afterEach, describe, expect, it } from "vitest";
import {
  parseGroundingVerdict,
  shouldVerifyGrounding,
  type SeoProseInput,
} from "./documentWriter";

// The verifier's network call is not unit-tested; its PURE core — applying a
// model verdict with the same safety gates as the writer — is. The verifier can
// only ever remove/soften content, never degrade the already-validated prose.

const input: SeoProseInput = {
  titleRu: "Кухонный нож для мяса",
  coreObject: "кухонный нож",
  categoryType: "kitchen_tool",
  useCases: ["нарезка мяса", "нарезка овощей", "разделка"],
  materials: ["нержавеющая сталь"],
  confirmedAttributes: [],
  forbidden: ["медицинский"],
};

const fallback = {
  description:
    "Кухонный нож для нарезки мяса и овощей на домашней кухне. Заявленный материал — нержавеющая сталь.",
  bullets: [
    "Режет мясо и овощи",
    "Заявленный материал — нержавеющая сталь",
    "Подходит для небольшого общепита",
    "Удобная рукоять",
    "Рекомендуется мыть вручную",
  ],
};

function verdict(obj: { description?: string; bullets?: string[] }): string {
  return JSON.stringify({
    description: obj.description ?? fallback.description,
    bullets: obj.bullets ?? fallback.bullets,
  });
}

describe("parseGroundingVerdict — applies a valid grounded verdict", () => {
  it("keeps the grounded text when the model stripped an invented scenario", () => {
    const raw = verdict({
      bullets: [
        "Режет мясо и овощи",
        "Заявленный материал — нержавеющая сталь",
        "Удобная рукоять",
        "Рекомендуется мыть вручную",
      ],
    });
    const out = parseGroundingVerdict(raw, input, fallback);
    expect(out.bullets).toHaveLength(4);
    expect(out.bullets.some((b) => /общепит/i.test(b))).toBe(false);
  });
});

describe("parseGroundingVerdict — falls back, never degrades", () => {
  it("returns the original when the verdict stripped below 3 bullets", () => {
    const raw = verdict({ bullets: ["Режет мясо и овощи", "Удобная рукоять"] });
    expect(parseGroundingVerdict(raw, input, fallback)).toBe(fallback);
  });

  it("returns the original when the verdict is not valid JSON", () => {
    expect(parseGroundingVerdict("no json here", input, fallback)).toBe(fallback);
  });

  it("returns the original when the verdict reintroduces a forbidden claim", () => {
    const raw = verdict({
      description:
        "Медицинский кухонный нож для нарезки мяса и овощей на домашней кухне.",
    });
    expect(parseGroundingVerdict(raw, input, fallback)).toBe(fallback);
  });

  it("returns the original when the verdict is too short", () => {
    const raw = verdict({ description: "Нож." });
    expect(parseGroundingVerdict(raw, input, fallback)).toBe(fallback);
  });
});

describe("parseGroundingVerdict — re-gates unbacked numbers", () => {
  it("drops a bullet asserting an unconfirmed measurement", () => {
    const raw = verdict({
      bullets: [
        "Режет мясо и овощи",
        "Толщина лезвия 5 мм",
        "Заявленный материал — нержавеющая сталь",
        "Удобная рукоять",
      ],
    });
    const out = parseGroundingVerdict(raw, input, fallback);
    expect(out.bullets.some((b) => /5\s*мм/i.test(b))).toBe(false);
    expect(out.bullets.length).toBeGreaterThanOrEqual(3);
  });

  it("drops an overloaded disclosure bullet with a laundry list of unconfirmed claims", () => {
    const raw = verdict({
      bullets: [
        "По заявлению продавца — высокая скорость потока, ионизация, постоянная температура, бесщёточный мотор, защита от перегрева, точный стандарт вилки и сертификаты; уточните перед заказом",
        "Режет мясо и овощи",
        "Заявленный материал — нержавеющая сталь",
        "Удобная рукоять",
      ],
    });
    const out = parseGroundingVerdict(raw, input, fallback);
    expect(out.bullets.some((b) => /сертификат|ионизац|бесщеточ/i.test(b))).toBe(false);
    expect(out.bullets.length).toBeGreaterThanOrEqual(3);
  });
});

describe("shouldVerifyGrounding — env gate, default ON", () => {
  const original = process.env.SEO_GROUNDING_VERIFY;
  afterEach(() => {
    if (original === undefined) delete process.env.SEO_GROUNDING_VERIFY;
    else process.env.SEO_GROUNDING_VERIFY = original;
  });

  it("is on by default", () => {
    delete process.env.SEO_GROUNDING_VERIFY;
    expect(shouldVerifyGrounding()).toBe(true);
  });

  it("is off for 0/false/off/no", () => {
    for (const v of ["0", "false", "OFF", "no"]) {
      process.env.SEO_GROUNDING_VERIFY = v;
      expect(shouldVerifyGrounding()).toBe(false);
    }
  });
});

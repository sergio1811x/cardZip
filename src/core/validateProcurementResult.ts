// Quality gate for the assembled CardZip procurement package.
// Pure validator over user-facing strings + document strings.
// No side effects, no I/O.

export interface ProcurementQualityInput {
  files: Array<{ name: string; content: string }>; // ZIP docs
  productDetailsText: string;
  mainReportText: string;
  seoDraftMd: string;
  productKind?: string;
  priceReliable?: boolean;
  plugStandardReliable?: boolean;
  selectedSkuText?: string;
}

export interface ProcurementQualityResult {
  passed: boolean;
  errors: string[];
  warnings: string[];
}

// Minimum non-empty-ish line counts keyed by the leading NN_ number prefix.
const MIN_LINES_BY_PREFIX: Record<string, number> = {
  "00": 12, // 00_Инструкция
  "01": 20, // 01_Вопросы_поставщику
  "02": 35, // 02_ТЗ_байеру
  "03": 25, // 03_ТЗ_карго
  "04": 35, // 04_Чеклист_образца
  "05": 40, // 05_SEO_черновик
};

function filePrefix(name: string): string | null {
  const m = name.match(/^(\d{2})_/);
  return m ? m[1] : null;
}

function countLines(content: string): number {
  return content.split("\n").length;
}

/**
 * Validates the full user-facing procurement package. Returns passed=false
 * (with reasons in `errors`) if any hard quality rule is violated.
 */
export function validateProcurementResult(
  input: ProcurementQualityInput,
): ProcurementQualityResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const files = input.files ?? [];

  // All user-facing text, for the pattern scans below.
  const userFacingBlobs: Array<{ label: string; text: string }> = [
    { label: "productDetailsText", text: input.productDetailsText ?? "" },
    { label: "mainReportText", text: input.mainReportText ?? "" },
    { label: "seoDraftMd", text: input.seoDraftMd ?? "" },
    ...files.map((f) => ({ label: f.name, text: f.content ?? "" })),
  ];

  // ---- Pattern-based failures over every user-facing blob ----
  const forbidden: Array<{ re: RegExp; msg: string }> = [
    { re: /для\s+товара\s*[«"“]?товар/i, msg: 'placeholder "для товара товар"' },
    { re: /Цена:\s*Цена/i, msg: 'doubled label "Цена: Цена"' },
    { re: /SKU:\s*SKU/i, msg: 'doubled label "SKU: SKU"' },
    { re: /Материал:\s*Материал/i, msg: 'doubled label "Материал: Материал"' },
    { re: /Вес:\s*Вес/i, msg: 'doubled label "Вес: Вес"' },
    { re: /ABS-?пластик,\s*ABS\b/i, msg: 'duplicate material "ABS-пластик, ABS"' },
    { re: /Материал:[^\n]*[一-鿿]/, msg: "raw Chinese material in UI" },
    {
      re: /черновик карточки товара на основе закупочных данных/i,
      msg: 'SEO service phrase "черновик карточки товара на основе закупочных данных"',
    },
    { re: /на основе данных 1688/i, msg: 'SEO service phrase "на основе данных 1688"' },
    {
      re: /подходит для использования по назначению/i,
      msg: 'SEO filler "подходит для использования по назначению"',
    },
  ];

  for (const blob of userFacingBlobs) {
    for (const { re, msg } of forbidden) {
      if (re.test(blob.text)) {
        errors.push(`[${blob.label}] ${msg}`);
      }
    }
  }

  // ---- Per-file structural checks ----
  for (const f of files) {
    const content = f.content ?? "";
    const isMd = /\.md$/i.test(f.name);

    // Markdown table collapsed: contains a pipe but no separator row.
    if (isMd && content.includes("|")) {
      const hasSeparator = content
        .split("\n")
        .some((line) => /\|\s*-+\s*\|/.test(line));
      if (!hasSeparator) {
        errors.push(`[${f.name}] markdown table has no separator row (collapsed)`);
      }
    }

    // Collapsed file: substantial content squeezed onto <= 2 lines.
    if (content.length > 200 && countLines(content) <= 2) {
      errors.push(`[${f.name}] content collapsed onto <= 2 lines`);
    }

    // Minimum line counts per known file prefix.
    const prefix = filePrefix(f.name);
    if (prefix && prefix in MIN_LINES_BY_PREFIX) {
      const min = MIN_LINES_BY_PREFIX[prefix];
      const lines = countLines(content);
      if (lines < min) {
        errors.push(
          `[${f.name}] too few lines: ${lines} < ${min} (expected for ${prefix}_*)`,
        );
      }
    }
  }

  // ---- fake_security_camera claim guard (SEO only, simple heuristic) ----
  if (input.productKind === "fake_security_camera") {
    const seo = input.seoDraftMd ?? "";
    const claimTokens =
      /запись видео|видеонаблюдени[ея]|обнаружени[ея] движени|ночное видение|Wi-?Fi|настоящая камера/i;
    if (claimTokens.test(seo)) {
      // Only allow if presented within a "нельзя указывать" / "без подтверждения"
      // (forbidden-claims) context somewhere in the SEO draft.
      const qualified =
        /нельзя\s+указывать/i.test(seo) || /без\s+подтверждения/i.test(seo);
      if (!qualified) {
        errors.push(
          "[seoDraftMd] fake_security_camera: real-camera capability asserted as fact without a forbidden-claims qualifier",
        );
      }
    }
  }

  // ---- Electrical-specific failures over every user-facing blob ----
  const electricalForbidden: Array<{ re: RegExp; msg: string }> = [
    { re: /\d+\s*нужно уточнить/, msg: 'broken glued price (e.g. "8нужно уточнить")' },
    {
      re: /Закупка:\s*нужно уточнить\s*≈/,
      msg: "economics computed off unknown price",
    },
    { re: /для\s+поддержание(?![а-яё])/i, msg: 'bad Russian grammar "для поддержание"' },
    { re: /\bNaN\b|\bundefined\b|\bnull\b/, msg: "NaN/undefined/null in user-facing text" },
  ];

  // Qualifier-aware voltage/wattage tokens.
  const voltWattTokens = [
    /\b\d{2,3}\s?V\b/,
    /\b\d{2,4}\s?W\b/,
    /\d{2,3}\s?В\b/,
    /\d{2,4}\s?Вт\b/,
  ];
  const qualifierRe = /проверить|уточнить|маркировк/i;

  for (const blob of userFacingBlobs) {
    for (const { re, msg } of electricalForbidden) {
      if (re.test(blob.text)) {
        errors.push(`[${blob.label}] ${msg}`);
      }
    }

    // Unconfirmed US plug asserted.
    if (/американская\s+вилка/i.test(blob.text) && input.plugStandardReliable === false) {
      errors.push(`[${blob.label}] unconfirmed plug asserted ("американская вилка")`);
    }

    // Voltage/wattage asserted as fact without a nearby qualifier.
    const hasVoltWatt = voltWattTokens.some((re) => re.test(blob.text));
    if (hasVoltWatt && !qualifierRe.test(blob.text)) {
      errors.push(
        `[${blob.label}] voltage/wattage asserted as fact without проверить/уточнить/маркировк qualifier`,
      );
    }

    // Too-positive verdict on unknown price.
    if (
      /Можно готовить\s+(заказ\s+)?образц/i.test(blob.text) &&
      input.priceReliable === false
    ) {
      errors.push(`[${blob.label}] too-positive verdict on unknown price`);
    }
  }

  // ---- SEO title plug-standard must match selectedSkuText ----
  {
    const seo = input.seoDraftMd ?? "";
    const titleLine =
      seo
        .split("\n")
        .map((l) => l.trim())
        .find(
          (l) =>
            /^#{1,6}\s/.test(l) || /^Название\s*:/i.test(l),
        ) ?? "";
    const plugWordRe = /US|EU|UK|JP|американск|европейск|британск|японск/i;
    const m = titleLine.match(plugWordRe);
    if (m) {
      const sku = input.selectedSkuText ?? "";
      if (!plugWordRe.test(sku) || !sku.toLowerCase().includes(m[0].toLowerCase())) {
        errors.push(
          `[seoDraftMd] SEO title plug standard "${m[0]}" not present in selectedSkuText`,
        );
      }
    }
  }

  // ---- Report-rendering regressions over every user-facing blob ----
  // (glued price fallback, raw Chinese in labeled fields, raw attribute
  //  labels, number-soup SKU lines, duplicate material)
  // Chinese is allowed only in proper-name fields the buyer needs verbatim:
  // the CN title and supplier/store/brand names (used to find the shop on 1688).
  // Spec fields (материал, размер, 型号, …) must never contain Han.
  const labelAllowsChinese = (label: string): boolean =>
    /CN\b|китайск|Название\s*CN|назван|\bимя\b|бренд|магазин|store|поставщик|продавец|фабрик/i.test(label);

  const rawChineseLabeledRe = /^[•\-\s]*([^\n:]{0,40}):\s*[^\n]*[一-鿿]/;
  const rawAttrLabelRe = /^[•\-\s]*[一-鿿]+[^:]*:/;
  const unitWordRe = /Вт|мА·?ч|мАч|мА|мм|см|кг|км|¥|元|\bм\b/i;

  for (const blob of userFacingBlobs) {
    const lines = blob.text.split("\n");
    for (const rawLine of lines) {
      const line = rawLine;

      // Glued digit immediately before "нужно уточнить" (no space), incl. after ≈.
      if (/\d+нужно уточнить/.test(line) || /≈\s*\d+\s*нужно уточнить/.test(line)) {
        errors.push(`[${blob.label}] glued price fallback ("<digits>нужно уточнить")`);
      }

      // Raw attribute label: the LABEL itself contains Han (e.g. "外形Размер:").
      if (rawAttrLabelRe.test(line)) {
        errors.push(`[${blob.label}] raw attribute label`);
        continue;
      }

      // Raw Chinese in the VALUE of a labeled user-facing line — unless it is a
      // legitimately-Chinese CN-title line (label contains CN/китайск).
      const cn = line.match(rawChineseLabeledRe);
      if (cn) {
        const label = cn[1] ?? "";
        if (!labelAllowsChinese(label)) {
          errors.push(`[${blob.label}] raw Chinese in labeled field`);
        }
      }

      // Number-soup SKU line: an SKU/Параметры line that is 4+ bare number
      // tokens (separated by " / " or spaces) with no unit/label words.
      if (/SKU|Параметр/i.test(line)) {
        const valuePart = line.replace(/^[^:]*:/, "");
        if (!unitWordRe.test(valuePart)) {
          const numTokens = valuePart.match(/\b\d+(?:[.,]\d+)?\b/g) ?? [];
          const nonNumWords = valuePart.match(/[A-Za-zА-Яа-яЁё]{2,}/g) ?? [];
          if (numTokens.length >= 4 && nonNumWords.length === 0) {
            errors.push(`[${blob.label}] number-soup SKU without labels`);
          }
        }
      }
    }

    // Duplicate material: two material labels in the same blob, OR a Cyrillic
    // material value alongside a Han material value.
    if (/Материал[:\s][^\n]*\n?[^\n]*Материал[:\s]/i.test(blob.text)) {
      const materialLines = lines.filter((l) => /материал[:\s]/i.test(l));
      const hasCyr = materialLines.some((l) => /материал[:\s].*[А-Яа-яЁё]/i.test(l));
      const hasHan = materialLines.some((l) => /материал[:\s].*[一-鿿]/i.test(l));
      const distinctValues = new Set(
        materialLines.map((l) => l.replace(/^[^:]*:/, "").trim()).filter(Boolean),
      );
      if ((hasCyr && hasHan) || distinctValues.size >= 2) {
        errors.push(`[${blob.label}] duplicate material with different values`);
      }
    }
  }

  // ---- Raw long SKU list one-liner in productDetails ----
  {
    const modelTokenRe = /[A-Z]{2,}-?\d{2,}/g;
    for (const line of (input.productDetailsText ?? "").split("\n")) {
      if (line.length > 120 && /[一-鿿]/.test(line)) {
        const matches = line.match(modelTokenRe);
        if (matches && matches.length >= 2) {
          errors.push("[productDetailsText] raw SKU list one line");
          break;
        }
      }
    }
  }

  // ---- Warnings (non-blocking) ----
  // Weight conflict: "вес не указан" while a numeric kg value appears elsewhere.
  const allText = userFacingBlobs.map((b) => b.text).join("\n");
  if (/вес\s+не\s+указан/i.test(allText) && /\d+[,.]\d+\s*кг/.test(allText)) {
    warnings.push(
      'weight conflict: "вес не указан" present while a numeric "N,N кг" appears elsewhere',
    );
  }

  return { passed: errors.length === 0, errors, warnings };
}

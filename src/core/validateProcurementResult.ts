// Quality gate for the assembled CardZip procurement package.
// Pure validator over user-facing strings + document strings.
// No side effects, no I/O.

export interface ProcurementQualityInput {
  files: Array<{ name: string; content: string }>; // ZIP docs
  productDetailsText: string;
  mainReportText: string;
  seoDraftMd: string;
  productKind?: string;
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

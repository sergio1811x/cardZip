// Quality gate for the assembled CardZip procurement package.
// Pure validator over user-facing strings + document strings.
// No side effects, no I/O.

import type { ProductFactSheet } from '../types';
import { validateCrossDocumentConsistency } from './crossDocConsistency';

export interface ProcurementQualityInput {
  files: Array<{ name: string; content: string }>; // ZIP docs
  productDetailsText: string;
  mainReportText: string;
  seoDraftMd: string;
  productKind?: string;
  priceReliable?: boolean;
  plugStandardReliable?: boolean;
  selectedSkuText?: string;
  factSheet?: ProductFactSheet | null;
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

  // ---- Knife/template/placeholder defect rules over user-facing blobs ----
  // Rule 1 (ERROR): category label injected as product name.
  const categoryAsNameNameRe =
    /для\s+товара\s*[«"“][^»"”]*(товар|техник|аксессуар|издели)/i;
  const categoryLabelQuotedRe =
    /[«"“](кухонный товар|малая техника|аксессуар|USB-товар)[»"”]/i;
  // Rule 4 (ERROR): doubled "неподтверждённое свойство".
  const doubledUnconfirmedRe =
    /неподтверждённое свойство[^\n]*неподтверждённое свойство/;
  const doubledUnconfirmedGluedRe =
    /(неподтверждённое свойство — уточнить[^\n]*)\bи\b\s*\1/i;
  // Rule 5 (WARNING): material fragment duplicated, e.g. "3CR13 …, 3 нержавеющая сталь".
  const materialFragmentDupRe = /(\dCR\d{2})[^\n,]*,\s*\d\s+нержавеющ/i;
  // Rule 2 (ERROR): wrong-product / meta CN tokens (fixed list).
  const wrongProductCnRe = /接水盘|层架|挂钩|伞骨|该问题中的相关产品信息/;

  for (const blob of userFacingBlobs) {
    if (categoryAsNameNameRe.test(blob.text) || categoryLabelQuotedRe.test(blob.text)) {
      errors.push(`[${blob.label}] category label injected as product name`);
    }
    if (doubledUnconfirmedRe.test(blob.text) || doubledUnconfirmedGluedRe.test(blob.text)) {
      errors.push(`[${blob.label}] doubled 'неподтверждённое свойство' in SKU/line`);
    }
    if (materialFragmentDupRe.test(blob.text)) {
      warnings.push(`[${blob.label}] material fragment duplicated`);
    }
  }

  // Rule 2 (ERROR) + Rule 3 (WARNING): CN questions file checks.
  for (const f of files) {
    const isCnQuestions = /(^|\/)01_/.test(f.name) || /Вопрос/i.test(f.name);
    if (!isCnQuestions) continue;
    const content = f.content ?? "";
    if (wrongProductCnRe.test(content)) {
      errors.push(`[${f.name}] wrong-product or meta CN question`);
    }
    // Duplicate CN line within the file (lines containing Han characters).
    const cnLines = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /[一-鿿]/.test(l) && l.length > 0);
    const seenCn = new Set<string>();
    let cnDupFound = false;
    for (const l of cnLines) {
      if (seenCn.has(l)) {
        cnDupFound = true;
        break;
      }
      seenCn.add(l);
    }
    if (cnDupFound) {
      warnings.push(`[${f.name}] duplicate CN question`);
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

  // ---- Text-quality regressions over every user-facing blob ----
  // (composition percentage asserted as fact; nominative-after-"для" grammar smell)
  const compositionRe =
    /\b\d{1,3}\s*%\s*(нейлон|полиэстер|хлопок|спандекс|эластан|вискоз|шерст|лён|лен|полиамид)/i;
  const compositionQualifierRe = /подтверд|уточн|если\s+указан/i;
  const nominativeAfterDlyaRe = /для\s+(йога|бег|фитнес|спорт)(?![а-яё])/i;

  for (const blob of userFacingBlobs) {
    for (const rawLine of blob.text.split("\n")) {
      const line = rawLine;

      // Composition percentage stated as fact without a same-line qualifier.
      if (compositionRe.test(line) && !compositionQualifierRe.test(line)) {
        errors.push(
          `[${blob.label}] composition percentage asserted without confirmation`,
        );
      }

      // Nominative form after "для" (should be genitive: "для йоги/бега/фитнеса").
      if (nominativeAfterDlyaRe.test(line)) {
        warnings.push(`[${blob.label}] grammar: nominative after 'для'`);
      }
    }
  }

  // ---- Per-file text-quality warnings (supplier questions, risks/checklists) ----
  for (const f of files) {
    const content = f.content ?? "";
    const isSupplierQuestions = /(^|\/)01_/.test(f.name) || /Вопрос/i.test(f.name);

    // Bulleted / numbered lines only.
    const bulletLines = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^(\d+[.)]|[•\-*])\s*\S/.test(l));

    // Duplicate question intent within a supplier-questions file.
    if (isSupplierQuestions) {
      const intentGroups: Array<{ key: string; re: RegExp }> = [
        { key: "size-chart", re: /размерн[а-яё]*\s+сетк/i },
        { key: "weight-with-packaging", re: /вес.*упаковк/i },
      ];
      for (const { key, re } of intentGroups) {
        const hits = bulletLines.filter((l) => re.test(l)).length;
        if (hits >= 2) {
          warnings.push(`[${f.name}] duplicate question intent (${key})`);
        }
      }
    }

    // Bare-fragment risk/checklist line: a short lowercase bullet with no verb
    // punctuation, mixed among full-sentence bullets in the same file.
    const isRiskOrChecklist =
      /риск|red|флаг|чеклист|checklist|образц/i.test(f.name) ||
      /красные\s+флаги|риски/i.test(content);
    if (isRiskOrChecklist && bulletLines.length >= 2) {
      const bulletText = (l: string): string =>
        l.replace(/^(\d+[.)]|[•\-*])\s*/, "").trim();
      const isBareFragment = (t: string): boolean => {
        if (!t) return false;
        if (/[.!?:;…]$/.test(t)) return false; // has ending punctuation
        if (t !== t.toLowerCase()) return false; // has an uppercase char
        const words = t.split(/\s+/).filter(Boolean);
        return words.length >= 1 && words.length <= 3;
      };
      const isFullSentence = (t: string): boolean => {
        const words = t.split(/\s+/).filter(Boolean);
        return words.length >= 4 || /[.!?:;…]$/.test(t);
      };
      const texts = bulletLines.map(bulletText);
      const hasFragment = texts.some(isBareFragment);
      const hasFullSentence = texts.some(isFullSentence);
      if (hasFragment && hasFullSentence) {
        warnings.push(`[${f.name}] unpolished bare-fragment line`);
      }
    }
  }

  // ---- SEO description opener (optional warning) ----
  {
    const seoLines = (input.seoDraftMd ?? "").split("\n").map((l) => l.trim());
    for (let i = 0; i < seoLines.length; i++) {
      const m = seoLines[i].match(/^(?:#{1,6}\s*)?Описание\s*:?\s*(.*)$/i);
      if (!m) continue;
      let body = m[1];
      if (!body) {
        // Description text may be on the following non-empty line.
        body = seoLines.slice(i + 1).find((l) => l.length > 0) ?? "";
      }
      // Bare short noun + period: a single lowercase word ending in "." only.
      if (/^[а-яё]+\.\s*$/i.test(body) && body.trim().toLowerCase() === body.trim()) {
        warnings.push("[seoDraftMd] SEO description starts with a bare noun");
      }
      break;
    }
  }

  // ---- Doc-value quality: SEO (05_) and cargo (03_) template detection ----
  const seoFile = files.find((f) => /^05_/.test(f.name) || /(^|\/)05_/.test(f.name));
  if (seoFile) {
    const label = seoFile.name;
    const seoText = seoFile.content ?? "";

    // Rule 1 (ERROR): glued spec + fallback, e.g. "максимальная нагрузка 12вес не указан".
    if (
      /\d+\s*вес не указан/.test(seoText) ||
      /нагрузк\w*\s*\d+вес/i.test(seoText) ||
      /\d+вес не указан/.test(seoText)
    ) {
      errors.push(`[${label}] glued spec+fallback ("<digits>вес не указан")`);
    }

    // Rule 2 (WARNING): internal advice used as a customer selling bullet under "## Буллеты".
    {
      const lines = seoText.split("\n");
      let inBullets = false;
      const internalAdviceRe =
        /провер(ьте|ить)\s+образец|перед\s+продажей|SKU\s+в\s+карточке/i;
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (/^#{1,6}\s*Буллеты/i.test(line)) {
          inBullets = true;
          continue;
        }
        if (inBullets && /^#{1,6}\s/.test(line)) {
          inBullets = false;
        }
        if (inBullets && /^(\d+[.)]|[•\-*])\s*\S/.test(line) && internalAdviceRe.test(line)) {
          warnings.push(`[${label}] internal advice in selling bullets`);
          break;
        }
      }
    }

    // Rule 6 (WARNING): generic "water" filler bullet under "## Буллеты".
    {
      const lines = seoText.split("\n");
      let inBullets = false;
      const fillerBulletRe =
        /универсальн\w+ дизайн под разные интерьеры|удобно дарить и хранить|компактн\w+ и удобн\w+ в повседневн|для повседневного использования\s*$/i;
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (/^#{1,6}\s*Буллеты/i.test(line)) {
          inBullets = true;
          continue;
        }
        if (inBullets && /^#{1,6}\s/.test(line)) {
          inBullets = false;
        }
        if (inBullets && /^(\d+[.)]|[•\-*])\s*\S/.test(line) && fillerBulletRe.test(line)) {
          warnings.push(`[${label}] generic filler SEO bullet`);
          break;
        }
      }
    }

    // Rule 7 (WARNING): water description — the "## Описание" paragraph is
    // essentially "{X} подходит для повседневного использования" with no other
    // substance. Guard: only fire when the section body is short/thin.
    {
      const lines = seoText.split("\n");
      let inSection = false;
      const sectionBody: string[] = [];
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (/^#{1,6}\s*Описание/i.test(line)) {
          inSection = true;
          const inline = line.replace(/^#{1,6}\s*Описание\s*:?\s*/i, "").trim();
          if (inline) sectionBody.push(inline);
          continue;
        }
        if (inSection && /^#{1,6}\s/.test(line)) break;
        if (inSection && line.length > 0) sectionBody.push(line);
      }
      const bodyText = sectionBody.join(" ").trim();
      // Only "water" if the phrase is present AND the description is thin:
      // short overall and no sentence that isn't just the filler phrase.
      if (/подходит для повседневного использования/i.test(bodyText)) {
        const withoutFiller = bodyText
          .replace(/[^.]*подходит для повседневного использования[^.]*\.?/gi, "")
          .trim();
        const substantiveWords = withoutFiller
          .replace(/[.,;:!?—-]/g, " ")
          .split(/\s+/)
          .filter((w) => w.length >= 3).length;
        if (bodyText.length < 160 && substantiveWords < 6) {
          warnings.push(`[${label}] water SEO description`);
        }
      }
    }

    // Rule 8 (WARNING): thin keywords — "## Ключевые слова" line has <= 1
    // comma-separated token (just the title, no real keyword expansion).
    {
      const lines = seoText.split("\n");
      let inKw = false;
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (/^#{1,6}\s*Ключевые\s+слова/i.test(line)) {
          inKw = true;
          continue;
        }
        if (inKw && /^#{1,6}\s/.test(line)) {
          inKw = false;
          continue;
        }
        if (inKw && line.length > 0) {
          const tokens = line
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean);
          if (tokens.length <= 1) {
            warnings.push(`[${label}] thin SEO keywords (title only)`);
          }
          break;
        }
      }
    }

    // Rule 4 (WARNING): keyword soup — "## Ключевые слова" line contains the full
    // long title verbatim OR has >= 2 exact duplicate comma-tokens.
    {
      const lines = seoText.split("\n");
      // Title/Название text for the "contains full title verbatim" check.
      // The title may be inline ("Название: X") or on the line after a "## Название" header.
      const trimmed = lines.map((l) => l.trim());
      const titleIdx = trimmed.findIndex(
        (l) => /^#{1,6}\s*Название/i.test(l) || /^Название\s*:/i.test(l),
      );
      let titleText = "";
      if (titleIdx >= 0) {
        const inline = trimmed[titleIdx]
          .replace(/^#{1,6}\s*Название\s*:?\s*/i, "")
          .replace(/^Название\s*:?\s*/i, "")
          .trim();
        titleText = inline || (trimmed.slice(titleIdx + 1).find((l) => l.length > 0) ?? "");
      }

      let inKeywords = false;
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (/^#{1,6}\s*Ключевые\s+слова/i.test(line)) {
          inKeywords = true;
          continue;
        }
        if (inKeywords && /^#{1,6}\s/.test(line)) {
          inKeywords = false;
          continue;
        }
        if (inKeywords && line.length > 0) {
          let bad = false;
          if (titleText.length >= 20 && line.includes(titleText)) bad = true;
          const tokens = line
            .split(",")
            .map((t) => t.trim().toLowerCase())
            .filter(Boolean);
          const seen = new Set<string>();
          let dupes = 0;
          for (const t of tokens) {
            if (seen.has(t)) dupes++;
            else seen.add(t);
          }
          if (dupes >= 2) bad = true;
          if (bad) {
            warnings.push(`[${label}] low-quality keywords`);
            break;
          }
        }
      }
    }
  }

  const cargoFile = files.find((f) => /^03_/.test(f.name) || /(^|\/)03_/.test(f.name));
  if (cargoFile) {
    const label = cargoFile.name;
    const cargoText = cargoFile.content ?? "";
    const cargoLines = cargoText.split("\n");

    // Rule 5 (WARNING): generic-only cargo — the "## Дополнительно" section contains
    // ONLY the filler "специальных ограничений не найдено".
    {
      let inSection = false;
      let hasFiller = false;
      let hasOther = false;
      for (const rawLine of cargoLines) {
        const line = rawLine.trim();
        if (/^#{1,6}\s*Дополнительно/i.test(line)) {
          inSection = true;
          continue;
        }
        if (inSection && /^#{1,6}\s/.test(line)) break;
        if (inSection && line.length > 0) {
          const body = line.replace(/^(\d+[.)]|[•\-*])\s*/, "").trim();
          if (!body) continue;
          if (/специальных\s+ограничений\s+не\s+найдено/i.test(body)) hasFiller = true;
          else hasOther = true;
        }
      }
      if (hasFiller && !hasOther) {
        warnings.push(`[${label}] cargo brief has no product-specific considerations`);

        // Rule 7 (WARNING): for a hazard-bearing productKind, generic-only cargo
        // means the brief is missing the product-specific caution it must carry.
        const hazardKinds = new Set([
          "knife",
          "bladed",
          "food_warmer",
          "small_appliance",
          "mini_washer",
          "usb_device",
          "battery",
          "powered",
          "liquid",
          "aerosol",
        ]);
        if (input.productKind && hazardKinds.has(input.productKind)) {
          warnings.push(
            `[${label}] cargo lacks product-specific considerations for a hazard-bearing kind`,
          );
        }
      }
    }

    // Rule 6 (WARNING): implausible volumetric weight (> 50 kg) without a package caveat.
    {
      const caveatRe = /упаковк|сложенном|товара, а не/i;
      const hasCaveat = caveatRe.test(cargoText);
      for (const rawLine of cargoLines) {
        const m = rawLine.match(/Объёмный вес[^\n]*?(\d+(?:[.,]\d+)?)/i);
        if (m) {
          const kg = parseFloat(m[1].replace(",", "."));
          if (kg > 50 && !hasCaveat) {
            warnings.push(
              `[${label}] volumetric weight likely from product not package dims, missing caveat`,
            );
            break;
          }
        }
      }
    }
  }

  // ---- Generic-fallback / oversized-SKU smells over user-facing blobs ----
  // Rule 1 (WARNING): a bare steel grade leaked into a title / Название line.
  const steelGradeTailRe = /(\b\d?CR\d{2}\b|\b(?:304|430|420)\b)\s*$/i;
  // Rule 5 (WARNING): generic filler bullets for a specific productKind.
  const genericFillerBulletRe =
    /универсальный дизайн под разные интерьеры|удобно дарить и хранить|компактный и удобный в повседневном/i;

  for (const blob of userFacingBlobs) {
    const lines = blob.text.split("\n");
    for (const rawLine of lines) {
      const line = rawLine.trim();

      // Rule 1: title / Название line whose value ends with a bare steel grade.
      const isTitleLine =
        /^#{1,6}\s*Название\b/i.test(line) ||
        /^Название\s*:/i.test(line) ||
        /^📦\s*\S/.test(line);
      if (isTitleLine) {
        const value = line
          .replace(/^#{1,6}\s*Название\s*:?\s*/i, "")
          .replace(/^Название\s*:?\s*/i, "")
          .replace(/^📦\s*/, "")
          .trim();
        if (value.length > 0 && steelGradeTailRe.test(value)) {
          warnings.push(`[${blob.label}] steel grade leaked into title`);
        }
      }

      // Rule 2: "Выбранный SKU:" value that echoes the whole product title.
      const skuMatch = line.match(/Выбранный\s+SKU\s*:\s*(.+)$/i);
      if (skuMatch) {
        const value = skuMatch[1].trim();
        const words = value.split(/\s+/).filter(Boolean);
        if (value.length > 40 && words.length >= 4) {
          warnings.push(`[${blob.label}] SKU echoes product title, not a real variant`);
        }
      }

      // Rule 3: supplier price question embedding a giant SKU string.
      if (/Подтвердите цену выбранного SKU:[^\n]{40,}—\s*[\d.,]+\s*[¥₽]/.test(line)) {
        warnings.push(`[${blob.label}] price question embeds oversized SKU string`);
      }

      // Rule 4: meaningless single-variant SKU label.
      if (/SKU:\s*1\s*вариант\s*·\s*вариант/i.test(line)) {
        warnings.push(`[${blob.label}] meaningless single-variant SKU label`);
      }
    }

    // Rule 4 (alt form): "• SKU нужно уточнить" co-occurring with "1 вариант".
    if (/^•?\s*SKU нужно уточнить\s*$/im.test(blob.text) && /1\s*вариант/i.test(blob.text)) {
      warnings.push(`[${blob.label}] meaningless single-variant SKU label`);
    }

    // Rule 5: generic filler bullets for a specific product kind.
    if (input.productKind === "knife" && genericFillerBulletRe.test(blob.text)) {
      warnings.push(`[${blob.label}] generic filler bullets for a specific product kind`);
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

  const crossDocIssues = validateCrossDocumentConsistency({
    docs: files,
    factSheet: input.factSheet,
  });
  for (const issue of crossDocIssues) {
    if (issue.severity === 'error') errors.push(`[cross-doc:${issue.field}] ${issue.message}`);
    else warnings.push(`[cross-doc:${issue.field}] ${issue.message}`);
  }

  return { passed: errors.length === 0, errors, warnings };
}

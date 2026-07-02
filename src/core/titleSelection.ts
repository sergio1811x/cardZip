import { stripRawSourceLabels } from "./rawAttributeCleaner";

export type TitleSelectionInput = {
  intelligenceTitle?: string;
  translatedTitle?: string;
  rawTitleCn?: string;
  rawTitleRu?: string;
  productKind?: string;
  fallbackTitle?: string;
  candidates?: string[];
};

export type TitleSelectionResult = {
  titleForReport: string;
  titleForSeo: string;
  rejectedTitleCandidates: Array<{ value: string; reason: string }>;
};

const BAD_TITLE_RX =
  /cross[\s-]?border|для\s*cross[\s-]?border|\bтовар\b|^\d+$|^функции$|для\s+торговли|source|debug|raw|undefined|null|nan/i;

function cleanTitle(v: unknown): string {
  return stripRawSourceLabels(v)
    .replace(/[\u3400-\u9fff\uf900-\ufaff]+/g, "")
    .replace(/\b(?:WB|Ozon)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isBadTitleCandidate(value: unknown): boolean {
  const v = cleanTitle(value);
  if (!v || v.length < 3) return true;
  if (BAD_TITLE_RX.test(v)) return true;
  if (!/[А-Яа-яЁёA-Za-z]/.test(v)) return true;
  if (/^[^А-Яа-яЁёA-Za-z]*$/.test(v)) return true;
  return false;
}

function fallbackByKind(kind?: string): string {
  const k = String(kind ?? "").toLowerCase();
  if (/dish|rack|kitchen_storage/.test(k))
    return "Многоярусная настольная сушилка для посуды";
  if (/umbrella/.test(k)) return "Складной автоматический зонт";
  if (/footwear/.test(k)) return "Обувь";
  if (/clothing/.test(k)) return "Товар одежды";
  if (/sleep_mask/.test(k)) return "Маска для сна";
  if (/mini_washer/.test(k)) return "Мини-стиральная машина";
  return "Товар для закупки";
}

function seoByReport(report: string, kind?: string): string {
  const k = String(kind ?? "").toLowerCase();
  if (/dish|rack|kitchen_storage/.test(k))
    return "Сушилка для посуды настольная многоярусная";
  if (/umbrella/.test(k))
    return /крюч|чехол/i.test(report)
      ? report
      : "Зонт автоматический складной с крючком и чехлом";
  return report.replace(/\s+1688\b/i, "").trim();
}

export function selectBestProductTitle(
  input: TitleSelectionInput,
): TitleSelectionResult {
  const rawCandidates = [
    input.intelligenceTitle,
    input.translatedTitle,
    input.rawTitleRu,
    ...(input.candidates ?? []),
    input.fallbackTitle,
    input.rawTitleCn,
  ];
  const rejectedTitleCandidates: Array<{ value: string; reason: string }> = [];
  for (const candidate of rawCandidates) {
    const cleaned = cleanTitle(candidate);
    if (!cleaned) continue;
    if (isBadTitleCandidate(cleaned)) {
      rejectedTitleCandidates.push({
        value: cleaned,
        reason: "bad_or_raw_title_candidate",
      });
      continue;
    }
    const titleForReport =
      cleaned.length > 90 ? `${cleaned.slice(0, 87).trim()}…` : cleaned;
    return {
      titleForReport,
      titleForSeo: seoByReport(titleForReport, input.productKind),
      rejectedTitleCandidates,
    };
  }
  const fallback = fallbackByKind(input.productKind);
  return {
    titleForReport: fallback,
    titleForSeo: seoByReport(fallback, input.productKind),
    rejectedTitleCandidates,
  };
}

const PLACEHOLDERS = [
  "товар",
  "продукт",
  "item",
  "product",
  "unknown",
  "undefined",
  "null",
  "n/a",
  "не указано",
  "—",
];

export function isPlaceholderValue(value: unknown): boolean {
  const v = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[«»"“”]/g, "");
  if (!v) return true;
  if (!/[\p{L}\p{N}]/u.test(v)) return true;
  return PLACEHOLDERS.includes(v);
}

export function safeTitle(...candidates: Array<string | undefined | null>): string {
  for (const c of candidates)
    if (c && !isPlaceholderValue(c)) return String(c).trim();
  return "товар с 1688";
}

export function assertNoPlaceholders(text: string): string[] {
  const errs: string[] = [];
  if (/для\s+товара\s*[«"“]?товар/i.test(text))
    errs.push('placeholder: для товара "товар"');
  if (/Цена:\s*Цена/i.test(text)) errs.push("double label: Цена: Цена");
  if (/SKU:\s*SKU/i.test(text)) errs.push("double label: SKU: SKU");
  if (/Материал:\s*Материал/i.test(text))
    errs.push("double label: Материал: Материал");
  if (/Вес:\s*Вес/i.test(text)) errs.push("double label: Вес: Вес");
  return errs;
}

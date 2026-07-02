// Newline-preserving text utilities for rendering ZIP documents and Telegram messages.
// IMPORTANT: never add a helper that runs `.replace(/\s+/g, ' ')` on a whole document —
// that collapses `\n` and produces single-line files. These helpers operate line-by-line
// and only collapse spaces/tabs WITHIN a line.

export function cleanLinePreserveMeaning(line: string): string {
  return String(line ?? '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();
}

export function joinLines(lines: Array<string | null | undefined>): string {
  return lines
    .filter((l): l is string => Boolean(l))
    .map(cleanLinePreserveMeaning)
    .join('\n');
}

export function joinParagraphs(blocks: Array<string | null | undefined>): string {
  return blocks
    .filter((b): b is string => Boolean(b))
    .map((b) => b.trim())
    .join('\n\n');
}

// Telegram message renderer: short blocks, emoji, real newlines, no markdown tables.
// Thin and deterministic — takes structured section objects and returns telegram-safe text.

import { joinLines, joinParagraphs, cleanLinePreserveMeaning } from './renderUtils';

export interface TelegramSection {
  heading?: string;
  lines?: Array<string | null | undefined>;
}

/** Render a single section: heading on its own line, then its lines. */
export function renderTelegramSection(section: TelegramSection): string {
  const parts: Array<string | null | undefined> = [];
  if (section.heading) parts.push(cleanLinePreserveMeaning(section.heading));
  if (section.lines && section.lines.length) parts.push(joinLines(section.lines));
  return joinLines(parts);
}

/** Render a full message from multiple sections, blank line between sections. */
export function renderTelegramMessage(sections: TelegramSection[]): string {
  return joinParagraphs(sections.map(renderTelegramSection));
}

/** Render a bulleted list with `• ` markers, one item per line. */
export function renderTelegramBullets(items: Array<string | null | undefined>): string {
  return joinLines(
    items
      .filter((i): i is string => Boolean(i))
      .map((i) => `• ${cleanLinePreserveMeaning(i)}`),
  );
}

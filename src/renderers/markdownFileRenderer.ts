// Markdown file renderer for .md ZIP documents (02_ТЗ_байеру.md etc.).
// Headings on their own lines, blank line between sections, `- ` bullets,
// tables with rows separated by real `\n`, UTF-8, no HTML entities.

import { joinLines, joinParagraphs, cleanLinePreserveMeaning } from './renderUtils';

export interface MarkdownSection {
  heading: string;
  /** Markdown heading level (1-6). Defaults to 2. */
  level?: number;
  lines?: Array<string | null | undefined>;
  bullets?: Array<string | null | undefined>;
}

export interface MarkdownTable {
  headers: string[];
  rows: string[][];
}

function headingPrefix(level = 2): string {
  const n = Math.min(6, Math.max(1, level));
  return '#'.repeat(n);
}

/** Render a `- ` bullet list, one item per line. */
export function renderMarkdownBullets(items: Array<string | null | undefined>): string {
  return joinLines(
    items
      .filter((i): i is string => Boolean(i))
      .map((i) => `- ${cleanLinePreserveMeaning(i)}`),
  );
}

/** Render a GitHub-style table; rows are separated by real newlines. */
export function renderMarkdownTable(table: MarkdownTable): string {
  const header = `| ${table.headers.map((h) => cleanLinePreserveMeaning(h)).join(' | ')} |`;
  const separator = `| ${table.headers.map(() => '---').join(' | ')} |`;
  const body = table.rows.map(
    (row) => `| ${row.map((c) => cleanLinePreserveMeaning(c)).join(' | ')} |`,
  );
  return joinLines([header, separator, ...body]);
}

/** Render one section: heading on its own line, then body lines/bullets. */
export function renderMarkdownSection(section: MarkdownSection): string {
  const blocks: Array<string | null | undefined> = [];
  blocks.push(`${headingPrefix(section.level)} ${cleanLinePreserveMeaning(section.heading)}`);
  if (section.lines && section.lines.length) blocks.push(joinLines(section.lines));
  if (section.bullets && section.bullets.length) blocks.push(renderMarkdownBullets(section.bullets));
  return joinParagraphs(blocks);
}

/** Render a full markdown document: optional H1 title + sections, blank line between. */
export function renderMarkdownDocument(title: string | null | undefined, sections: MarkdownSection[]): string {
  const blocks: string[] = [];
  if (title) blocks.push(`# ${cleanLinePreserveMeaning(title)}`);
  for (const section of sections) blocks.push(renderMarkdownSection(section));
  return joinParagraphs(blocks);
}

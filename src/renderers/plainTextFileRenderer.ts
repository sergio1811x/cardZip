// Plain text file renderer for .txt ZIP documents (00_Инструкция.txt, 01_Вопросы_поставщику.txt).
// Plain text, numbered questions, RU then a blank line then the CN block.

import { joinLines, joinParagraphs, cleanLinePreserveMeaning } from './renderUtils';

export interface PlainTextSection {
  heading?: string;
  lines?: Array<string | null | undefined>;
}

/** Render a numbered list: "1. ...", "2. ...". Empty items are dropped. */
export function renderNumberedList(items: Array<string | null | undefined>): string {
  const clean = items.filter((i): i is string => Boolean(i)).map(cleanLinePreserveMeaning);
  return joinLines(clean.map((item, idx) => `${idx + 1}. ${item}`));
}

/** Render a plain-text section: heading line, then body lines. */
export function renderPlainTextSection(section: PlainTextSection): string {
  const parts: Array<string | null | undefined> = [];
  if (section.heading) parts.push(cleanLinePreserveMeaning(section.heading));
  if (section.lines && section.lines.length) parts.push(joinLines(section.lines));
  return joinLines(parts);
}

/** Render a full plain-text document from sections, blank line between sections. */
export function renderPlainTextDocument(sections: PlainTextSection[]): string {
  return joinParagraphs(sections.map(renderPlainTextSection));
}

/**
 * Render supplier questions: numbered RU block, then a blank line, then the CN block.
 * If cnQuestions is empty/absent, only the RU block is returned (RU-only fallback).
 */
export function renderSupplierQuestions(
  ruQuestions: Array<string | null | undefined>,
  cnQuestions?: Array<string | null | undefined>,
  labels: { ru?: string; cn?: string } = {},
): string {
  const blocks: string[] = [];
  const ru = renderNumberedList(ruQuestions);
  if (ru) blocks.push(joinParagraphs([labels.ru, ru]));
  const cn = cnQuestions ? renderNumberedList(cnQuestions) : '';
  if (cn) blocks.push(joinParagraphs([labels.cn, cn]));
  return joinParagraphs(blocks);
}

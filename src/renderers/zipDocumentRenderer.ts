// ZIP document renderer: re-exports the per-format renderers and provides a
// `renderZipDocument(kind, structured)` dispatcher. Dependency-light — does NOT
// import from procurementProfile.ts. Callers pass an already-structured input.

export * from './renderUtils';
export * from './telegramRenderer';
export * from './markdownFileRenderer';
export * from './plainTextFileRenderer';

import {
  renderMarkdownDocument,
  MarkdownSection,
} from './markdownFileRenderer';
import {
  renderPlainTextDocument,
  renderSupplierQuestions,
  PlainTextSection,
} from './plainTextFileRenderer';

/** Document kinds we can render into the ZIP. */
export type ZipDocumentKind =
  | 'instruction' // 00_Инструкция.txt
  | 'supplier_questions' // 01_Вопросы_поставщику.txt
  | 'buyer_brief' // 02_ТЗ_байеру.md
  | 'cargo_brief' // 03_ТЗ_карго.md
  | 'sample_checklist' // 04_Чеклист_образца.md
  | 'seo_draft'; // 05_SEO_черновик.md

/**
 * Minimal structured input shapes. These are local to the renderer so it stays
 * decoupled from procurementProfile.ts. Builders construct these from the profile
 * and hand them in; the renderer only turns structure into well-formed text.
 */
export interface PlainTextDocInput {
  format: 'plain';
  sections: PlainTextSection[];
}

export interface SupplierQuestionsDocInput {
  format: 'supplier_questions';
  ruQuestions: Array<string | null | undefined>;
  cnQuestions?: Array<string | null | undefined>;
  labels?: { ru?: string; cn?: string };
}

export interface MarkdownDocInput {
  format: 'markdown';
  title?: string | null;
  sections: MarkdownSection[];
}

export type ZipDocumentInput =
  | PlainTextDocInput
  | SupplierQuestionsDocInput
  | MarkdownDocInput;

/**
 * Dispatch a structured document to the right renderer based on `kind`.
 * The renderer trusts `structured.format` for the shape; `kind` selects the
 * intended file so builders can pass a generic structure and get consistent output.
 */
export function renderZipDocument(kind: ZipDocumentKind, structured: ZipDocumentInput): string {
  switch (structured.format) {
    case 'supplier_questions':
      return renderSupplierQuestions(
        structured.ruQuestions,
        structured.cnQuestions,
        structured.labels ?? {},
      );
    case 'markdown':
      return renderMarkdownDocument(structured.title ?? null, structured.sections);
    case 'plain':
      return renderPlainTextDocument(structured.sections);
    default: {
      // Exhaustiveness guard.
      const _never: never = structured;
      void kind;
      return String(_never);
    }
  }
}

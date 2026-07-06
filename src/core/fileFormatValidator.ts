// Validates that assembled ZIP documents are properly formatted multi-line files,
// catching the "collapsed into one line" bug where newlines were destroyed.

// Minimum expected line counts keyed by the leading `NN_` prefix number, so this
// works for both the Russian names (00_Инструкция.txt) and the transliterated
// fallback names (00_Instruction.txt).
const MIN_LINES_BY_PREFIX: Record<string, number> = {
  '00': 12, // Инструкция / Instruction
  '01': 20, // Вопросы поставщику / Voprosy postavschiku
  '02': 35, // ТЗ байеру / TZ bayeru
  '03': 25, // ТЗ карго / TZ kargo
  '04': 35, // Чеклист образца / Checklist obrazca
  '05': 40, // SEO черновик / SEO chernovik
};

function prefixNumber(fileName: string): string | null {
  const m = fileName.match(/^(\d{2})_/);
  return m ? m[1] : null;
}

export function validateFileFormatting(fileName: string, content: string): string[] {
  const errors: string[] = [];
  const lines = content.split('\n');

  const prefix = prefixNumber(fileName);
  if (prefix && MIN_LINES_BY_PREFIX[prefix] !== undefined) {
    const min = MIN_LINES_BY_PREFIX[prefix];
    if (lines.length < min) errors.push(`${fileName}: ${lines.length} lines < ${min}`);
  }

  if (lines.length <= 2 && content.length > 200) {
    errors.push(`${fileName}: collapsed into ${lines.length} line(s)`);
  }

  if (fileName.endsWith('.md')) {
    // Two SEPARATE heading tokens on one physical line. A heading token is a run
    // of #'s at line start or after whitespace, followed by a space. (The old
    // /#{1,6}[^\n]*#{1,6}/ falsely matched a normal "## Заголовок" because the two
    // #'s of `##` each satisfied a separate `#{1,6}`.)
    const twoHeadingsOnLine = content
      .split('\n')
      .some((line) => (line.match(/(?:^|\s)#{1,6}\s/g) ?? []).length >= 2);
    if (twoHeadingsOnLine) errors.push(`${fileName}: multiple headings on one line`);
    if (!/^#{1,6}\s/m.test(content)) errors.push(`${fileName}: no heading on its own line`);
  }

  if (fileName.includes('SEO') && /\|/.test(content) && !/\|\s*-{1,}\s*\|/.test(content)) {
    errors.push(`${fileName}: SEO table missing separator row`);
  }

  for (const l of lines) {
    if (l.length > 2000 && !/https?:\/\//.test(l)) {
      errors.push(`${fileName}: line > 2000 chars`);
      break;
    }
  }

  return errors;
}

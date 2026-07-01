import {
  buildBuyerBriefFromProfile,
  buildCargoBriefFromProfile,
  buildMainReportFromProfile,
  buildReadmeFromProfile,
  buildSampleChecklistFromProfile,
  buildSeoDraftFromProfile,
  buildSupplierQuestionsFromProfile,
  ensureProductProcurementProfile,
  formatSupplierQuestionsText,
  validateDocuments,
  validateMainReport,
  validateProfile,
  type ProductProcurementProfile,
} from './procurementProfile';

export type AnalysisStatus =
  | 'ready'
  | 'needs_supplier_data'
  | 'high_risk'
  | 'no_go'
  | 'fatal_error';

export type AnalysisFatalIssue = {
  code: 'missing_product' | 'missing_title';
  message: string;
};

export type ProcurementDoc = {
  filename: string;
  text: string;
};

export type UserFacingAnalysis = {
  product: Record<string, any>;
  profile: ProductProcurementProfile;
  status: AnalysisStatus;
  fatalIssues: AnalysisFatalIssue[];
  mainText: string;
  docs: ProcurementDoc[];
  generatedFiles: {
    supplierQuestions: string;
    supplierQuestionsCn: string[];
    supplierQuestionsCnValid: boolean;
    briefText: string;
    cargoText: string;
    sampleChecklistText: string;
    seoText: string;
    readmeText: string;
  };
  warnings: string[];
};

function titlePresent(product: Record<string, any>, profile?: ProductProcurementProfile): boolean {
  return !!(
    profile?.identity?.titleForReport?.trim() ||
    product?.titleRu?.trim?.() ||
    product?.titleEn?.trim?.() ||
    product?.titleCn?.trim?.()
  );
}


function hasParsedProductSource(result: Record<string, any> | null | undefined): boolean {
  if (!result || typeof result !== 'object') return false;
  const candidates = [result.rawProduct, result.product, result.productIntelligence, result.seoContent].filter(Boolean);
  return candidates.some((item) => item && typeof item === 'object' && Object.keys(item).length > 0);
}

export function resolveProductFromAnalysisResult(result: Record<string, any> | null | undefined, sourceUrl: string): Record<string, any> {
  const source = result ?? {};
  const raw = source.rawProduct ?? {};
  const savedProduct = source.product ?? {};
  const product = {
    ...raw,
    ...savedProduct,
    titleRu: savedProduct.titleRu ?? source.seoContent?.titleRu ?? source.productIntelligence?.cleanTitles?.titleForReport ?? raw.titleEn ?? raw.titleCn,
    seoContent: savedProduct.seoContent ?? source.seoContent ?? {},
    intelligence: source.productIntelligence ?? source.intelligence ?? savedProduct.intelligence,
    productIntelligence: source.productIntelligence ?? source.intelligence ?? savedProduct.productIntelligence,
    productContext: source.productContext ?? savedProduct.productContext,
    productProcurementProfile: source.productProcurementProfile ?? source.procurementProfile ?? savedProduct.productProcurementProfile,
    procurementProfile: source.productProcurementProfile ?? source.procurementProfile ?? savedProduct.procurementProfile,
    sourceUrl,
    analysisSnapshot: source.analysisSnapshot ?? savedProduct.analysisSnapshot,
  };
  return product;
}

export function findFatalAnalysisIssues(product: Record<string, any>, profile?: ProductProcurementProfile, parsedSourcePresent = true): AnalysisFatalIssue[] {
  const issues: AnalysisFatalIssue[] = [];
  if (!parsedSourcePresent || !product || Object.keys(product).length === 0) {
    issues.push({ code: 'missing_product', message: 'Нет распарсенных данных товара.' });
    return issues;
  }
  if (!titlePresent(product, profile)) {
    issues.push({ code: 'missing_title', message: 'Нет названия товара.' });
  }
  // Missing price is a normal procurement uncertainty, not a delivery blocker.
  // The report/package must still be shown so the user can ask the supplier to confirm it.
  return issues;
}

export function deriveAnalysisStatus(profile: ProductProcurementProfile, fatalIssues: AnalysisFatalIssue[] = []): AnalysisStatus {
  if (fatalIssues.length) return 'fatal_error';
  const flags = [
    ...profile.procurement.redFlags,
    ...profile.dataQuality.contradictions,
    ...profile.dataQuality.missingCriticalFields,
  ].join(' ').toLowerCase();
  if (/нельзя|опасн|контрафакт|запрещ|сертификат безопасности|мелкие детали|no go/.test(flags)) return 'high_risk';
  if (profile.dataQuality.missingCriticalFields.length || profile.sku.skuWarnings.length || !profile.sku.selectedSkuReliable) return 'needs_supplier_data';
  return 'ready';
}

export function buildProfileDocuments(
  product: Record<string, any>,
  opts: { sourceUrl?: string; supplierQuestionsCn?: string[] } = {},
): { profile: ProductProcurementProfile; docs: ProcurementDoc[]; generatedFiles: UserFacingAnalysis['generatedFiles']; warnings: string[] } {
  const warnings: string[] = [];
  const sourceUrl = opts.sourceUrl ?? product.sourceUrl;
  const profileValidation = validateProfile(ensureProductProcurementProfile(product, { sourceUrl }));
  if (!profileValidation.ok) warnings.push(...profileValidation.errors.map((e) => `profile: ${e}`));
  const profile = {
    ...profileValidation.fixedProfile,
    supplierQuestionsCn: opts.supplierQuestionsCn ?? profileValidation.fixedProfile.supplierQuestionsCn,
  };
  product.productProcurementProfile = profile;
  product.procurementProfile = profile;

  const questionSet = buildSupplierQuestionsFromProfile(product, { sourceUrl });
  const formattedQuestions = formatSupplierQuestionsText(questionSet.ru, opts.supplierQuestionsCn ?? questionSet.cn);
  const generatedFiles = {
    supplierQuestions: formattedQuestions.text,
    supplierQuestionsCn: formattedQuestions.cn,
    supplierQuestionsCnValid: formattedQuestions.cnValid,
    briefText: buildBuyerBriefFromProfile(product, { sourceUrl }),
    cargoText: buildCargoBriefFromProfile(product, { sourceUrl }),
    sampleChecklistText: buildSampleChecklistFromProfile(product, { sourceUrl }),
    seoText: buildSeoDraftFromProfile(product, { sourceUrl }),
    readmeText: buildReadmeFromProfile(product, { sourceUrl }),
  };

  const rawDocs: ProcurementDoc[] = [
    { filename: '00_Инструкция.txt', text: generatedFiles.readmeText },
    { filename: '01_Вопросы_поставщику.txt', text: generatedFiles.supplierQuestions },
    { filename: '02_ТЗ_байеру.md', text: generatedFiles.briefText },
    { filename: '03_ТЗ_карго.md', text: generatedFiles.cargoText },
    { filename: '04_Чеклист_образца.md', text: generatedFiles.sampleChecklistText },
    { filename: '05_SEO_черновик.md', text: generatedFiles.seoText },
  ];
  const docsValidation = validateDocuments(rawDocs, profile);
  if (!docsValidation.ok) warnings.push(...docsValidation.errors.map((e) => `document: ${e}`));

  const byName = new Map(docsValidation.fixedDocs.map((doc) => [doc.filename, doc.text]));
  const fixedGeneratedFiles = {
    ...generatedFiles,
    readmeText: byName.get('00_Инструкция.txt') ?? generatedFiles.readmeText,
    supplierQuestions: byName.get('01_Вопросы_поставщику.txt') ?? generatedFiles.supplierQuestions,
    briefText: byName.get('02_ТЗ_байеру.md') ?? generatedFiles.briefText,
    cargoText: byName.get('03_ТЗ_карго.md') ?? generatedFiles.cargoText,
    sampleChecklistText: byName.get('04_Чеклист_образца.md') ?? generatedFiles.sampleChecklistText,
    seoText: byName.get('05_SEO_черновик.md') ?? generatedFiles.seoText,
  };

  return { profile, docs: docsValidation.fixedDocs, generatedFiles: fixedGeneratedFiles, warnings };
}

export function buildUserFacingAnalysis(
  result: Record<string, any> | null | undefined,
  opts: { sourceUrl: string; jobId?: string; creditsRemaining?: number; supplierQuestionsCn?: string[] } = { sourceUrl: '' },
): UserFacingAnalysis {
  const parsedSourcePresent = hasParsedProductSource(result);
  const product = resolveProductFromAnalysisResult(result, opts.sourceUrl);
  const { profile, docs, generatedFiles, warnings } = buildProfileDocuments(product, {
    sourceUrl: opts.sourceUrl,
    supplierQuestionsCn: opts.supplierQuestionsCn,
  });
  const fatalIssues = findFatalAnalysisIssues(product, profile, parsedSourcePresent);
  const status = deriveAnalysisStatus(profile, fatalIssues);
  const main = buildMainReportFromProfile(product, typeof opts.creditsRemaining === 'number' ? { creditsRemaining: opts.creditsRemaining } : undefined, { sourceUrl: opts.sourceUrl });
  const mainValidation = validateMainReport(main);
  if (!mainValidation.ok) warnings.push(...mainValidation.errors.map((e) => `main: ${e}`));
  return { product, profile, status, fatalIssues, mainText: mainValidation.fixedText, docs, generatedFiles, warnings };
}

import { buildSupplierQuestions as buildDecisionSupplierQuestions, validateGeneratedText, buildDecisionContext } from './decisionLayer';

export type SupplierQuestionsResult = { ru: string[]; cn: string[]; textRu: string; textCn: string };

export function buildSupplierQuestions(product: any): SupplierQuestionsResult {
  const x = buildDecisionContext(product);
  const questions = buildDecisionSupplierQuestions(product, x);
  const textRu = ['Что уточнить у поставщика:', ...questions.ru.map((q, i) => `${i + 1}. ${q}`)].join('\n');
  const textCn = ['发给供应商的问题：', ...questions.cn.map((q, i) => `${i + 1}. ${q}`)].join('\n');
  const ruValidation = validateGeneratedText({ productIntelligence: x.intelligence, generatedText: textRu, reportType: 'supplierQuestions', categoryType: x.categoryType, marketDecision: x.market, weightDecision: x.weight });
  return { ru: questions.ru, cn: questions.cn, textRu: ruValidation.fixedText || textRu, textCn };
}

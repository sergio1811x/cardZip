import 'dotenv/config';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { productImporter, normalizeElimResponse } from '../src/providers/productImporter';
import { canonicalizeProduct } from '../src/providers/productCanonicalizer';
import { generateSupplierQuestions, type GeneratorInput } from '../src/providers/supplierQuestionsGenerator';
import { generateSeoCard } from '../src/providers/seoCardGenerator';
import { generateCargoBrief } from '../src/providers/cargoBriefGenerator';
import { translateQuestionsToCn } from '../src/core/cnTranslate';
import { writeDocument, writeSeoProse, type DocWriterInput } from '../src/providers/documentWriter';
import {
  buildProductProcurementProfile,
  buildReadmeFromProfile,
  buildSupplierQuestionsFromProfile,
  translateSupplierQuestionsRuToCn,
  formatSupplierQuestionsText,
  buildBuyerBriefFromProfile,
  buildCargoBriefFromProfile,
  buildSampleChecklistFromProfile,
  buildSeoDraftFromProfile,
} from '../src/core/procurementProfile';

// ─── Offline procurement-doc harness ────────────────────────────────────────
// Goal: stop burning paid bot runs. Capture the raw 1688 scrape + the LLM
// "understanding" ONCE, then re-render all 6 documents locally as many times as
// you want. The final cargo/buyer/questions/readme render is fully deterministic,
// so tuning those builders is free and reproducible.
//
//   npx tsx tools/offline.ts capture <url>       # 1 paid scrape → <id>.raw.json
//   npx tsx tools/offline.ts understand <id>     # 1 paid LLM pass → <id>.context.json
//   npx tsx tools/offline.ts docs <id> [--writers]  # build docs → fixtures/<id>/*.md
//   npx tsx tools/offline.ts all <url>           # capture + understand + docs --writers
//
// --writers runs the paid LLM doc writers (checklist + seoProse) and CN translation,
// matching the exact bot output. Without it, docs render from the frozen context
// with the deterministic floor — instant and free.

const FIXTURES = join(__dirname, 'fixtures');
const rawPath = (id: string) => join(FIXTURES, `${id}.raw.json`);
const ctxPath = (id: string) => join(FIXTURES, `${id}.context.json`);
const docsDir = (id: string) => join(FIXTURES, id);

function idFromUrl(url: string): string {
  const m = url.match(/offer\/(\d+)|offerId=(\d+)|id=(\d+)|(\d{10,})/);
  const id = m && (m[1] || m[2] || m[3] || m[4]);
  if (!id) throw new Error(`Не удалось извлечь id из URL: ${url}`);
  return id;
}

function loadJson<T>(path: string): T {
  if (!existsSync(path)) throw new Error(`Нет файла ${path} — сначала запусти предыдущий шаг.`);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

// ── capture: raw 1688 data (paid scrape, run once) ──────────────────────────
async function capture(url: string): Promise<string> {
  const raw = await productImporter.fetchProduct(url) as any;
  const id = String(raw.productId || idFromUrl(url));
  raw.sourceUrl = url;
  writeFileSync(rawPath(id), JSON.stringify(raw, null, 2), 'utf8');
  console.log(`[capture] ✓ ${id}: ${raw.titleCn?.slice(0, 40)} | price:${raw.priceYuan}¥ attrs:${raw.attributes?.length ?? 0} skus:${raw.skus?.length ?? 0} → ${rawPath(id)}`);
  return id;
}

// ── ingest: normalize a hand-saved raw Elim JSON → <id>.raw.json ────────────
async function ingest(elimFile: string): Promise<string> {
  const json = loadJson<any>(elimFile);
  const id = String(json.id ?? json.mp_id ?? idFromUrl(elimFile));
  const raw = await normalizeElimResponse(json, '1688', id) as any;
  raw.sourceUrl = `https://detail.1688.com/offer/${id}.html`;
  writeFileSync(rawPath(id), JSON.stringify(raw, null, 2), 'utf8');
  console.log(`[ingest] ✓ ${id}: ${raw.titleCn?.slice(0, 40)} | price:${raw.priceYuan}¥ attrs:${raw.attributes?.length ?? 0} skus:${raw.skus?.length ?? 0} → ${rawPath(id)}`);
  return id;
}

// ── understand: canonicalizer + focused generators (paid LLM, cached) ───────
async function understand(id: string): Promise<any> {
  const raw = loadJson<any>(rawPath(id));
  const productContext: any = await canonicalizeProduct({
    offerId: raw.productId, titleCn: raw.titleCn, titleRu: raw.titleEn, titleEn: raw.titleEn,
    categoryName: raw.categoryName, attributes: raw.attributes, skus: raw.skus,
    price: raw.priceYuan, priceRange: raw.priceRange, weightKg: raw.weightKg,
    mainImageUrl: raw.mainImageUrl, sold: raw.sold, stock: raw.stock,
  }).catch((e: any) => { console.error('[understand] canonicalizer failed:', e?.message); return null; });
  if (!productContext) throw new Error('Канонизатор вернул null — смотри лог выше.');

  // Same focused generators the bot runs (vps-server), same merge into domainRules.
  const genInput: GeneratorInput = {
    titleRu: productContext.titles?.cleanRu || raw.titleEn || undefined,
    titleCn: raw.titleCn || undefined,
    priceYuan: Number.isFinite(raw.priceYuan) && raw.priceYuan > 0 ? raw.priceYuan : null,
    attributes: Array.isArray(raw.attributes) ? raw.attributes.slice(0, 30) : [],
    skuNames: Array.isArray(raw.skus) ? raw.skus.map((s: any) => String(s?.name ?? s?.raw ?? '').trim()).filter(Boolean).slice(0, 30) : [],
    coreObject: productContext.identity?.coreObject || undefined,
    categoryType: productContext.identity?.categoryType || raw.categoryName || undefined,
    useCases: Array.isArray(productContext.identity?.useCases) ? productContext.identity.useCases.map(String) : [],
    materials: Object.entries(productContext.facts ?? {}).filter(([k]) => k.includes('материал')).map(([, v]) => String(v)),
  };
  const [genQ, genSeo, genCargo] = await Promise.all([
    generateSupplierQuestions(genInput).catch(() => null),
    generateSeoCard(genInput).catch(() => null),
    generateCargoBrief(genInput).catch(() => null),
  ]);
  const draft: any = (productContext.procurementProfileDraft = productContext.procurementProfileDraft ?? {});
  const dr: any = (draft.domainRules = draft.domainRules ?? {});
  if (genQ?.ru?.length) dr.buyerMustCheck = genQ.ru;
  if (genSeo) dr.seo = { title: genSeo.title, description: genSeo.description, sellingBullets: genSeo.bullets, keywords: genSeo.keywords, characteristics: genSeo.characteristics };
  if (genCargo) dr.cargo = { cargoNature: genCargo.cargoNature, sensitiveIssues: genCargo.considerations, whatToRequest: genCargo.whatToRequest, packagingNotes: '' };

  writeFileSync(ctxPath(id), JSON.stringify(productContext, null, 2), 'utf8');
  console.log(`[understand] ✓ ${id}: core="${productContext.identity?.coreObject}" cat=${productContext.identity?.categoryType} | questions:${genQ?.ru?.length ?? 0} seo:${genSeo ? 'ok' : 'none'} cargo:${genCargo?.cargoNature ?? 'none'} → ${ctxPath(id)}`);
  return productContext;
}

// ── docs: assemble product like the bot, render all 6 documents ─────────────
async function docs(id: string, withWriters: boolean): Promise<void> {
  const raw = loadJson<any>(rawPath(id));
  const productContext = loadJson<any>(ctxPath(id));
  const sourceUrl = raw.sourceUrl ?? '';

  const seoContent = {
    titleRu: productContext?.titles?.cleanRu ?? raw.titleEn ?? raw.titleCn,
    description: '', bullets: [] as string[], keywords: [] as string[],
    characteristics: productContext?.facts ?? {},
  };
  const product: any = {
    ...raw,
    titleRu: seoContent.titleRu,
    seoContent,
    categoryType: productContext?.identity?.categoryType ?? 'other',
    intelligence: productContext ?? null,
    productContext,
    sourceUrl,
  };

  // Optional paid passes that the real bot runs: CN questions + doc writers
  // (checklist + seoProse are the only writer outputs actually consumed;
  // cargo's writer output is dead, so we never call it here).
  if (withWriters) {
    const profile = buildProductProcurementProfile(product);
    const ru = (profile.procurement.mustAskSupplier ?? []).slice(0, 10);
    if (ru.length) {
      const cn = await translateQuestionsToCn(ru).catch(() => []);
      if (Array.isArray(cn) && cn.length === ru.length) {
        product.supplierQuestionsRu = ru;
        product.supplierQuestionsCn = cn;
        product.supplierQuestionsCnValid = true;
      }
    }
    const base: Omit<DocWriterInput, 'docType' | 'draftMd'> = {
      titleRu: profile.identity.titleForReport, coreObject: profile.identity.coreObject,
      categoryType: profile.identity.categoryType, productKind: profile.identity.productKind,
      useCases: profile.identity.useCases ?? [], materials: profile.identity.materials ?? [],
      selectedSku: profile.sku.selectedSkuText, priceText: profile.pricing.displayPriceText,
      sourceUrl, supplierType: profile.supplier.displayType, cargoNature: profile.cargo.cargoNature ?? 'none',
      weightKnown: typeof profile.logistics?.weightKg === 'number', dimsKnown: !!profile.logistics?.dimensionsCm,
      mustAskSupplier: profile.procurement.mustAskSupplier ?? [], mustCheckBeforeSample: profile.procurement.mustCheckBeforeSample ?? [],
      mustCheckOnSample: profile.procurement.mustCheckOnSample ?? [], redFlags: profile.procurement.redFlags ?? [],
      criticalConfirmations: profile.procurement.criticalConfirmations ?? [], cargoMustAsk: profile.cargo.mustAsk ?? [],
      cargoWhatToRequest: profile.cargo.whatToRequest ?? [], cargoConsiderations: profile.cargo.likelySensitiveCargoIssues ?? [],
    };
    const forbidden = profile.content.seoForbiddenClaims ?? [];
    const confirmedAttributes = (Array.isArray(raw.attributes) ? raw.attributes : [])
      .map((a: any) => ({ name: String(a?.name ?? '').trim(), value: String(a?.value ?? '').trim() }))
      .filter((a: any) => a.name && a.value).slice(0, 30);
    const [checklistMd, seoProse] = await Promise.all([
      writeDocument({ ...base, docType: 'checklist', draftMd: buildSampleChecklistFromProfile(product, { sourceUrl }) }, forbidden).catch(() => null),
      writeSeoProse({
        titleRu: profile.identity.titleForSeo || profile.identity.titleForReport, coreObject: profile.identity.coreObject,
        categoryType: profile.identity.categoryType, useCases: profile.identity.useCases ?? [], materials: profile.identity.materials ?? [],
        claimedFeatures: [...(profile.identity.claimedFeatures ?? []), ...(profile.identity.unconfirmedFeatures ?? [])],
        skuReliable: profile.sku.selectedSkuReliable, confirmedAttributes, forbidden,
      }).catch(() => null),
    ]);
    product.polishedDocs = { ...(checklistMd ? { checklist: checklistMd } : {}), ...(seoProse ? { seoProse } : {}) };
    console.log(`[docs] writers → checklist:${checklistMd ? 'ok' : 'floor'} seoProse:${seoProse ? 'ok' : 'floor'}`);
  }

  // Render the 6 documents from the (now-complete) product. CN translation is a
  // paid LLM call, so it runs only in --writers mode; otherwise questions are RU-only.
  const q = buildSupplierQuestionsFromProfile(product);
  let cnList: string[] = [];
  if (withWriters) {
    cnList = product.supplierQuestionsCnValid && Array.isArray(product.supplierQuestionsCn)
      ? (product.supplierQuestionsCn as string[])
      : await translateSupplierQuestionsRuToCn(q.ru).catch(() => []);
  }
  const files: Record<string, string> = {
    '00_Инструкция.txt': buildReadmeFromProfile(product, { sourceUrl }),
    '01_Вопросы_поставщику.txt': formatSupplierQuestionsText(q.ru, cnList).text,
    '02_ТЗ_байеру.md': buildBuyerBriefFromProfile(product, { sourceUrl }),
    '03_ТЗ_карго.md': buildCargoBriefFromProfile(product, { sourceUrl }),
    '04_Чеклист_образца.md': buildSampleChecklistFromProfile(product, { sourceUrl }),
    '05_SEO_черновик.md': buildSeoDraftFromProfile(product, { sourceUrl }),
  };
  const out = docsDir(id);
  if (!existsSync(out)) mkdirSync(out, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(out, name), body, 'utf8');
  console.log(`[docs] ✓ ${id}: 6 файлов → ${out}  (writers:${withWriters ? 'on' : 'off'})`);
}

async function main() {
  const [cmd, arg, ...rest] = process.argv.slice(2);
  const withWriters = rest.includes('--writers');
  switch (cmd) {
    case 'capture': await capture(arg); break;
    case 'ingest': await ingest(arg); break;
    case 'understand': await understand(arg); break;
    case 'docs': await docs(arg, withWriters); break;
    case 'all': {
      const id = await capture(arg);
      await understand(id);
      await docs(id, true);
      break;
    }
    default:
      console.log('Использование:\n  npx tsx tools/offline.ts capture <url>              # RapidAPI→Elim, нормализует, сохраняет\n  npx tsx tools/offline.ts ingest <elim.json>         # нормализует вручную сохранённый ответ Elim\n  npx tsx tools/offline.ts understand <id>            # канонизатор + генераторы (платно, кэш)\n  npx tsx tools/offline.ts docs <id> [--writers]      # собрать 6 документов\n  npx tsx tools/offline.ts all <url>                  # capture + understand + docs --writers');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

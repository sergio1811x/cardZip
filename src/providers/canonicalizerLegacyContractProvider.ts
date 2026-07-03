import type {
  CanonicalizerModelResult,
  RawProductForCanonicalizer,
} from './productCanonicalizer';
import {
  buildCanonicalizerPrompt,
  fetchCanonicalizerImageAsDataUrl,
  runTextCanonicalizer,
  runVisionCanonicalizer,
} from './productCanonicalizer';

export async function runLegacyCanonicalizerContract(
  raw: RawProductForCanonicalizer,
  apiKey: string,
): Promise<CanonicalizerModelResult | null> {
  if (!apiKey) return null;
  const prompt = buildCanonicalizerPrompt(raw);
  let result: CanonicalizerModelResult | null = null;

  const imageSources = [
    ...(raw.imageUrls ?? []).map((img) => img.url).filter(Boolean),
    raw.selectedSkuImage,
    raw.mainImageUrl,
  ].filter(Boolean) as string[];
  const imageDataUrls: string[] = [];

  for (const url of Array.from(new Set(imageSources)).slice(0, 3)) {
    const imageDataUrl = await fetchCanonicalizerImageAsDataUrl(url);
    if (imageDataUrl) imageDataUrls.push(imageDataUrl);
  }

  if (imageDataUrls.length) {
    result = await runVisionCanonicalizer(prompt, imageDataUrls, apiKey);
  }

  if (!result) {
    result = await runTextCanonicalizer(prompt, apiKey);
  }

  return result;
}

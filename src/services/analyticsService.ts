import { insertEvent } from '../db/queries/events';
import type { EventName } from '../types';
import { buildQualityMetricsPayload, type QualityMetricEntry } from '../core/qualityMetrics';

export async function track(
  userId: string,
  event: EventName,
  payload: Record<string, unknown> = {}
): Promise<void> {
  try {
    await insertEvent(userId, event, payload);
  } catch (err) {
    console.error('[analytics] Не удалось записать событие', event, err);
  }
}

export async function trackQualityMetrics(
  userId: string,
  input: {
    jobId?: string;
    offerId?: string;
    categoryType?: string;
    productKind?: string;
    metrics: QualityMetricEntry[];
  },
): Promise<void> {
  await track(userId, 'quality_metrics_recorded', buildQualityMetricsPayload(input));
}

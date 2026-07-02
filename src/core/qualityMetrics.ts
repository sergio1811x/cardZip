export interface QualityMetricEntry {
  stage: string;
  status: 'pass' | 'warn' | 'fail';
  issuesCount?: number;
  warningsCount?: number;
  durationMs?: number;
  notes?: string[];
}

export interface QualityMetricsPayload {
  jobId?: string;
  offerId?: string;
  categoryType?: string;
  productKind?: string;
  metrics: QualityMetricEntry[];
}

export function buildQualityMetricsPayload(input: QualityMetricsPayload): Record<string, unknown> {
  return {
    jobId: input.jobId ?? null,
    offerId: input.offerId ?? null,
    categoryType: input.categoryType ?? null,
    productKind: input.productKind ?? null,
    metrics: input.metrics.map((item) => ({
      stage: item.stage,
      status: item.status,
      issuesCount: item.issuesCount ?? 0,
      warningsCount: item.warningsCount ?? 0,
      durationMs: item.durationMs ?? null,
      notes: item.notes ?? [],
    })),
  };
}

export function summarizeQualityMetrics(metrics: QualityMetricEntry[]): {
  failCount: number;
  warnCount: number;
  passCount: number;
  stageNames: string[];
} {
  const failCount = metrics.filter((item) => item.status === 'fail').length;
  const warnCount = metrics.filter((item) => item.status === 'warn').length;
  const passCount = metrics.filter((item) => item.status === 'pass').length;
  return {
    failCount,
    warnCount,
    passCount,
    stageNames: metrics.map((item) => item.stage),
  };
}

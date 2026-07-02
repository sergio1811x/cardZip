import { describe, expect, it } from 'vitest';
import { buildQualityMetricsPayload, summarizeQualityMetrics } from './qualityMetrics';

describe('quality metrics helpers', () => {
  it('builds normalized payload', () => {
    const payload = buildQualityMetricsPayload({
      jobId: 'job-1',
      metrics: [
        { stage: 'fact_sheet', status: 'pass', issuesCount: 0 },
        { stage: 'qa_gate', status: 'warn', issuesCount: 1, warningsCount: 2 },
      ],
    });
    expect(Array.isArray(payload.metrics)).toBe(true);
  });

  it('summarizes stage statuses', () => {
    const summary = summarizeQualityMetrics([
      { stage: 'fact_sheet', status: 'pass' },
      { stage: 'writer', status: 'warn' },
      { stage: 'audit', status: 'fail' },
    ]);
    expect(summary.passCount).toBe(1);
    expect(summary.warnCount).toBe(1);
    expect(summary.failCount).toBe(1);
  });
});

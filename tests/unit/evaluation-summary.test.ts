import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRecords } from '../evaluation/summary.js';
import type { EvaluationRecord } from '../evaluation/evaluation.js';

test('campaign summary counts calls once and distinguishes repeated from partition disagreements', () => {
  const records: EvaluationRecord[] = [];
  for (const grouping of ['natural', 'partitioned'] as const) for (const repeat of [1, 2, 3]) {
    const docs = grouping === 'natural' && repeat === 2;
    records.push({ version: 2, runId: `${grouping}-${repeat}`,
      source: { caseId: 'sample', caseFingerprint: 'x', diffSha256: 'x', baseSha: 'a', headSha: 'b', testedSha: 'b', metadataCommit: 'a', snapshot: 'sample' },
      variant: { context: 'enriched', grouping, maxGroupBytes: 8192 }, repeat,
      date: { started: '2026-01-01T00:00:00.000Z', finished: '2026-01-01T00:00:00.010Z' },
      sdk: { package: '@typesafe-ai/sdk', version: '0.6.0', model: 'jev-1.13.0', requestedModel: 'jev-1.13.0' },
      calls: [{ index: 0, request: { body: {}, serialized: '{}', sha256: 'x' }, response: { status: 200, body: { usage: { input_tokens: 3, output_tokens: 1 } } }, error: null, duration_ms: 10 }],
      observation: { strategy: 'whole-diff', status: 'complete', chunks: [] }, observationError: null,
      policy: { bypass: false, reason: null }, error: null,
      evaluation: {
        decisions: { unit: true, docs }, proposed: { unit: true, docs }, effective: { unit: true, docs: true },
        tasks: { proposed: {}, effective: {} }, actionOutputs: { proposed: {}, effective: {} },
        metrics: { relevant: 1, relevantMisses: 0, irrelevant: 1, correctIrrelevantOmissions: docs ? 0 : 1,
          irrelevantRetained: docs ? 1 : 0, unknown: 0, mismatches: docs ? 1 : 0 },
      },
    });
  }
  const summary = summarizeRecords(records);
  assert.equal(summary.calls, 6);
  assert.deepEqual(summary.tokens, { input: 18, output: 6 });
  assert.equal(summary.mean_run_ms, 10);
  assert.equal(summary.comparison.length, 1);
  for (const row of summary.comparison) {
    assert.equal(row.metrics.correctIrrelevantOmissions, 5);
    assert.equal(row.repeat_disagreements, 1);
    assert.equal(row.partition_disagreements, 1);
  }
});

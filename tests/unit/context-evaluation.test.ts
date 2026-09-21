import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateCase, metricsFor, summarize, syntheticCases } from '../evaluation/context-resolution.js';
import { selectTasks } from '../../src/policy.js';

test('offline context comparison measures bounded preparation waves', async () => {
  const item = syntheticCases()[0]!;
  const records = await Promise.all(([1, 2, 3] as const).map(passCount => evaluateCase(item, passCount, 'offline', 'offline')));
  assert.deepEqual(records.map(record => record.metrics.recalled_files), [1, 2, 3]);
  assert.deepEqual(records.map(record => record.metrics.incorrect_skips.length), [1, 1, 0]);
  assert.ok(records.every(record => record.status === 'complete'));
  assert.deepEqual(summarize(records).waves.map(wave => wave.incomplete), [0, 0, 0]);
});

test('recall stays per task and fallback is not an incorrect model skip', () => {
  const item = syntheticCases()[0]!;
  const annotated = { ...item, expectedContext: { unit: ['tools/run_unit.py'], docs: ['tools/run_unit.py'] } };
  const selection = { model: 'jev-1.13.0', skip_below: 0.05, tasks: {
    unit: { always: true, evidence: { description: 'unit' } },
    docs: { evidence: { description: 'docs' } },
  } };
  const plan = selectTasks({ selection, changedPaths: ['src/cart.py'], decisions: { unit: false, docs: false }, mode: 'enforce', forceAllReason: { status: 'fallback', code: 'context-too-large' } });
  const metrics = metricsFor(annotated, { unit: [{ path: 'tools/run_unit.py', sha256: 'a' }], docs: [] }, plan);
  assert.equal(metrics.recalled_files, 1);
  assert.deepEqual(metrics.missing_files, { unit: [], docs: ['tools/run_unit.py'] });
  assert.deepEqual(metrics.incorrect_skips, []);
  assert.deepEqual(metrics.irrelevant_retained, ['docs']);
});

test('offline records expose incomplete stages separately from incorrect skips', () => {
  const record = {
    version: 1 as const, case_id: 'case', case_hash: 'hash', pass_count: 1 as const, status: 'incomplete' as const,
    started: '', finished: '', timings_ms: { total: 0, context: 0, final: 0 },
    completeness: { status: 'incomplete' as const, context: 'incomplete' as const, metadata: 'incomplete' as const, final: 'incomplete' as const, reasons: ['provider-error'] },
    context: {}, selected_files: {}, final: { status: 'incomplete' as const, decisions: { unit: null }, plan: {} as never, observation: null, calls: [], usage: null, duration_ms: 0, error: 'jev-error' },
    metrics: { needed_files: 1, recalled_files: 0, missing_files: { unit: ['config.toml'] }, file_recall: 0, incorrect_skips: [], irrelevant_retained: [] },
  };
  const summary = summarize([record]);
  assert.equal(summary.waves[0]!.incomplete, 1);
  assert.equal(summary.waves[0]!.metrics.incorrect_skips, 0);
});

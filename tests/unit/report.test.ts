import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REASONS, type ExecutionPlan } from '../../src/policy.js';
import { actionOutputs, validateReport, summary, type Report } from '../../src/report.js';
import schema from '../../schemas/report.schema.json';

function report(): Report {
  return {
    version: 5, metadata_sha: 'a'.repeat(40), base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40),
    tested_sha: 'c'.repeat(40), tested_ref: 'merge', diff_base_sha: null,
    selection_hash: 'd'.repeat(64), skip_below: 0.05, diff_hash: null, diff_bytes: null, changed_path_count: null,
    mode: 'shadow', status: 'bypassed', model: { requested: 'provider/alias', expected: 'jev-1.13.0', returned: null },
    durations_ms: { collection: 1, jev: null, total: 1 }, usage: null,
    tasks: { unit: { proposed_run: null, run: true, reasons: ['missing-api-key'] } },
    observation: null, observation_error: null, job_metadata: {},
  };
}

test('v5 requires complete provenance and rejects historical versions and fields', () => {
  const value = report();
  validateReport(value);
  assert.deepEqual([...schema.properties.tasks.additionalProperties.properties.reasons.items.enum].sort(), [...REASONS].sort());
  for (const version of [1, 2, 3, 4, 6]) assert.throws(() => validateReport({ ...value, version }), /invalid-report/);
  for (const field of schema.required) {
    const missing = { ...value } as Record<string, unknown>;
    delete missing[field];
    assert.throws(() => validateReport(missing), /invalid-report/, field);
  }
  for (const key of ['config_sha', 'config_source', 'catalog_hash', 'diff']) {
    assert.throws(() => validateReport({ ...value, [key]: 'private source' }));
  }
  assert.throws(() => validateReport({ ...value, tasks: { unit: { ...value.tasks.unit, probability: 0.1 } } }));
  for (const skip_below of [0, 1]) validateReport({ ...value, skip_below });
  for (const skip_below of [-0.1, 1.1, NaN, Infinity, '0.05']) assert.throws(() => validateReport({ ...value, skip_below }));
  for (const requested of ['invalid model', 'alias\n', 'm'.repeat(129)]) {
    assert.throws(() => validateReport({ ...value, model: { ...value.model, requested } }));
  }
  assert.throws(() => validateReport({ ...value, model: { ...value.model, expected: 'jev-latest' } }));
  assert.throws(() => validateReport({ ...value, usage: { input_tokens: 1, output_tokens: 1, raw: 'private error' } }));
  assert.throws(() => validateReport({ ...value, tasks: { unit: { ...value.tasks.unit, reasons: ['generated explanation'] } } }));
});

test('observation scores remain source-free and appear below decisions in collapsible details', () => {
  const chunk = {
    index: 0, start_byte: 0, end_byte: 32, diff_hash: 'e'.repeat(64), state_hash: 'f'.repeat(64), diff_bytes: 32,
    status: 'completed' as const, probabilities: { unit: 0.02 }, model: 'jev-1.13.0',
    usage: { input_tokens: 10, output_tokens: 2 }, duration_ms: 12, error: null,
  };
  const value: Report = { ...report(), observation: { strategy: 'chunked-diff', status: 'incomplete', chunks: [chunk,
    { ...chunk, index: 1, status: 'failed', probabilities: null, model: null, usage: null, duration_ms: 100, error: 'jev-timeout' },
  ] } };
  validateReport(value);
  for (const key of ['diff', 'path', 'raw']) {
    assert.throws(() => validateReport({ ...value, observation: { ...value.observation, chunks: [{ ...chunk, [key]: 'private source' }] } }));
  }
  const text = summary(value);
  assert.match(text, /bypassed \(shadow\)/);
  assert.match(text, /\| unit \| Run \| — \| missing-api-key \|/);
  assert.ok(text.indexOf('| unit |') < text.indexOf('<details>'));
  assert.match(text, /<summary>Selection details<\/summary>/);
  assert.match(text, /Observation status: incomplete \(chunked-diff\)/);
  assert.match(text, /unit=0\.02/);
  assert.match(text, /jev-timeout/);
  assert.match(text, /No cross-chunk aggregate/);
  assert.match(text, /<\/details>/);
  assert.match(summary(report()), /not-collected/);
});

test('named outputs preserve effective booleans and stable ordering, including an empty plan', () => {
  for (const run of [{ zeta: false, alpha: true }, { zeta: true, alpha: true }, {}]) {
    const selected = Object.keys(run).filter(id => run[id as keyof typeof run]);
    const plan: ExecutionPlan = { mode: 'enforce', status: 'planned', tasks: {}, run,
      selected, matrix: { include: selected.map(task => ({ task })) }, hasTasks: selected.length > 0 };
    const outputs = actionOutputs(plan, 'a'.repeat(40), '/tmp/report.json');
    assert.deepEqual(Object.keys(outputs).slice(7), Object.keys(run).sort());
    for (const [id, effective] of Object.entries(run)) assert.equal(outputs[id], String(effective));
    assert.deepEqual(JSON.parse(outputs.run!), run);
    assert.deepEqual(JSON.parse(outputs.selected!), selected);
    assert.deepEqual(JSON.parse(outputs.matrix!), plan.matrix);
    assert.equal(outputs['has-tasks'], String(selected.length > 0));
    assert.equal(outputs['tested-sha'], 'a'.repeat(40));
    assert.equal(outputs['report-path'], '/tmp/report.json');
  }
});

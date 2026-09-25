import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REASONS, type ExecutionPlan } from '../../src/policy.js';
import { actionOutputs, validateReport, summary, type Report } from '../../src/report.js';
import schema from '../../schemas/report.schema.json';

function report(): Report {
  return {
    version: 9, base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40),
    tested_sha: 'c'.repeat(40), tested_ref: 'merge', diff_base_sha: null,
    selection_hash: 'd'.repeat(64), changed_path_count: null,
    manifest: { complete: false, hash: null, change_count: null },
    analysis: {
      manifest_entries: null, patches_requested: 0, patches_read: 0,
      patch_bytes_read: 0, patch_bytes_delivered: 0, changes_read: 0, changes_total: null,
      bytes_per_token: null,
      jev_calls: 0, analysis_bytes: 0, attempts: 0, limits_reached: [],
      analysed_tasks: [], required_without_analysis: ['unit'], task_states: {}, coverage: {},
      fallback_scope: 'none', fallback_tasks: [],
    },
    mode: 'shadow', status: 'bypassed', model: { requested: 'provider/alias', expected: 'jev-1.13.0', returned: null },
    durations_ms: { collection: 1, jev: null, total: 1 }, usage: null,
    tasks: { unit: { proposed_run: null, run: true, reasons: ['missing-api-key'] } },
    observation: null, observation_error: null,
  };
}

test('v9 requires complete provenance and rejects historical versions and fields', () => {
  const value = report();
  validateReport(value);
  assert.deepEqual([...schema.properties.tasks.additionalProperties.properties.reasons.items.enum].sort(), [...REASONS].sort());
  for (const version of [1, 2, 3, 4, 5, 6, 7, 8]) assert.throws(() => validateReport({ ...value, version }), /invalid-report/);
  for (const field of schema.required) {
    const missing = { ...value } as Record<string, unknown>;
    delete missing[field];
    assert.throws(() => validateReport(missing), /invalid-report/, field);
  }
  for (const key of ['config_sha', 'config_source', 'catalog_hash', 'diff', 'skip_below', 'judgment', 'metadata_sha', 'job_metadata', 'context_resolution', 'diff_hash', 'diff_bytes']) {
    assert.throws(() => validateReport({ ...value, [key]: 'private source' }));
  }
  assert.throws(() => validateReport({ ...value, tasks: { unit: { ...value.tasks.unit, probability: 0.1 } } }));
  for (const requested of ['invalid model', 'alias\n', 'm'.repeat(129)]) {
    assert.throws(() => validateReport({ ...value, model: { ...value.model, requested } }));
  }
  assert.throws(() => validateReport({ ...value, model: { ...value.model, expected: 'jev-latest' } }));
  assert.throws(() => validateReport({ ...value, usage: { input_tokens: 1, output_tokens: 1, raw: 'private error' } }));
  assert.throws(() => validateReport({ ...value, tasks: { unit: { ...value.tasks.unit, reasons: ['generated explanation'] } } }));
});

test('observation judgments remain source-free and appear below decisions in collapsible details', () => {
  const answer = { choice: 'independent', probabilities: { required: 0.02, independent: 0.93, unresolved: 0.05 }, confidence: 0.82 };
  const chunk = {
    index: 0, unit_index: 0, change_ids: ['c0'], start_byte: 0, end_byte: 32,
    diff_hash: 'e'.repeat(64), state_hash: 'f'.repeat(64), diff_bytes: 32,
    status: 'completed' as const, judgments: { unit: answer }, model: 'jev-1.13.0',
    usage: { input_tokens: 10, output_tokens: 2 }, duration_ms: 12, error: null,
  };
  const value: Report = { ...report(), observation: { strategy: 'chunked-diff', status: 'incomplete', chunks: [chunk,
    { ...chunk, index: 1, status: 'failed', judgments: null, model: null, usage: null, duration_ms: 100, error: 'jev-timeout' },
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
  assert.match(text, /unit=independent/);
  assert.match(text, /independent=0\.93/);
  assert.match(text, /confidence=0\.82/);
  assert.match(text, /jev-timeout/);
  assert.match(text, /No cross-group aggregate/);
  assert.match(text, /<\/details>/);
  assert.match(summary(report()), /not-collected/);
  const withChoice = (judgment: unknown) => ({ ...report(), observation: {
    strategy: 'whole-diff', status: 'complete', chunks: [{ ...chunk, judgments: { unit: judgment } }],
  } });
  validateReport(withChoice(answer));
  for (const invalid of [{ ...answer, choice: 'ignore' }, { ...answer, content: 'private source' },
    { ...answer, probabilities: { independent: 1 } }, { ...answer, confidence: 1.1 }]) {
    assert.throws(() => validateReport(withChoice(invalid)));
  }
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

test('the summary reports what was measured and what was never read', () => {
  const value: Report = { ...report(), status: 'fallback', manifest: { complete: true, hash: 'a'.repeat(64), change_count: 3 },
    analysis: { ...report().analysis, manifest_entries: 3, patches_requested: 2, patches_read: 1,
      patch_bytes_read: 6000, patch_bytes_delivered: 4096, changes_read: 2, changes_total: 3,
      jev_calls: 3, analysis_bytes: 2000,
      limits_reached: ['collected-patch-bytes'], analysed_tasks: ['unit'], required_without_analysis: [],
      task_states: { unit: 'fallback-run' }, coverage: { unit: false },
      fallback_scope: 'partial', fallback_tasks: ['unit'] } };
  validateReport(value);
  const text = summary(value);
  assert.match(text, /Inventory: complete, 3 change\(s\), hash aaaaaaaaaaaa\./);
  assert.match(text, /Collection: 2\/3 change\(s\) read over 1\/2 patch unit\(s\); 6000 byte\(s\) read, 4096 delivered\./);
  assert.match(text, /Inference: 3 call\(s\) and 2000 request byte\(s\)\./);
  assert.match(text, /Limits reached: collected-patch-bytes; partial fallback: unit\./);
  assert.match(text, /not token counts\.|not token counts/);
  assert.doesNotMatch(text, /private source/);
});

test('an incomplete inventory is displayed as incomplete with no hash', () => {
  const text = summary(report());
  assert.match(text, /Inventory: incomplete, — change\(s\), hash —\./);
  assert.match(text, /Limits reached: none; no fallback\./);
  assert.match(text, /required without analysis: unit\./);
});

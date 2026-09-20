import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectTasks, REASONS } from '../../src/policy.js';
import { actionOutputs, validateReport, summary } from '../../src/report.js';
import schema from '../../schemas/report.schema.json';
import { catalog } from '../fixtures/catalog.js';

test('report schema covers every deterministic reason and rejects arbitrary publishable data', () => {
  assert.deepEqual([...schema.properties.tasks.additionalProperties.properties.reasons.items.enum].sort(), [...REASONS].sort());
  const plan = selectTasks({ catalog: catalog(), changedPaths: [], mode: 'shadow', forceAllReason: { status: 'bypassed', code: 'missing-api-key' } });
  const report = { version: 1, config_sha: 'a'.repeat(40), base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40), tested_sha: 'c'.repeat(40),
    catalog_hash: 'd'.repeat(64), diff_hash: null, diff_bytes: null, changed_path_count: null,
    mode: 'shadow', status: 'bypassed', model: { requested: 'jev-1.13.0', returned: null },
    durations_ms: { collection: 1, jev: null, total: 1 }, usage: null, tasks: plan.tasks };
  validateReport(report);
  validateReport({ ...report, model: { requested: 'jev-1.13-free', expected: 'jev-1.13.0', returned: 'jev-1.13.0' } });
  assert.throws(() => validateReport({ ...report, model: { ...report.model, expected: 'jev-latest' } }));
  for (const requested of ['invalid model', 'jev-free\n', 'm'.repeat(129)]) {
    assert.throws(() => validateReport({ ...report, model: { ...report.model, requested } }));
  }
  assert.throws(() => validateReport({ ...report, diff: 'private source' }));
  assert.throws(() => validateReport({ ...report, usage: { input_tokens: 1, output_tokens: 1, raw: 'private error' } }));
  assert.throws(() => validateReport({ ...report, tasks: { unit: { ...plan.tasks.unit, reasons: ['generated explanation'] } } }));
  assert.match(summary(report), /missing-api-key/);
  const outputs = actionOutputs(plan, report.tested_sha, '/tmp/report.json');
  assert.deepEqual(Object.keys(outputs), ['run', 'selected', 'matrix', 'has-tasks', 'status', 'tested-sha', 'report-path', 'build', 'e2e', 'helm', 'prepare', 'unit']);
  assert.ok(Object.values(JSON.parse(outputs.run!)).every(value => value === true));
  assert.ok(Object.values(plan.tasks).every(task => task.probability === null && task.proposed_run === null));
});

test('named task outputs use effective string booleans for selection, dependencies, shadow and degradation', () => {
  const value = catalog();
  const probabilities = { helm: 0, e2e: 1, build: 0, prepare: 0 };
  const cases = [
    selectTasks({ catalog: value, changedPaths: [], probabilities, mode: 'enforce' }),
    selectTasks({ catalog: value, changedPaths: [], probabilities, mode: 'shadow' }),
    selectTasks({ catalog: value, changedPaths: [], mode: 'enforce', forceAllReason: { status: 'bypassed', code: 'force-all' } }),
    selectTasks({ catalog: value, changedPaths: [], probabilities: {}, mode: 'enforce' }),
  ];
  for (const plan of cases) {
    const outputs = actionOutputs(plan, 'a'.repeat(40), '/tmp/report.json');
    assert.equal(outputs.unit, 'true');
    assert.equal(outputs.e2e, 'true');
    assert.equal(outputs.build, 'true');
    assert.equal(outputs.prepare, 'true');
    assert.equal(outputs.helm, plan.mode === 'enforce' && plan.status === 'planned' ? 'false' : 'true');
    for (const [id, effective] of Object.entries(JSON.parse(outputs.run!))) {
      assert.equal(outputs[id], String(effective), `named output disagrees with run: ${id}`);
    }
    assert.deepEqual(Object.keys(outputs).slice(7), ['build', 'e2e', 'helm', 'prepare', 'unit']);
  }
  const empty = selectTasks({ catalog: { ...value, tasks: {} }, changedPaths: [], mode: 'enforce' });
  const outputs = actionOutputs(empty, 'a'.repeat(40), '/tmp/report.json');
  assert.equal(outputs['has-tasks'], 'false');
  assert.deepEqual(JSON.parse(outputs.selected!), []);
  assert.equal(Object.keys(outputs).length, 7);
});

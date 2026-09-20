import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectTasks, semanticTaskIds, type Mode } from '../../src/policy.js';
import { catalog } from '../fixtures/catalog.js';

const scores = { helm: 0, e2e: 0, build: 0, prepare: 0 };
test('strict threshold: zero skips, equality and maximum retain', () => {
  for (const [probability, expected] of [[0, false], [0.04999, false], [0.05, true], [1, true]] as const) {
    const plan = selectTasks({ catalog: catalog(), changedPaths: [], probabilities: { ...scores, helm: probability }, mode: 'enforce' });
    assert.equal(plan.run.helm, expected);
    assert.equal(plan.run.unit, true);
    assert.equal(plan.tasks.unit!.probability, null);
  }
});
test('missing, non-numeric, nonfinite, out-of-range or unexpected probabilities produce global fallback', () => {
  for (const probabilities of [{}, { ...scores, bogus: 0 }, ...[undefined, null, '0.9', NaN, Infinity, -0.1, 1.1].map(helm => ({ ...scores, helm }))]) {
    const plan = selectTasks({ catalog: catalog(), changedPaths: [], probabilities, mode: 'enforce' });
    assert.equal(plan.status, 'fallback');
    assert.ok(Object.values(plan.run).every(Boolean));
    assert.ok(Object.values(plan.tasks).every(task => task.probability === null && task.proposed_run === null));
  }
});
test('path matches impose a task; missing matches leave semantic eligibility', () => {
  assert.deepEqual(semanticTaskIds(catalog(), []), ['build', 'e2e', 'helm', 'prepare']);
  const plan = selectTasks({ catalog: catalog(), changedPaths: ['charts/.hidden/value.yml'], probabilities: { e2e: 0, build: 0, prepare: 0 }, mode: 'enforce' });
  assert.equal(plan.run.helm, true);
  assert.deepEqual(plan.tasks.helm!.reasons, ['path-match']);
});
test('semantic and deterministic selections add dependencies transitively', () => {
  const plan = selectTasks({ catalog: catalog(), changedPaths: [], probabilities: { ...scores, e2e: 1 }, mode: 'enforce' });
  assert.deepEqual(plan.selected, ['build', 'e2e', 'prepare', 'unit']);
  assert.ok(plan.tasks.prepare!.reasons.includes('dependency'));
  const value = catalog(); value.tasks.e2e!.always = true;
  assert.deepEqual(semanticTaskIds(value, []), ['helm']);
  assert.deepEqual(selectTasks({ catalog: value, changedPaths: [], probabilities: { helm: 0 }, mode: 'enforce' }).selected, plan.selected);
});
test('shadow exposes only the full effective plan; proposal lives in task report', () => {
  const plan = selectTasks({ catalog: catalog(), changedPaths: [], probabilities: scores, mode: 'shadow' });
  assert.deepEqual(plan.selected, ['build', 'e2e', 'helm', 'prepare', 'unit']);
  assert.deepEqual(plan.matrix.include, plan.selected.map(task => ({ task })));
  assert.equal(plan.tasks.helm!.proposed_run, false);
  assert.equal(plan.tasks.helm!.run, true);
  assert.deepEqual(plan.tasks.helm!.reasons, ['jev-below-threshold', 'shadow-mode']);
});
test('catalog, workflows and configured protected paths bypass semantic probabilities', () => {
  for (const path of ['.github/task-routing.yaml', '.github/workflows/ci.yml', 'ci/test.sh']) {
    const value = catalog(); value.force_all_paths = ['ci/**'];
    const plan = selectTasks({ catalog: value, changedPaths: [path], mode: 'enforce' });
    assert.equal(plan.status, 'bypassed'); assert.ok(Object.values(plan.run).every(Boolean));
  }
  assert.equal(selectTasks({ catalog: catalog(), changedPaths: ['policy/custom.yml'], configPath: 'policy/custom.yml', mode: 'enforce' }).status, 'bypassed');
});
test('stable order, purity, no mutation, explicit force, empty selection, zero threshold', () => {
  const value = catalog(); const original = structuredClone(value);
  const first = selectTasks({ catalog: value, changedPaths: [], probabilities: scores, mode: 'enforce' });
  value.tasks = Object.fromEntries(Object.entries(value.tasks).reverse());
  assert.deepEqual(selectTasks({ catalog: value, changedPaths: [], probabilities: scores, mode: 'enforce' }), first);
  assert.deepEqual({ ...value, tasks: original.tasks }, original);
  const forced = selectTasks({ catalog: value, changedPaths: [], mode: 'enforce', forceAllReason: { status: 'bypassed', code: 'force-all' } });
  assert.ok(Object.values(forced.run).every(Boolean));
  value.tasks = { optional: { question: 'Does this affect rendering?' } };
  const empty = selectTasks({ catalog: value, changedPaths: [], mode: 'enforce', probabilities: { optional: 0 } });
  assert.deepEqual(empty.selected, []); assert.deepEqual(empty.matrix, { include: [] }); assert.equal(empty.hasTasks, false);
  value.skip_below = 0;
  assert.equal(selectTasks({ catalog: value, changedPaths: [], mode: 'enforce', probabilities: { optional: 0 } }).run.optional, true);
  assert.throws(() => selectTasks({ catalog: value, changedPaths: [], mode: 'invalid' as Mode }));
});

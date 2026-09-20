import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectTasks, type Mode } from '../../src/policy.js';
import { selection } from '../fixtures/selection.js';

const decisions = { helm: false, e2e: false, build: false, prepare: false };
test('boolean decisions select independently without workflow dependency closure', () => {
  const plan = selectTasks({ selection: selection(), changedPaths: [], decisions: { ...decisions, e2e: true }, mode: 'enforce' });
  assert.deepEqual(plan.selected, ['e2e', 'unit']);
  assert.equal(Object.hasOwn(plan.tasks.e2e!, 'probability'), false);
});
test('missing decisions conservatively retain tasks', () => {
  const plan = selectTasks({ selection: selection(), changedPaths: [], decisions: {}, mode: 'enforce' });
  assert.ok(Object.values(plan.run).every(Boolean));
});
test('path matches impose a task; missing matches leave semantic eligibility', () => {
  const unmatched = selectTasks({ selection: selection(), changedPaths: ['source.ts'], decisions, mode: 'enforce' });
  assert.equal(unmatched.run.helm, false);
  const plan = selectTasks({ selection: selection(), changedPaths: ['charts/.hidden/value.yml'], decisions, mode: 'enforce' });
  assert.equal(plan.run.helm, true);
  assert.deepEqual(plan.tasks.helm!.reasons, ['path-match']);
});
test('shadow exposes full effective plan and preserves proposal', () => {
  const plan = selectTasks({ selection: selection(), changedPaths: [], decisions, mode: 'shadow' });
  assert.deepEqual(plan.selected, ['build', 'e2e', 'helm', 'prepare', 'unit']);
  assert.deepEqual(plan.matrix.include, plan.selected.map(task => ({ task })));
  assert.equal(plan.tasks.helm!.proposed_run, false);
  assert.equal(plan.tasks.helm!.run, true);
});
test('workflow changes retain all tasks', () => {
  const plan = selectTasks({ selection: selection(), changedPaths: ['.github/workflows/ci.yml'], decisions, mode: 'enforce' });
  assert.equal(plan.status, 'bypassed'); assert.ok(Object.values(plan.run).every(Boolean));
});
test('stable order, purity, explicit force and empty selection', () => {
  const value = selection(); const original = structuredClone(value);
  const first = selectTasks({ selection: value, changedPaths: [], decisions, mode: 'enforce' });
  assert.deepEqual(value, original);
  value.tasks = Object.fromEntries(Object.entries(value.tasks).reverse());
  assert.deepEqual(selectTasks({ selection: value, changedPaths: [], decisions, mode: 'enforce' }), first);
  const forced = selectTasks({ selection: value, changedPaths: [], mode: 'enforce', forceAllReason: { status: 'bypassed', code: 'force-all' } });
  assert.ok(Object.values(forced.run).every(Boolean));
  value.tasks = {};
  const empty = selectTasks({ selection: value, changedPaths: [], mode: 'enforce', decisions: {} });
  assert.deepEqual(empty.selected, []); assert.deepEqual(empty.matrix, { include: [] }); assert.equal(empty.hasTasks, false);
  assert.throws(() => selectTasks({ selection: value, changedPaths: [], mode: 'invalid' as Mode }));
});

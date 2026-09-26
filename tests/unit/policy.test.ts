import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectTasks } from '../../src/policy.js';
import { selection } from '../fixtures/selection.js';

const decisions = { unit: true, helm: false, e2e: false, build: false, prepare: false };
test('boolean decisions select independently without workflow dependency closure', () => {
  const plan = selectTasks({ selection: selection(), decisions: { ...decisions, e2e: true } });
  assert.deepEqual(plan.selected, ['e2e', 'unit']);
  assert.equal(Object.hasOwn(plan.tasks.e2e!, 'probability'), false);
});
test('missing decisions conservatively retain tasks', () => {
  const plan = selectTasks({ selection: selection(), decisions: {} });
  assert.ok(Object.values(plan.run).every(Boolean));
});

test('stable order, purity, safety fallback and empty selection', () => {
  const value = selection(); const original = structuredClone(value);
  const first = selectTasks({ selection: value, decisions });
  assert.deepEqual(value, original);
  value.tasks = Object.fromEntries(Object.entries(value.tasks).reverse());
  assert.deepEqual(selectTasks({ selection: value, decisions }), first);
  const forced = selectTasks({ selection: value, safetyReason: { status: 'fallback', code: 'sha-incoherent' } });
  assert.ok(Object.values(forced.run).every(Boolean));
  value.tasks = {};
  const empty = selectTasks({ selection: value, decisions: {} });
  assert.deepEqual(empty.selected, []); assert.deepEqual(empty.matrix, { include: [] }); assert.equal(empty.hasTasks, false);
});

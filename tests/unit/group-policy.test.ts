import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectTasks } from '../../src/policy.js';
import { selection } from '../fixtures/selection.js';

test('missing group judgments cannot justify omission; known positives remain visible', () => {
  const plan = selectTasks({ selection: selection(), changedPaths: [], mode: 'enforce',
    decisions: { helm: false, e2e: true, build: false, prepare: null }, observationError: 'jev-timeout' });
  // The failure is scoped to the task it concerns: `prepare` is retained and the
  // root status stays fallback, while tasks with a complete decision keep it.
  assert.equal(plan.status, 'fallback');
  assert.equal(plan.run.prepare, true);
  assert.equal(plan.run.e2e, true);
  assert.equal(plan.run.unit, true);
  assert.equal(plan.run.helm, false);
  assert.equal(plan.run.build, false);
  assert.equal(plan.tasks.e2e!.proposed_run, true);
  assert.equal(plan.tasks.prepare!.proposed_run, null);
  assert.ok(plan.tasks.prepare!.reasons.includes('jev-timeout'));
});

test('an exclusion never survives a missing coverage obligation', () => {
  const plan = selectTasks({ selection: selection(), changedPaths: [], mode: 'enforce',
    decisions: { helm: false, e2e: false, build: false, prepare: false },
    coverage: { helm: true, e2e: false, build: true, prepare: true },
    taskErrors: { e2e: 'patch-unavailable' } });
  assert.equal(plan.run.helm, false);
  assert.equal(plan.run.e2e, true);
  assert.deepEqual(plan.tasks.e2e!.reasons, ['patch-unavailable']);
  assert.equal(plan.tasks.e2e!.proposed_run, null);
  assert.equal(plan.status, 'fallback');
});

test('a per-task error does not erase another task complete decision', () => {
  const plan = selectTasks({ selection: selection(), changedPaths: [], mode: 'enforce',
    decisions: { helm: false, e2e: null, build: false, prepare: false },
    coverage: { helm: true, e2e: false, build: true, prepare: true },
    taskErrors: { e2e: 'jev-error' } });
  assert.deepEqual(plan.selected, ['e2e', 'unit']);
  assert.deepEqual(plan.tasks.helm!.reasons, ['jev-independent']);
});

test('deterministic reasons survive a separate observation failure', () => {
  const plan = selectTasks({ selection: selection(), changedPaths: ['charts/a.yml'], mode: 'shadow',
    decisions: { helm: null }, observationError: 'jev-timeout',
    forceAllReason: { status: 'bypassed', code: 'protected-path' } });
  assert.equal(plan.status, 'bypassed');
  assert.deepEqual(plan.tasks.helm!.reasons, ['path-match', 'protected-path', 'shadow-mode']);
  assert.ok(plan.tasks.unit!.reasons.includes('always'));
});

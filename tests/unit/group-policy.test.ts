import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectTasks } from '../../src/policy.js';
import { catalog } from '../fixtures/catalog.js';

test('missing group judgments cannot justify omission; known positives and dependencies remain visible', () => {
  const plan = selectTasks({ catalog: catalog(), changedPaths: [], mode: 'enforce',
    decisions: { helm: false, e2e: true, build: false, prepare: null }, observationError: 'jev-timeout' });
  assert.equal(plan.status, 'fallback');
  assert.ok(Object.values(plan.run).every(Boolean));
  assert.equal(plan.tasks.e2e!.proposed_run, true);
  assert.equal(plan.tasks.prepare!.proposed_run, true);
  assert.ok(plan.tasks.build!.reasons.includes('dependency'));
  assert.ok(plan.tasks.prepare!.reasons.includes('jev-timeout'));
  assert.ok(Object.values(plan.tasks).every(task => task.probability === null));
});

test('deterministic reasons survive a separate observation failure', () => {
  const plan = selectTasks({ catalog: catalog(), changedPaths: ['charts/a.yml'], mode: 'shadow',
    decisions: { helm: null }, observationError: 'jev-timeout',
    forceAllReason: { status: 'bypassed', code: 'protected-path' } });
  assert.equal(plan.status, 'bypassed');
  assert.deepEqual(plan.tasks.helm!.reasons, ['path-match', 'protected-path', 'shadow-mode']);
  assert.ok(plan.tasks.unit!.reasons.includes('always'));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnalysisBudget, BudgetError, PATCH_UNIT_BYTES } from '../../src/budget.js';

const budget = (overrides: Partial<ConstructorParameters<typeof AnalysisBudget>[0]> = {}) => new AnalysisBudget({
  maxCollectedPatchBytes: 1000, maxAnalysisBytes: 1000, maxJevCalls: 4,
  deadline: performance.now() + 10_000, ...overrides,
});

test('a reservation is debited before dispatch so concurrent callers cannot race past a limit', () => {
  const value = budget({ maxAnalysisBytes: 100, maxJevCalls: 8 });
  // Three "workers" reserve before any of them sends.
  const first = value.reserve('observation', 40);
  const second = value.reserve('observation', 40);
  assert.throws(() => value.reserve('observation', 40), BudgetError);
  assert.equal(value.counters.analysis_bytes, 0, 'nothing is counted as sent yet');
  first.commit(); second.commit();
  assert.equal(value.counters.analysis_bytes, 80);
  assert.equal(value.counters.jev_calls, 2);
});

test('an unsent reservation is released, a dispatched one is not', () => {
  const value = budget({ maxAnalysisBytes: 100 });
  const reservation = value.reserve('observation', 90);
  reservation.release();
  assert.equal(value.counters.analysis_bytes, 0);
  value.reserve('observation', 90).commit();
  assert.equal(value.counters.analysis_bytes, 90);
  const committed = value.reserve('observation', 10);
  committed.commit();
  committed.release();
  assert.equal(value.counters.analysis_bytes, 100, 'a sent call is never refunded');
});

test('preparation draws on a sub-limit and cannot starve the decision', () => {
  const value = budget({ maxAnalysisBytes: 1000, maxJevCalls: 4 });
  value.reserve('preparation', 400).commit();
  // Half the analysis allowance and half the calls are the preparation ceiling.
  assert.throws(() => value.reserve('preparation', 200), BudgetError);
  assert.equal(value.fits('observation', 200), true);
  value.reserve('preparation', 100).commit();
  assert.throws(() => value.reserve('preparation', 1), BudgetError);
  assert.equal(value.counters.preparation_calls, 2);
  assert.equal(value.counters.observation_calls, 0);
  value.reserve('observation', 400).commit();
  assert.equal(value.counters.jev_calls, 3);
  assert.equal(value.counters.analysis_bytes, 900);
});

test('the call ceiling counts dispatched calls whatever their outcome', () => {
  const value = budget({ maxJevCalls: 2, maxAnalysisBytes: 10_000 });
  value.reserve('observation', 1).commit();
  value.reserve('observation', 1).commit();
  assert.throws(() => value.reserve('observation', 1), BudgetError);
  assert.deepEqual(value.limitsReached, ['jev-calls']);
});

test('patch allowance never exceeds the per-unit cap and is exhausted by real reads', () => {
  const value = budget({ maxCollectedPatchBytes: PATCH_UNIT_BYTES * 3 });
  assert.equal(value.patchUnitAllowance(), PATCH_UNIT_BYTES);
  value.notePatchRequested();
  value.spendPatchBytes(PATCH_UNIT_BYTES);
  assert.equal(value.counters.collected_patch_bytes, PATCH_UNIT_BYTES);
  assert.equal(value.counters.patches_read, 1);
  assert.equal(value.counters.patches_requested, 1);

  const small = budget({ maxCollectedPatchBytes: 100 });
  small.spendPatchBytes(60);
  assert.equal(small.patchUnitAllowance(), 40);
  assert.throws(() => small.spendPatchBytes(41), BudgetError);
  assert.equal(small.counters.collected_patch_bytes, 60, 'a refused read is never counted');
  assert.deepEqual(small.limitsReached, ['collected-patch-bytes']);
});

test('limits and counters are validated and reported, never estimated', () => {
  assert.throws(() => new AnalysisBudget({ maxCollectedPatchBytes: -1, maxAnalysisBytes: 1, maxJevCalls: 1, deadline: 0 }));
  assert.throws(() => new AnalysisBudget({ maxCollectedPatchBytes: 1.5, maxAnalysisBytes: 1, maxJevCalls: 1, deadline: 0 }));
  const expired = budget({ deadline: performance.now() - 1 });
  assert.equal(expired.expired(), true);
  assert.ok(expired.remainingMs() <= 0);
  assert.deepEqual(expired.limitsReached, ['time']);
  const value = budget();
  value.noteManifest(7);
  assert.equal(value.counters.manifest_entries, 7);
  assert.deepEqual(value.counters.limits_reached, []);
});

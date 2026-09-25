import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnalysisBudget, ANALYSIS_BYTES, BudgetError, PATCH_UNIT_BYTES } from '../../src/budget.js';

const budget = (overrides: Partial<ConstructorParameters<typeof AnalysisBudget>[0]> = {}) => new AnalysisBudget({
  maxCollectedPatchBytes: 1000, maxAnalysisBytes: 1000, maxJevCalls: 4,
  deadline: performance.now() + 10_000, ...overrides,
});

test('a reservation is debited before dispatch so concurrent callers cannot race past a limit', () => {
  const value = budget({ maxAnalysisBytes: 100, maxJevCalls: 8 });
  // Three "workers" reserve before any of them sends.
  const first = value.reserve(40);
  const second = value.reserve(40);
  assert.throws(() => value.reserve(40), BudgetError);
  assert.equal(value.counters.analysis_bytes, 0, 'nothing is counted as sent yet');
  first.commit(); second.commit();
  assert.equal(value.counters.analysis_bytes, 80);
  assert.equal(value.counters.jev_calls, 2);
});

test('an unsent reservation is released, a dispatched one is not', () => {
  const value = budget({ maxAnalysisBytes: 100 });
  const reservation = value.reserve(90);
  reservation.release();
  assert.equal(value.counters.analysis_bytes, 0);
  value.reserve(90).commit();
  assert.equal(value.counters.analysis_bytes, 90);
  const committed = value.reserve(10);
  committed.commit();
  committed.release();
  assert.equal(value.counters.analysis_bytes, 100, 'a sent call is never refunded');
});

test('all configured calls and bytes are available to analysis', () => {
  const value = budget({ maxAnalysisBytes: 1000, maxJevCalls: 1 });
  assert.equal(value.fits(1000), true);
  value.reserve(1000).commit();
  assert.equal(value.counters.jev_calls, 1);
  assert.equal(value.counters.analysis_bytes, 1000);
  assert.equal(value.fits(1), false);
});

test('the call ceiling counts dispatched calls whatever their outcome', () => {
  const value = budget({ maxJevCalls: 2, maxAnalysisBytes: 10_000 });
  value.reserve(1).commit();
  value.reserve(1).commit();
  assert.throws(() => value.reserve(1), BudgetError);
  assert.deepEqual(value.limitsReached, ['jev-calls']);
});

test('patch allowance never exceeds the per-unit cap and is exhausted by real reads', () => {
  const value = budget({ maxCollectedPatchBytes: PATCH_UNIT_BYTES * 3 });
  assert.equal(value.patchUnitAllowance(), PATCH_UNIT_BYTES);
  value.notePatchRequested();
  value.chargeRead(PATCH_UNIT_BYTES);
  value.spendPatchBytes(PATCH_UNIT_BYTES);
  assert.equal(value.counters.patch_bytes_read, PATCH_UNIT_BYTES);
  assert.equal(value.counters.patch_bytes_delivered, PATCH_UNIT_BYTES);
  assert.equal(value.counters.patches_read, 1);
  assert.equal(value.counters.patches_requested, 1);

  const small = budget({ maxCollectedPatchBytes: 100 });
  small.chargeRead(60);
  small.spendPatchBytes(60);
  assert.equal(small.patchUnitAllowance(), 40);
  assert.throws(() => small.spendPatchBytes(41), BudgetError);
  assert.equal(small.counters.patch_bytes_delivered, 60, 'a refused delivery is never counted');
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

test('asking whether a call fits records nothing', () => {
  const value = budget({ maxAnalysisBytes: 100, maxJevCalls: 1 });
  assert.equal(value.fits(4096), false);
  assert.equal(value.fits(10), true);
  assert.deepEqual(value.limitsReached, [], 'a question is not a ceiling that was reached');
  assert.throws(() => value.reserve(4096), BudgetError);
  assert.deepEqual(value.limitsReached, ['analysis-bytes'], 'an actual attempt is recorded');
});

test('zero call and byte limits leave analysis unbounded', () => {
  const value = budget({ maxJevCalls: 0, maxAnalysisBytes: 0 });
  assert.equal(value.fits(10_000_000), true);
  value.reserve(10_000_000).commit();
  assert.equal(value.fits(10_000_000), true);
});

test('the default analysis budget admits requests up to its configured ceiling', () => {
  const value = new AnalysisBudget({ maxCollectedPatchBytes: 1 << 20, maxAnalysisBytes: ANALYSIS_BYTES,
    maxJevCalls: 16, deadline: performance.now() + 1000 });
  assert.equal(value.fits(ANALYSIS_BYTES), true);
  value.reserve(ANALYSIS_BYTES).commit();
  assert.equal(value.fits(1), false);
});

test('retries charge the attempts and bytes sent over the wire', () => {
  const value = budget({ maxAnalysisBytes: 100, maxJevCalls: 3 });
  value.reserve(30).commit({ attempts: 2, sentBytes: 60 });
  assert.equal(value.counters.jev_calls, 2);
  assert.equal(value.counters.attempts, 2);
  assert.equal(value.counters.analysis_bytes, 60);
  assert.equal(value.fits(40), true);
  assert.equal(value.fits(41), false);
});

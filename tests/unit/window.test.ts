import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BYTES_PER_TOKEN_PRIOR, PROVIDER_STATE_QUESTION_TOKENS, TokenMeter } from '../../src/window.js';

test('a cold start can never size larger than the previous hardcoded budget', () => {
  const meter = new TokenMeter();
  // The prior is exactly 64 KiB against 32k tokens, with safety applied on top.
  assert.equal(BYTES_PER_TOKEN_PRIOR, 2.0);
  assert.ok(meter.stateAndQuestionBytes() <= 64 * 1024);
  assert.deepEqual(meter.report, { prior: 2.0, observed_min: null, samples: 0, applied: 2.0, rejections: 0 });
});

test('the first real measurement replaces the prior, later ones take the worst', () => {
  const meter = new TokenMeter();
  const cold = meter.stateAndQuestionBytes();
  meter.record(30_000, 10_000);                       // 3.0 bytes/token
  assert.equal(meter.report.applied, 3);
  assert.equal(meter.report.samples, 1);
  const warm = meter.stateAndQuestionBytes();
  assert.ok(warm > cold, 'a denser ratio raises the budget');

  meter.record(40_000, 10_000);                       // 4.0 — better, but not trusted
  assert.equal(meter.report.applied, 3, 'the minimum observed wins');
  meter.record(25_000, 10_000);                       // 2.5 — worse, so it wins
  assert.equal(meter.report.applied, 2.5);
  assert.equal(meter.report.observed_min, 2.5);
});

test('samples too small to be meaningful are ignored', () => {
  const meter = new TokenMeter();
  meter.record(100_000, 10);      // framing-dominated
  meter.record(0, 10_000);
  meter.record(1000, Number.NaN);
  assert.equal(meter.report.samples, 0);
  assert.equal(meter.report.applied, BYTES_PER_TOKEN_PRIOR);
});

test('growth is capped so one sample cannot blow the budget open', () => {
  const meter = new TokenMeter();
  const first = meter.stateAndQuestionBytes();
  meter.record(200_000, 10_000);  // 20 bytes/token — wildly generous
  const second = meter.stateAndQuestionBytes();
  assert.ok(second <= Math.floor(first * 1.5), `grew from ${first} to ${second}`);
  const third = meter.stateAndQuestionBytes();
  assert.ok(third <= Math.floor(second * 1.5));
});

test('a size rejection lowers the ratio strictly, so a retry loop terminates', () => {
  const meter = new TokenMeter();
  meter.record(30_000, 10_000);
  const before = meter.report.applied;
  meter.noteRejection(PROVIDER_STATE_QUESTION_TOKENS * before);
  const after = meter.report.applied;
  assert.ok(after < before, `${after} must be strictly below ${before}`);
  assert.equal(meter.report.rejections, 1);

  // Repeated rejections keep descending, never climb back.
  let previous = after;
  for (let index = 0; index < 5; index++) {
    meter.noteRejection(PROVIDER_STATE_QUESTION_TOKENS * previous);
    assert.ok(meter.report.applied < previous);
    previous = meter.report.applied;
  }
});

test('budgets stay inside their clamps whatever the ratio says', () => {
  const tiny = new TokenMeter();
  for (let index = 0; index < 20; index++) tiny.noteRejection(1000);
  assert.ok(tiny.stateAndQuestionBytes() >= 16 * 1024, 'a floor keeps progress possible');

  const huge = new TokenMeter();
  for (let index = 0; index < 20; index++) {
    huge.record(1_000_000, 10_000);
    huge.stateAndQuestionBytes();
  }
  assert.ok(huge.stateAndQuestionBytes() <= 512 * 1024);
  assert.ok(huge.requestBytes() <= 512 * 1024);
});

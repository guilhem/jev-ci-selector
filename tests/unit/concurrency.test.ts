import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateController } from '../../src/concurrency.js';

test('never admits more than its current limit', async () => {
  const rate = new RateController(3, 8);
  let active = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 20 }, async () => {
    const release = await rate.acquire();
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 1));
    active -= 1;
    release();
  }));
  assert.equal(peak, 3, 'the limit was honoured under contention');
  assert.equal(rate.stats.peak_concurrency, 3);
});

test('widens only after a sustained run of successes, never past the ceiling', () => {
  const rate = new RateController(4, 6);
  for (let index = 0; index < 7; index++) rate.noteSuccess();
  assert.equal(rate.limit, 4, 'seven successes are not yet eight');
  rate.noteSuccess();
  assert.equal(rate.limit, 5);
  for (let index = 0; index < 8; index++) rate.noteSuccess();
  assert.equal(rate.limit, 6);
  for (let index = 0; index < 80; index++) rate.noteSuccess();
  assert.equal(rate.limit, 6, 'the ceiling holds');
});

test('retreats immediately on a rate limit and cannot fall below one', () => {
  const rate = new RateController(8, 8);
  rate.noteRateLimit();
  assert.equal(rate.limit, 4);
  rate.noteRateLimit();
  assert.equal(rate.limit, 2);
  rate.noteRateLimit();
  rate.noteRateLimit();
  rate.noteRateLimit();
  assert.equal(rate.limit, 1, 'a floor of one keeps the run alive');
  assert.equal(rate.stats.rate_limits, 5);
});

test('a retreat also resets progress toward the next widening', () => {
  const rate = new RateController(4, 8);
  for (let index = 0; index < 7; index++) rate.noteSuccess();
  rate.noteRateLimit();
  assert.equal(rate.limit, 2);
  rate.noteSuccess();
  assert.equal(rate.limit, 2, 'the earlier successes no longer count');
});

test('a released slot admits a waiter, and releasing twice frees only one', async () => {
  const rate = new RateController(1, 1);
  const first = await rate.acquire();
  let admitted = false;
  const second = rate.acquire().then(release => { admitted = true; return release; });
  await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(admitted, false, 'the slot is occupied');
  first();
  first();
  await second;
  assert.equal(admitted, true);
  assert.equal(rate.stats.peak_concurrency, 1, 'a double release never widened the pool');
});

test('settles under a provider that refuses above a known parallelism', async () => {
  // The controller must converge below the provider's tolerance rather than
  // failing the run.
  const tolerance = 3;
  const rate = new RateController(8, 8);
  let active = 0;
  let refusals = 0;
  let completed = 0;
  await Promise.all(Array.from({ length: 40 }, async () => {
    for (;;) {
      const release = await rate.acquire();
      active += 1;
      const over = active > tolerance;
      await new Promise(resolve => setTimeout(resolve, 1));
      active -= 1;
      release();
      if (over) { refusals += 1; rate.noteRateLimit(); continue; }
      rate.noteSuccess();
      completed += 1;
      return;
    }
  }));
  assert.equal(completed, 40, 'every call eventually got through');
  assert.ok(refusals > 0, 'the ceiling was probed');
  assert.ok(rate.limit <= tolerance + 1, `settled near the tolerance, got ${rate.limit}`);
});

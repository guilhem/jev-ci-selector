import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { inspectCorpus, replayMockChoices } from '../evaluation/evaluation.js';

test('generic description-only corpus and Choice policy replay run offline', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('unexpected network access'); };
  try {
    const root = resolve('tests/evaluation');
    assert.deepEqual(await inspectCorpus(root), { cases: 8, tasks: 4 });
    assert.deepEqual(await replayMockChoices(root), { checked: 5, stale: 0 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decisionsFromObservation, type Observation } from '../../src/observations.js';

test('Choice composition omits only a task independent in every change group', () => {
  const group = (choices: Record<string, 'required' | 'independent' | 'unresolved'>) => ({
    judgments: Object.fromEntries(Object.entries(choices).map(([id, choice]) => [id, { choice, confidence: 1, probabilities: { required: 0, independent: 0, unresolved: 0 } }])),
  });
  const observation = { strategy: 'chunked-diff', status: 'complete', chunks: [
    group({ all: 'independent', required: 'independent', unresolved: 'independent', missing: 'independent' }),
    group({ all: 'independent', required: 'required', unresolved: 'unresolved' }),
  ] } as unknown as Observation;
  assert.deepEqual(decisionsFromObservation(observation, ['all', 'required', 'unresolved', 'missing']), {
    all: false, required: true, unresolved: true, missing: null,
  });
});

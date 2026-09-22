import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseChange, type AnalysisRequest, type InventoryEntry } from '../../src/observations.js';
import { AnalysisBudget } from '../../src/budget.js';
import { patch } from '../fixtures/diff.js';
import { JevError } from '../../src/jev.js';

const entries = (count: number): InventoryEntry[] => Array.from({ length: count }, (_, index) => ({
  id: `c${index}`, status: 'A', oldPath: null, newPath: `src/file-${index}.ts`, oldMode: null, newMode: '100644',
}));

function request(overrides: Partial<AnalysisRequest> = {}): AnalysisRequest {
  const inventory = entries(3);
  let delivered = false;
  return {
    selection: { model: 'jev-1.13.0', tasks: {
      alpha: { evidence: { description: 'Checks alpha.' } },
      beta: { evidence: { description: 'Checks beta.' } },
    } },
    taskIds: ['alpha', 'beta'],
    changeIds: inventory.map(entry => entry.id),
    inventory,
    apiKey: 'k',
    budget: new AnalysisBudget({ maxCollectedPatchBytes: 0, maxAnalysisBytes: 0, maxJevCalls: 0,
      deadline: performance.now() + 60_000 }),
    state: { base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40), tested_sha: 'c'.repeat(40) },
    patches: {
      next: async () => {
        if (delivered) return null;
        delivered = true;
        return { changeIds: inventory.map(entry => entry.id), paths: inventory.map(entry => entry.newPath!),
          diff: inventory.map(entry => patch(2, entry.newPath!)).join(''), issue: null };
      },
    },
    ...overrides,
  };
}

type Call = { taskIds: string[]; state: Record<string, unknown>;
  questions?: Record<string, { criteria: Record<string, unknown> }> };

/** Answer each question with one of its own options, whatever they are. */
const answer = (call: Call, pick: (id: string) => string) => ({
  model: 'jev-1.13.0', usage: { input_tokens: 600, output_tokens: 1 },
  answers: Object.fromEntries(call.taskIds.map(id => {
    const options = call.questions ? Object.keys(call.questions[id]!.criteria) : ['required', 'independent', 'unresolved'];
    const chosen = pick(id);
    return [id, { choice: chosen, confidence: 1,
      probabilities: Object.fromEntries(options.map(option => [option, option === chosen ? 1 : 0])) }];
  })),
});
const coarse = (call: Call) => !('diff' in call.state);

test('the inventory alone can settle a task to run, without reading any content', async () => {
  const seen: Array<{ hasDiff: boolean; ids: string[] }> = [];
  const outcome = await analyseChange(request(), (async (input: never) => {
    const call = input as unknown as Call;
    seen.push({ hasDiff: !coarse(call), ids: [...call.taskIds] });
    // The coarse pass carries no content; alpha is settled from paths alone.
    if (coarse(call)) return answer(call, id => id === 'alpha' ? 'required' : 'undetermined');
    return answer(call, () => 'independent');
  }) as never);

  assert.equal(seen[0]!.hasDiff, false, 'the first call is the inventory, with no content');
  assert.equal(outcome.states.alpha, 'settled-run');
  assert.equal(outcome.decisions.alpha, true);
  // An acquired execution never claims coverage it does not have.
  assert.equal(outcome.coverage.alpha, false);
  assert.deepEqual(outcome.observation!.inventory!.settled, ['alpha']);
  // The settled task leaves every later request.
  for (const call of seen.slice(1)) assert.ok(!call.ids.includes('alpha'));
  // beta was not settled coarsely, so it still swept the content and can skip.
  assert.equal(outcome.states.beta, 'settled-skip');
  assert.equal(outcome.coverage.beta, true);
});

test('the coarse question offers no way to express a skip', async () => {
  // The shortcut this pass must never take is not merely unused: with only
  // `required` and `undetermined` it cannot be expressed, and a provider that
  // tried would be refused by validation and simply teach the pass nothing.
  let options: string[] = [];
  const outcome = await analyseChange(request(), (async (input: never) => {
    const call = input as unknown as Call;
    if (coarse(call)) {
      options = Object.keys(call.questions![call.taskIds[0]!]!.criteria);
      return answer(call, () => 'independent');   // not an allowed option
    }
    return answer(call, () => 'independent');
  }) as never);

  assert.deepEqual(options.sort(), ['required', 'undetermined']);
  assert.equal(outcome.observation!.inventory!.calls[0]!.status, 'failed');
  assert.deepEqual(outcome.observation!.inventory!.settled, []);
  // The content pass still decided both tasks on real evidence.
  assert.deepEqual(outcome.coverage, { alpha: true, beta: true });
});

test('a failed coarse pass is uninformative, never a retention', async () => {
  let failures = 0;
  const outcome = await analyseChange(request(), (async (input: never) => {
    const call = input as unknown as Call;
    if (coarse(call)) { failures++; throw new JevError('jev-error'); }
    return answer(call, () => 'independent');
  }) as never);

  assert.equal(failures, 1);
  // Both tasks still swept the content and both can still be excluded.
  assert.equal(outcome.states.alpha, 'settled-skip');
  assert.equal(outcome.states.beta, 'settled-skip');
  assert.deepEqual(outcome.coverage, { alpha: true, beta: true });
  assert.deepEqual(outcome.observation!.inventory!.settled, []);
  assert.equal(outcome.observation!.inventory!.calls[0]!.status, 'failed');
});

test('without an inventory the coarse pass does not run at all', async () => {
  const seen: boolean[] = [];
  const outcome = await analyseChange(request({ inventory: [] }), (async (input: never) => {
    const call = input as unknown as Call;
    seen.push(!coarse(call));
    return answer(call, () => 'independent');
  }) as never);
  assert.ok(seen.every(Boolean), 'every call carried content');
  assert.equal(outcome.observation!.inventory, undefined);
});

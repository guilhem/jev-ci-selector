import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseChange, REQUEST_BYTES, type AnalysisRequest, type InventoryEntry } from '../../src/observations.js';
import { AnalysisBudget } from '../../src/budget.js';
import { patch } from '../fixtures/diff.js';
import { JevError } from '../../src/jev.js';

const entries = (count: number): InventoryEntry[] => Array.from({ length: count }, (_, index) => ({
  id: `c${index}`, status: 'A', oldPath: null, newPath: `src/file-${index}.ts`, oldMode: null, newMode: '100644',
}));

/** The coarse pass speaks the `evaluateChoices` shape: explicit questions. */
type CoarseCall = { state: Record<string, unknown>; questions: Record<string, { criteria: Record<string, unknown> }> };
/** The content pass speaks the `evaluateJev` shape: task ids. */
type ContentCall = { taskIds: string[]; state: Record<string, unknown> };

const reply = (ids: string[], options: (id: string) => string[], pick: (id: string) => string) => ({
  model: 'jev-1.13.0', usage: { input_tokens: 600, output_tokens: 1 },
  answers: Object.fromEntries(ids.map(id => {
    const chosen = pick(id);
    return [id, { choice: chosen, confidence: 1,
      probabilities: Object.fromEntries(options(id).map(option => [option, option === chosen ? 1 : 0])) }];
  })),
});
const coarseReply = (call: CoarseCall, pick: (id: string) => string) =>
  reply(Object.keys(call.questions), id => Object.keys(call.questions[id]!.criteria), pick);
const contentReply = (call: ContentCall, pick: (id: string) => string) =>
  reply(call.taskIds, () => ['required', 'independent', 'unresolved'], pick);

function request(coarse: (call: CoarseCall) => unknown, overrides: Partial<AnalysisRequest> = {}): AnalysisRequest {
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
    evaluateInventory: (async (input: never) => coarse(input as unknown as CoarseCall)) as never,
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

test('the inventory alone can settle a task to run, without reading any content', async () => {
  let carriedContent = true;
  const asked: string[][] = [];
  const outcome = await analyseChange(
    request(call => {
      carriedContent = 'diff' in call.state;
      return coarseReply(call, id => id === 'alpha' ? 'required' : 'undetermined');
    }),
    (async (input: never) => {
      const call = input as unknown as ContentCall;
      asked.push([...call.taskIds]);
      return contentReply(call, () => 'independent');
    }) as never);

  assert.equal(carriedContent, false, 'the coarse pass carries no file content');
  assert.equal(outcome.states.alpha, 'settled-run');
  assert.equal(outcome.decisions.alpha, true);
  // An acquired execution never claims coverage it does not have.
  assert.equal(outcome.coverage.alpha, false);
  assert.deepEqual(outcome.observation!.inventory!.settled, ['alpha']);
  // The settled task leaves every later request.
  assert.ok(asked.length > 0 && asked.every(ids => !ids.includes('alpha')));
  // beta was not settled coarsely, so it still swept the content and can skip.
  assert.equal(outcome.states.beta, 'settled-skip');
  assert.equal(outcome.coverage.beta, true);
  assert.equal(outcome.observation!.status, 'complete');
  assert.equal(outcome.model, 'jev-1.13.0');
  assert.deepEqual(outcome.usage, { input_tokens: 1200, output_tokens: 2 });
});

test('inventory questions are batched within the request limit on every page', async () => {
  const inventory = entries(600);
  const taskIds = Array.from({ length: 200 }, (_, index) => `task_${index}`);
  const selection = { model: 'jev-1.13.0', tasks: Object.fromEntries(taskIds.map(id =>
    [id, { evidence: { description: `Checks ${id}.` } }])) };
  const pages = new Map<string, string[]>();
  let calls = 0;
  const outcome = await analyseChange(request(call => {
    // Measure the provider body, not the API key and local timeout options.
    const bodyBytes = Buffer.byteLength(JSON.stringify({ model: selection.model,
      state: call.state, questions: call.questions }));
    assert.ok(bodyBytes <= REQUEST_BYTES, `${bodyBytes} exceeds ${REQUEST_BYTES}`);
    const changes = call.state.changes as Array<{ id: string }>;
    const page = changes[0]!.id;
    pages.set(page, [...(pages.get(page) ?? []), ...Object.keys(call.questions)]);
    calls++;
    return coarseReply(call, () => changes.at(-1)!.id === inventory.at(-1)!.id ? 'required' : 'undetermined');
  }, { selection, taskIds, inventory, changeIds: inventory.map(entry => entry.id),
    patches: { next: async () => assert.fail('the inventory settled every task') } }),
  async () => assert.fail('no content call is needed'));

  assert.ok(pages.size > 1, 'the inventory spans several pages');
  assert.ok(calls > pages.size, 'each page needs several question batches');
  for (const ids of pages.values()) assert.deepEqual(ids.sort(), [...taskIds].sort());
  assert.ok(Object.values(outcome.decisions).every(value => value === true));
  assert.ok(Object.values(outcome.coverage).every(value => value === false));
  assert.equal(outcome.observation!.status, 'stopped-early');
  assert.equal(outcome.model, 'jev-1.13.0');
  assert.deepEqual(outcome.usage, { input_tokens: 600 * calls, output_tokens: calls });
});

test('an oversized single inventory question is never dispatched or charged', async () => {
  const input = request(() => assert.fail('an oversized request must not be sent'), {
    selection: { model: 'jev-1.13.0', tasks: {
      alpha: { evidence: { description: 'x'.repeat(REQUEST_BYTES) } },
    } },
    taskIds: ['alpha'],
  });
  const outcome = await analyseChange(input, async () => assert.fail('the content question is also too large'));
  assert.equal(input.budget.counters.jev_calls, 0);
  assert.equal(input.budget.counters.analysis_bytes, 0);
  assert.equal(outcome.observation!.inventory!.calls[0]!.status, 'not-started');
  assert.equal(outcome.states.alpha, 'fallback-run');
  assert.equal(outcome.taskErrors.alpha, 'context-too-large');
  assert.equal(outcome.usage, null);
});

test('the coarse question offers no way to express a skip', async () => {
  // The shortcut this pass must never take is not merely unused: with only
  // `required` and `undetermined` it cannot be expressed at all.
  let options: string[] = [];
  const outcome = await analyseChange(
    request(call => {
      options = Object.keys(call.questions[Object.keys(call.questions)[0]!]!.criteria);
      return coarseReply(call, () => 'independent');   // not an allowed option
    }),
    (async (input: never) => contentReply(input as unknown as ContentCall, () => 'independent')) as never);

  assert.deepEqual(options.sort(), ['required', 'undetermined']);
  assert.equal(outcome.observation!.inventory!.calls[0]!.status, 'failed');
  assert.deepEqual(outcome.observation!.inventory!.settled, []);
  assert.equal(outcome.observation!.status, 'incomplete');
  assert.equal(outcome.failure, 'invalid-response');
  assert.deepEqual(outcome.usage, { input_tokens: 1200, output_tokens: 2 });
  // The content pass still decided both tasks on real evidence.
  assert.deepEqual(outcome.coverage, { alpha: true, beta: true });
});

test('a failed coarse pass is uninformative, never a retention', async () => {
  let failures = 0;
  const outcome = await analyseChange(
    request(() => { failures++; throw new JevError('jev-error'); }),
    (async (input: never) => contentReply(input as unknown as ContentCall, () => 'independent')) as never);

  assert.equal(failures, 1);
  // Both tasks still swept the content and both can still be excluded.
  assert.equal(outcome.states.alpha, 'settled-skip');
  assert.equal(outcome.states.beta, 'settled-skip');
  assert.deepEqual(outcome.coverage, { alpha: true, beta: true });
  assert.deepEqual(outcome.observation!.inventory!.settled, []);
  assert.equal(outcome.observation!.inventory!.calls[0]!.status, 'failed');
  assert.equal(outcome.observation!.status, 'incomplete');
  assert.equal(outcome.failure, 'jev-error');
  assert.deepEqual(outcome.usage, { input_tokens: 600, output_tokens: 1 });
});

test('without an inventory the coarse pass does not run at all', async () => {
  let coarseCalls = 0;
  const outcome = await analyseChange(
    request(() => { coarseCalls++; return {}; }, { inventory: [] }),
    (async (input: never) => contentReply(input as unknown as ContentCall, () => 'independent')) as never);
  assert.equal(coarseCalls, 0);
  assert.equal(outcome.observation!.inventory, undefined);
});

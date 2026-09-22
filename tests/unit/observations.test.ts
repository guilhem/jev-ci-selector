import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selection } from '../fixtures/selection.js';
import { evaluateJev, buildQuestions, JevError, type JevResult } from '../../src/jev.js';
import { patch } from '../fixtures/diff.js';
import { observeChange } from '../../src/observations.js';

type Evaluate = typeof evaluateJev;
type EvaluateInput = Parameters<Evaluate>[0];
type ObserveInput = Parameters<typeof observeChange>[0];
type ChunkState = { diff: string; chunk?: { index: number; total: number; start_byte: number; end_byte: number; preceding_diff_headers: string } };

const sha = (letter: string) => letter.repeat(40);

function request(diff: string, timeoutMs = 1_000): ObserveInput {
  const value = selection();
  value.tasks = { check: { evidence: { description: 'Does this patch affect the check task?' } } };
  return {
    selection: value,
    taskIds: ['check'],
    apiBaseUrl: 'https://api.typesafe.ai',
    apiModel: 'jev-1.13.0',
    apiKey: 'secret-api-key',
    timeoutMs,
    state: { base_sha: sha('a'), head_sha: sha('b'), tested_sha: sha('c'), changed_paths: ['source.txt'], diff },
  };
}

function response(input: EvaluateInput, probability = 0, usage = { input_tokens: 3, output_tokens: 2 }): JevResult {
  return { probabilities: Object.fromEntries(input.taskIds.map(id => [id, probability])), model: 'jev-1.13.0', usage };
}

function chunkState(input: EvaluateInput): ChunkState {
  return input.state as ChunkState;
}

test('preserves Unicode fragments, source ranges, and byte request budgets', async () => {
  const diff = patch(3000);
  const calls: Array<{ index: number; state: ChunkState; timeoutMs: number }> = [];
  const result = await observeChange(request(diff), async input => {
    const state = chunkState(input);
    assert.ok(state.chunk);
    const questions = buildQuestions(input.selection, input.taskIds);
    const question = Object.values(questions);
    assert.ok(Buffer.byteLength(JSON.stringify(state)) + Buffer.byteLength(JSON.stringify(question[0])) <= 24 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify(state)) + Buffer.byteLength(JSON.stringify(questions)) <= 48 * 1024);
    calls.push({ index: state.chunk.index, state, timeoutMs: input.timeoutMs });
    return response(input);
  });

  assert.equal(result.observation.strategy, 'chunked-diff');
  assert.equal(result.observation.status, 'complete');
  assert.ok(calls.length > 1);
  const ordered = [...calls].sort((a, b) => a.index - b.index);
  assert.equal(ordered.map(call => call.state.diff).join(''), diff);
  for (let index = 0; index < ordered.length; index += 1) {
    const chunk = ordered[index]!;
    assert.equal(chunk.state.chunk!.index, index);
    assert.equal(chunk.state.chunk!.total, ordered.length);
    assert.ok(chunk.state.chunk!.end_byte > chunk.state.chunk!.start_byte);
    assert.ok(chunk.timeoutMs <= 10_000);
  }
  assert.ok(!JSON.stringify(result.observation).includes(diff));
  assert.ok(!JSON.stringify(result.observation).includes('secret-api-key'));
});

test('limits chunk scheduling to three, stops launching after failure, and retains known usage', async () => {
  const diff = patch(4000);
  const started: number[] = [];
  let releaseThree!: () => void;
  const threeStarted = new Promise<void>(resolve => { releaseThree = resolve; });
  const resultPromise = observeChange(request(diff), async input => {
    const index = chunkState(input).chunk!.index;
    started.push(index);
    if (started.length === 3) releaseThree();
    await threeStarted;
    if (index === 0) throw new JevError('jev-error', { model: 'jev-1.13.0', usage: { input_tokens: 11, output_tokens: 7 } });
    if (index === 1 || index === 2) return response(input, 0.4, { input_tokens: 2, output_tokens: 1 });
    throw new Error(`unexpected chunk ${index}`);
  });
  const result = await resultPromise;

  assert.deepEqual(started.sort((a, b) => a - b), [0, 1, 2]);
  assert.equal(result.observation.status, 'incomplete');
  assert.equal(result.observation.chunks[0]!.status, 'failed');
  assert.equal(result.observation.chunks[0]!.error, 'jev-error');
  assert.equal(result.observation.chunks[0]!.usage?.input_tokens, 11);
  assert.equal(result.observation.chunks[1]!.status, 'completed');
  assert.equal(result.observation.chunks[2]!.status, 'completed');
  assert.ok(result.observation.chunks.slice(3).every(chunk => chunk.status === 'not-started'));
  assert.deepEqual(result.usage, { input_tokens: 15, output_tokens: 9 });
  assert.equal(result.decisions.check, true);
});

test('retains raw group scores and composes only a boolean decision', async () => {
  const diff = patch(1600);
  const result = await observeChange(request(diff), async input => {
    const index = chunkState(input).chunk!.index;
    return response(input, index === 1 ? 0.9 : 0.01);
  });

  assert.equal(result.observation.status, 'complete');
  assert.equal(result.decisions.check, true);
  assert.ok(result.observation.chunks.some(chunk => chunk.probabilities?.check === 0.9));
  assert.ok(result.observation.chunks.every(chunk => chunk.status === 'completed'));
  assert.ok(!Object.hasOwn(result, 'probabilities'));
});

test('uses the same grouped evaluation in enforce and does not retry calls', async () => {
  const diff = patch(1600);
  let calls = 0;
  const result = await observeChange(request(diff), async input => {
    calls += 1;
    assert.ok((input.state as ChunkState).chunk);
    throw new JevError('jev-timeout');
  });

  assert.ok(calls <= 3);
  assert.equal(result.observation.strategy, 'chunked-diff');
  assert.equal(result.observation.status, 'incomplete');
  assert.equal(result.observation.chunks[0]!.status, 'failed');
  assert.equal(result.observation.chunks[0]!.error, 'jev-timeout');
});

test('applies one global deadline to chunk scheduling and marks remaining chunks timed out', async () => {
  const diff = patch(4000);
  const requestValue = request(diff, 5);
  const seenTimeouts: number[] = [];
  const result = await observeChange(requestValue, async input => {
    seenTimeouts.push(input.timeoutMs);
    await new Promise(resolve => setTimeout(resolve, 20));
    return response(input);
  });

  assert.ok(seenTimeouts.length <= 3);
  assert.ok(seenTimeouts.every(timeoutMs => timeoutMs <= 10_000));
  assert.equal(result.observation.status, 'incomplete');
  assert.ok(result.observation.chunks.some(chunk => chunk.status === 'not-started' && chunk.error === 'jev-timeout'));
});

test('batches real-sized independent questions and preserves other jobs after a batch failure', async () => {
  const value = request(patch());
  value.selection.tasks = Object.fromEntries(['a', 'b', 'c', 'd'].map(id => [id, { evidence: { description: `${id}: ${'metadata '.repeat(4900)}` } }]));
  value.taskIds = ['a', 'b', 'c', 'd'];
  const calls: string[][] = [];
  const result = await observeChange(value, async input => {
    calls.push(input.taskIds);
    if (input.taskIds.includes('d')) throw new JevError('jev-error');
    return response(input, 0.01);
  });
  assert.ok(calls.length > 1);
  assert.deepEqual(calls.flat().sort(), value.taskIds);
  assert.equal(result.decisions.a, false);
  assert.equal(result.decisions.d, null);
  assert.equal(result.observation.status, 'incomplete');
  assert.equal(result.observation.chunks[0]!.probabilities?.a, 0.01);
  assert.ok(result.observation.chunks[0]!.requests!.some(call => call.status === 'failed'));
});

test('group states exclude unrelated PR paths and repeated evaluations produce identical proposals', async () => {
  const input = request(patch(700, 'backend/a.ts') + patch(700, 'frontend/b.ts'));
  input.state.changed_paths = ['backend/a.ts', 'frontend/b.ts'];
  const outputs = [];
  for (let attempt = 0; attempt < 2; attempt++) outputs.push(await observeChange(input, async call => {
    const state = call.state as { changed_paths: string[]; diff: string; chunk: { preceding_diff_headers: string } };
    assert.equal(state.changed_paths.length, 1);
    assert.ok((state.diff + state.chunk.preceding_diff_headers).includes(state.changed_paths[0]!));
    return response(call, state.changed_paths[0]!.startsWith('frontend') ? 0.2 : 0.01);
  }));
  assert.deepEqual(outputs[0]!.decisions, outputs[1]!.decisions);
  assert.equal(outputs[0]!.decisions.check, true);
});

test('split judgments compose across dimensions and groups without changing raw scores', async () => {
  const input = { ...request(patch(200)), questionMode: 'split' as const, maxGroupBytes: 1024 };
  const result = await observeChange(input, async call => ({
    probabilities: { 'check::behavior': 0.01, 'check::verification': chunkState(call).chunk!.index === 1 ? 0.7 : 0.02 },
    model: 'jev-1.13.0', usage: { input_tokens: 1, output_tokens: 2 },
  }));
  assert.ok(result.observation.chunks.length > 1);
  assert.equal(result.decisions.check, true);
  assert.deepEqual(result.observation.chunks[1]!.probabilities, { 'check::behavior': 0.01, 'check::verification': 0.7 });
  const low = await observeChange(input, async () => ({
    probabilities: { 'check::behavior': 0.01, 'check::verification': 0.02 }, model: 'jev-1.13.0', usage: null,
  }));
  assert.equal(low.decisions.check, false);
  const missing = await observeChange(input, async () => ({ probabilities: { 'check::behavior': 0.01 }, model: 'jev-1.13.0', usage: null }));
  assert.equal(missing.decisions.check, null);
  assert.equal(missing.failure, 'invalid-response');
});

test('split-question batches respect serialized request limits and keep both dimensions together', async () => {
  const value = { ...request(patch()), questionMode: 'split' as const };
  value.selection.tasks = Object.fromEntries(['alpha', 'beta', 'gamma'].map(id => [id, { evidence: { description: `${id}: ${'scope '.repeat(4500)}` } }]));
  value.taskIds = ['alpha', 'beta', 'gamma'];
  let calls = 0;
  const result = await observeChange(value, call => evaluateJev(call, async (_url, init) => {
    calls++;
    const body = JSON.parse(init!.body as string);
    assert.ok(Buffer.byteLength(JSON.stringify(body.state)) + Buffer.byteLength(JSON.stringify(body.questions)) <= 128 * 1024);
    for (const id of call.taskIds) {
      assert.ok(body.questions[`${id}::behavior`]);
      assert.ok(body.questions[`${id}::verification`]);
    }
    return Response.json({ model: 'jev-1.13.0', answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'noul', noul: 0.01 }])), usage: { input_tokens: 1, output_tokens: 1 } });
  }));
  assert.ok(calls > 1);
  assert.deepEqual(result.decisions, { alpha: false, beta: false, gamma: false });
});


test('strict thresholds retain equality and zero threshold', async () => {
  for (const [score, expected] of [[0, false], [0.04999, false], [0.05, true], [1, true]] as const) {
    const result = await observeChange(request(patch()), async input => response(input, score));
    assert.equal(result.decisions.check, expected);
  }
  const input = request(patch()); input.selection.skip_below = 0;
  assert.equal((await observeChange(input, async call => response(call, 0))).decisions.check, true);
});
test('malformed scores cannot justify exclusion', async () => {
  for (const score of [undefined, null, '0.01', NaN, Infinity, -0.1, 1.1]) {
    const result = await observeChange(request(patch()), async () => ({ probabilities: { check: score } as never, model: 'jev-1.13.0', usage: null }));
    assert.notEqual(result.decisions.check, false);
    assert.equal(result.observation.status, 'incomplete');
  }
});

test('Choice needs independence in every group; required, unresolved and incomplete evidence retain the task', async () => {
  const input = { ...request(patch(200)), maxGroupBytes: 1024 };
  input.selection.judgment = 'choice';
  input.selection.skip_below = 0; // Noul's threshold must not govern a Choice.
  for (const [answer, expected] of [['independent', false], ['required', true], ['unresolved', true], ['missing', null], ['invalid', null], ['timeout', null]] as const) {
    const result = await observeChange(input, call => evaluateJev(call, async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      assert.equal(body.questions.check.type, 'choice');
      const chosen = body.state.chunk.index === 1 ? answer : 'independent';
      if (chosen === 'timeout') throw new JevError('jev-timeout');
      // Deliberately disagree with argmax/confidence: the provider's selected
      // option is authoritative; its distribution is preserved, not a threshold.
      return Response.json({ model: 'jev-1.13.0', usage: { input_tokens: 1, output_tokens: 1 },
        answers: chosen === 'missing' ? {} : { check: { type: 'choice', choice: chosen, confidence: 0.01,
          probabilities: { required: 0.8, independent: 0.1, unresolved: 0.1 } } } });
    }));
    assert.ok(result.observation.chunks.length > 1);
    assert.equal(result.decisions.check, expected, answer);
    assert.ok(result.observation.chunks.every(chunk => chunk.probabilities === null));
    if (expected === null) assert.equal(result.observation.status, 'incomplete');
    else {
      assert.equal(result.observation.status, 'complete');
      assert.deepEqual(result.observation.chunks[1]!.judgments!.check,
        { choice: answer, confidence: 0.01, probabilities: { required: 0.8, independent: 0.1, unresolved: 0.1 } });
    }
  }
});

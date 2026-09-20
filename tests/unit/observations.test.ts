import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catalog } from '../fixtures/catalog.js';
import { evaluateJev, JevError, type JevResult } from '../../src/jev.js';
import { observeChange } from '../../src/observations.js';

type Evaluate = typeof evaluateJev;
type EvaluateInput = Parameters<Evaluate>[0];
type ObserveInput = Parameters<typeof observeChange>[0];
type ChunkState = { diff: string; chunk?: { index: number; total: number; start_byte: number; end_byte: number; preceding_diff_headers: string } };

const sha = (letter: string) => letter.repeat(40);

function request(diff: string, timeoutMs = 1_000): ObserveInput {
  const value = catalog();
  value.tasks = { check: { question: 'Does this patch affect the check task?' } };
  return {
    catalog: value,
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
  const diff = `+${'é🦄'.repeat(20_000)}\\n`;
  const calls: Array<{ index: number; state: ChunkState; timeoutMs: number }> = [];
  const result = await observeChange(request(diff), true, async input => {
    const state = chunkState(input);
    assert.ok(state.chunk);
    const question = [{ type: 'noul', instructions: input.catalog.tasks.check!.question! }];
    assert.ok(Buffer.byteLength(JSON.stringify(state)) + Buffer.byteLength(JSON.stringify(question[0])) <= 24 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify(state)) + Buffer.byteLength(JSON.stringify(question)) <= 48 * 1024);
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
  const diff = '+'.repeat(140_000);
  const started: number[] = [];
  let releaseThree!: () => void;
  const threeStarted = new Promise<void>(resolve => { releaseThree = resolve; });
  const resultPromise = observeChange(request(diff), true, async input => {
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
  assert.equal(result.probabilities.check, undefined);
});

test('retains raw high scores while exposing the any-chunk maximum for complete observations', async () => {
  const diff = '+'.repeat(60_000);
  const result = await observeChange(request(diff), true, async input => {
    const index = chunkState(input).chunk!.index;
    return response(input, index === 1 ? 0.9 : 0.01);
  });

  assert.equal(result.observation.status, 'complete');
  assert.equal(result.probabilities.check, 0.9);
  assert.ok(result.observation.chunks.some(chunk => chunk.probabilities?.check === 0.9));
  assert.ok(result.observation.chunks.every(chunk => chunk.status === 'completed'));
});

test('keeps enforce observations whole-diff and does not retry evaluator calls', async () => {
  const diff = '+'.repeat(60_000);
  let calls = 0;
  const result = await observeChange(request(diff), false, async input => {
    calls += 1;
    assert.equal((input.state as ChunkState).chunk, undefined);
    throw new JevError('jev-timeout');
  });

  assert.equal(calls, 1);
  assert.equal(result.observation.strategy, 'whole-diff');
  assert.equal(result.observation.status, 'incomplete');
  assert.equal(result.observation.chunks[0]!.status, 'failed');
  assert.equal(result.observation.chunks[0]!.error, 'jev-timeout');
});

test('applies one global deadline to chunk scheduling and marks remaining chunks timed out', async () => {
  const diff = '+'.repeat(140_000);
  const requestValue = request(diff, 5);
  const seenTimeouts: number[] = [];
  const result = await observeChange(requestValue, true, async input => {
    seenTimeouts.push(input.timeoutMs);
    await new Promise(resolve => setTimeout(resolve, 20));
    return response(input);
  });

  assert.ok(seenTimeouts.length <= 3);
  assert.ok(seenTimeouts.every(timeoutMs => timeoutMs <= 10_000));
  assert.equal(result.observation.status, 'incomplete');
  assert.ok(result.observation.chunks.some(chunk => chunk.status === 'not-started' && chunk.error === 'jev-timeout'));
});

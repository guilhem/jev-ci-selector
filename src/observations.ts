import { createHash } from 'node:crypto';
import { splitDiff, ChunkError } from './chunks.js';
import { JevError, type Usage, type evaluateJev } from './jev.js';

export interface ObservationChunk {
  index: number;
  start_byte: number;
  end_byte: number;
  diff_hash: string;
  state_hash: string;
  diff_bytes: number;
  status: 'completed' | 'failed' | 'not-started';
  probabilities: Record<string, number> | null;
  model: string | null;
  usage: Usage | null;
  duration_ms: number | null;
  error: 'jev-timeout' | 'jev-error' | 'invalid-response' | null;
}

export interface Observation {
  strategy: 'whole-diff' | 'chunked-diff';
  status: 'complete' | 'incomplete';
  chunks: ObservationChunk[];
}

type Request = Parameters<typeof evaluateJev>[0];
type State = { base_sha: string; head_sha: string; tested_sha: string; changed_paths: string[]; diff: string };
type ObservationRequest = Omit<Request, 'state'> & { state: State };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

export class ObservationSizeError extends Error {
  constructor(public readonly code: 'context-too-large' | 'diff-too-large') { super(code); }
}

// Byte guards leave room below the provider's token budgets; they are not a tokenizer.
const STATE_AND_QUESTION_BYTES = 24 * 1024;
const REQUEST_BYTES = 48 * 1024;
const MAX_CHUNKS = 32;

function prepareStates(request: ObservationRequest, shadow: boolean) {
  const { state } = request;
  const questions = Object.fromEntries(request.taskIds.map(id => [id,
    { type: 'noul', instructions: request.catalog.tasks[id]!.question! }]));
  const longestQuestion = Math.max(0, ...Object.values(questions).map(bytes));
  const overhead = Math.max(longestQuestion, bytes(questions) - (REQUEST_BYTES - STATE_AND_QUESTION_BYTES));
  if (!shadow || bytes(state) + overhead <= STATE_AND_QUESTION_BYTES) {
    return [{ state, startByte: 0, endByte: Buffer.byteLength(state.diff), diff: state.diff }];
  }
  const { diff, ...shared } = state;
  // Account for actual JSON escaping instead of estimating tokens or dropping source.
  let budget = STATE_AND_QUESTION_BYTES - bytes(shared) - overhead - 1024;
  for (let attempt = 0; attempt < 8 && budget >= 1024; attempt++) {
    let parts;
    try { parts = splitDiff(diff, budget); }
    catch (error) {
      if (error instanceof ChunkError) throw new ObservationSizeError('context-too-large');
      throw error;
    }
    if (parts.length > MAX_CHUNKS) throw new ObservationSizeError('diff-too-large');
    const states = parts.map((part, index) => ({ ...part,
      state: { ...shared, diff: part.diff,
        chunk: { index, total: parts.length, start_byte: part.startByte, end_byte: part.endByte,
          preceding_diff_headers: part.context,
          scope: 'Partial diff. Evaluate the supplied fragment; changes in other fragments are not included.' } } }));
    const excess = Math.max(...states.map(part => Math.max(bytes(part.state) + longestQuestion - STATE_AND_QUESTION_BYTES,
      bytes(part.state) + bytes(questions) - REQUEST_BYTES)));
    if (excess <= 0) return states;
    budget -= excess + 128;
  }
  throw new ObservationSizeError('context-too-large');
}

export async function observeChange(request: ObservationRequest, shadow: boolean, evaluate: typeof evaluateJev) {
  const states = prepareStates(request, shadow);
  const observation: Observation = { strategy: states.length === 1 ? 'whole-diff' : 'chunked-diff', status: 'incomplete',
    chunks: states.map((part, index) => ({ index, start_byte: part.startByte, end_byte: part.endByte,
      diff_hash: hash(part.diff), state_hash: hash(JSON.stringify(part.state)), diff_bytes: Buffer.byteLength(part.diff),
      status: 'not-started', probabilities: null, model: null, usage: null, duration_ms: null, error: null })) };
  const deadline = performance.now() + request.timeoutMs;
  let next = 0;
  let failure: JevError['code'] | undefined;
  async function worker(): Promise<void> {
    while (!failure && next < states.length) {
      const index = next++;
      const chunk = observation.chunks[index]!;
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) { failure = 'jev-timeout'; break; }
      const started = performance.now();
      try {
        const result = await evaluate({ ...request, state: states[index]!.state,
          timeoutMs: Math.min(10000, remaining) });
        chunk.status = 'completed';
        chunk.probabilities = result.probabilities;
        chunk.model = result.model;
        chunk.usage = result.usage;
      } catch (error) {
        if (!(error instanceof JevError)) { failure = 'jev-error'; throw error; }
        failure ??= error.code;
        chunk.status = 'failed'; chunk.error = error.code;
        chunk.model = error.metadata.model; chunk.usage = error.metadata.usage;
      } finally { chunk.duration_ms = performance.now() - started; }
    }
  }
  // Settle in-flight requests before returning a report, including after an internal error.
  const workers = await Promise.allSettled(Array.from({ length: Math.min(3, states.length) }, worker));
  const rejected = workers.find(result => result.status === 'rejected');
  if (rejected?.status === 'rejected') throw rejected.reason;
  for (const chunk of observation.chunks) if (chunk.status === 'not-started') chunk.error = failure ?? 'jev-timeout';
  observation.status = observation.chunks.every(chunk => chunk.status === 'completed') ? 'complete' : 'incomplete';
  const observedModels = [...new Set(observation.chunks.map(chunk => chunk.model).filter(model => model !== null))];
  const usages = observation.chunks.flatMap(chunk => chunk.usage ? [chunk.usage] : []);
  const metadata = { model: observedModels.length === 1 ? observedModels[0]! : null,
    usage: usages.length ? usages.reduce((total, usage) => ({ input_tokens: total.input_tokens + usage.input_tokens,
      output_tokens: total.output_tokens + usage.output_tokens }), { input_tokens: 0, output_tokens: 0 }) : null };
  const probabilities = observation.status === 'complete' ? Object.fromEntries(request.taskIds.map(id => [id,
    Math.max(...observation.chunks.map(chunk => chunk.probabilities![id]!))])) : {};
  return { observation, probabilities, ...metadata, failure };
}

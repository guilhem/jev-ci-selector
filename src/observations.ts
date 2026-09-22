import { createHash } from 'node:crypto';
import { splitDiff, ChunkError } from './chunks.js';
import { buildQuestions, validateChoicesResponse, JevError, type Usage, type evaluateJev, type ChoiceJudgment } from './jev.js';

type ObservationError = 'jev-timeout' | 'jev-error' | 'invalid-response';
export interface ObservationCall {
  task_ids: string[];
  status: 'completed' | 'failed' | 'not-started';
  model: string | null;
  usage: Usage | null;
  duration_ms: number | null;
  error: ObservationError | null;
}
export interface ObservationChunk {
  index: number;
  start_byte: number;
  end_byte: number;
  diff_hash: string;
  state_hash: string;
  diff_bytes: number;
  paths?: string[];
  status: 'completed' | 'failed' | 'not-started';
  judgments: Record<string, ChoiceJudgment> | null;
  model: string | null;
  usage: Usage | null;
  duration_ms: number | null;
  error: ObservationError | null;
  requests?: ObservationCall[];
}
export interface Observation {
  strategy: 'whole-diff' | 'chunked-diff';
  status: 'complete' | 'incomplete';
  chunks: ObservationChunk[];
}

type Request = Parameters<typeof evaluateJev>[0];
type State = { base_sha: string; head_sha: string; tested_sha: string; changed_paths: string[]; diff: string };
type ObservationRequest = Omit<Request, 'state'> & { state: State; workingDirectories?: string[]; maxGroupBytes?: number };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

export class ObservationSizeError extends Error {
  constructor(public readonly code: 'context-too-large' | 'diff-too-large' | 'unrepresentable-change') { super(code); }
}

// Byte guards include real metadata and JSON escaping. They are not token counts.
export const STATE_AND_QUESTION_BYTES = 64 * 1024;
export const REQUEST_BYTES = 128 * 1024;
const MAX_CHUNKS = 64;

function prepareStates(request: ObservationRequest) {
  const questions = buildQuestions(request.selection, request.taskIds);
  const longestQuestion = Math.max(0, ...Object.values(questions).map(bytes));
  const { diff, changed_paths: _allPaths, ...shared } = request.state;
  // Prefer ~20 KiB groups; reduce them when a job's real metadata needs more room.
  let budget = Math.min(request.maxGroupBytes ?? 20 * 1024, STATE_AND_QUESTION_BYTES - bytes(shared) - longestQuestion - 1024);
  for (let attempt = 0; attempt < 12 && budget >= 1024; attempt++) {
    let parts;
    try { parts = splitDiff(diff, budget, request.workingDirectories); }
    catch (error) {
      if (error instanceof ChunkError) throw new ObservationSizeError(error.code === 'unparseable-diff' ? 'unrepresentable-change' : 'context-too-large');
      throw error;
    }
    if (parts.length > MAX_CHUNKS) throw new ObservationSizeError('diff-too-large');
    const states = parts.map((part, index) => ({ ...part,
      state: { ...shared, changed_paths: part.paths, diff: part.diff,
        chunk: { index, total: parts.length, start_byte: part.startByte, end_byte: part.endByte,
          preceding_diff_headers: part.context,
          scope: 'Evaluate only these files and hunks. Other groups are not included.' } } }));
    const excess = Math.max(...states.map(part => bytes(part.state) + longestQuestion - STATE_AND_QUESTION_BYTES));
    if (excess <= 0) return { states, questions };
    budget -= excess + 128;
  }
  throw new ObservationSizeError('context-too-large');
}

function questionBatches(taskIds: string[], questions: ReturnType<typeof buildQuestions>, state: unknown): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  for (const id of [...taskIds].sort()) {
    const candidate = [...batch, id];
    if (batch.length && bytes(state) + bytes(Object.fromEntries(candidate.map(id => [id, questions[id]]))) > REQUEST_BYTES) {
      batches.push(batch); batch = [];
    }
    batch.push(id);
  }
  if (batch.length) batches.push(batch);
  return batches;
}
const addUsage = (values: Array<Usage | null>): Usage | null => {
  const usages = values.filter((usage): usage is Usage => usage !== null);
  return usages.length ? usages.reduce((total, usage) => ({ input_tokens: total.input_tokens + usage.input_tokens,
    output_tokens: total.output_tokens + usage.output_tokens }), { input_tokens: 0, output_tokens: 0 }) : null;
};
const singleModel = (models: Array<string | null>): string | null => {
  const unique = [...new Set(models.filter(model => model !== null))];
  return unique.length === 1 ? unique[0]! : null;
};

export async function observeChange(request: ObservationRequest, evaluate: typeof evaluateJev) {
  const { states, questions } = prepareStates(request);
  const observation: Observation = { strategy: states.length === 1 ? 'whole-diff' : 'chunked-diff', status: 'incomplete',
    chunks: states.map((part, index) => ({ index, start_byte: part.startByte, end_byte: part.endByte, paths: part.paths,
      diff_hash: hash(part.diff), state_hash: hash(JSON.stringify(part.state)), diff_bytes: Buffer.byteLength(part.diff),
      status: 'not-started', judgments: null, model: null, usage: null, duration_ms: null, error: null,
      requests: questionBatches(request.taskIds, questions, part.state).map(task_ids => ({ task_ids,
        status: 'not-started', model: null, usage: null, duration_ms: null, error: null })) })) };
  const calls = observation.chunks.flatMap(chunk => chunk.requests!.map(call => ({ chunk, call })));
  const deadline = performance.now() + request.timeoutMs;
  let next = 0;
  let failure: ObservationError | undefined;
  async function worker(): Promise<void> {
    while (!failure && next < calls.length) {
      const { chunk, call } = calls[next++]!;
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) { failure = 'jev-timeout'; break; }
      const started = performance.now();
      try {
        const result = await evaluate({ ...request, taskIds: call.task_ids, state: states[chunk.index]!.state,
          timeoutMs: Math.min(10000, remaining) });
        // Injected evaluators must honor the same per-request answer contract as the SDK.
        const validated = validateChoicesResponse({ ...result,
          answers: Object.fromEntries(Object.entries(result.answers ?? {}).map(([id, answer]) => [id, { ...answer, type: 'choice' }])) },
        buildQuestions(request.selection, call.task_ids), request.selection.model);
        chunk.judgments = { ...chunk.judgments, ...validated.answers };
        call.status = 'completed';
        call.model = result.model; call.usage = result.usage;
      } catch (error) {
        if (!(error instanceof JevError)) { failure = 'jev-error'; throw error; }
        failure ??= error.code;
        call.status = 'failed'; call.error = error.code;
        call.model = error.metadata.model; call.usage = error.metadata.usage;
      } finally { call.duration_ms = performance.now() - started; }
    }
  }
  const workers = await Promise.allSettled(Array.from({ length: Math.min(3, calls.length) }, worker));
  const rejected = workers.find(result => result.status === 'rejected');
  if (rejected?.status === 'rejected') throw rejected.reason;
  for (const { call } of calls) if (call.status === 'not-started') call.error = failure ?? 'jev-timeout';
  for (const chunk of observation.chunks) {
    const requests = chunk.requests!;
    chunk.status = requests.every(call => call.status === 'completed') ? 'completed'
      : requests.some(call => call.status !== 'not-started') ? 'failed' : 'not-started';
    chunk.model = singleModel(requests.map(call => call.model));
    chunk.usage = addUsage(requests.map(call => call.usage));
    chunk.duration_ms = requests.some(call => call.duration_ms !== null)
      ? requests.reduce((total, call) => total + (call.duration_ms ?? 0), 0) : null;
    chunk.error = requests.find(call => call.error)?.error ?? null;
  }
  observation.status = observation.chunks.every(chunk => chunk.status === 'completed') ? 'complete' : 'incomplete';
  // Compose boolean decisions, never a synthetic global probability. A failed batch
  // does not erase complete evidence for other jobs sharing the same group.
  const decisions = decisionsFromObservation(observation, request.taskIds);
  return { observation, decisions, failure, model: singleModel(calls.map(({ call }) => call.model)),
    usage: addUsage(calls.map(({ call }) => call.usage)) };
}

/** Boolean composition only: raw judgments remain unchanged. */
export function decisionsFromObservation(observation: Observation, taskIds: string[]) {
  return Object.fromEntries(taskIds.map(id => {
    const choices = observation.chunks.map(chunk => chunk.judgments?.[id]?.choice);
    return [id, choices.some(value => value === 'required' || value === 'unresolved') ? true
      : choices.length > 0 && choices.every(value => value === 'independent') ? false : null];
  }));
}

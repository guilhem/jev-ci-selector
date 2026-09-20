import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { parseSelectionInputs, type SelectionDefinition, type ResolvedSelection } from '../../src/tasks.js';
import { resolveTasks, type SelectionMetadata, type ResolveTasksResult } from '../../src/metadata.js';
import { actionOutputs } from '../../src/report.js';
import { globalPathReason, selectTasks, type ExecutionPlan, type ForceAllReason, type TaskDecision } from '../../src/policy.js';
import { decisionsFromObservation, observeChange, ObservationSizeError, type Observation } from '../../src/observations.js';
import { splitDiff } from '../../src/chunks.js';
import { evaluateJev, type JevResult, type QuestionMode } from '../../src/jev.js';

const execFileAsync = promisify(execFile);
export const THRESHOLDS = [0.05, 0.1, 0.2, 0.3, 0.5] as const;
export const NATURAL_GROUP_BYTES = 48 * 1024;
export const PARTITIONED_GROUP_BYTES = 8 * 1024;
export const DEFAULT_REPORT_PATH = 'evaluation-report.json';

export type ContextVariant = 'description' | 'enriched';
export type GroupingVariant = 'natural' | 'partitioned';
export type EvaluationSplit = 'calibration' | 'validation';

export interface ExpectedLabel {
  relevance: 'relevant' | 'irrelevant' | 'unknown';
  reason: string;
}

export interface CorpusCase {
  id: string;
  split: EvaluationSplit;
  diff: string;
  baseFiles: string;
  snapshot: string;
  expected: Record<string, ExpectedLabel>;
  provenance: Record<string, unknown>;
}

export interface Corpus {
  version: 1;
  cases: CorpusCase[];
}

export interface LoadedCase {
  definition: CorpusCase;
  diff: string;
  changedPaths: string[];
  baseFingerprint: string;
  snapshotFingerprint: string;
  caseFingerprint: string;
  repositoryRoot: string;
  actionInputs: Record<string, string>;
  externalActions: Record<string, ExternalAction>;
  baseSha: string;
  headSha: string;
  testedSha: string;
  metadataCommit: string;
}

export interface ExternalAction {
  repository: string;
  commit: string;
  file: string;
  content: string;
  sha: string;
}

export interface EvaluationVariant {
  context: ContextVariant;
  questionMode: QuestionMode;
  grouping: GroupingVariant;
  maxGroupBytes: number;
}

export interface RequestCapture {
  body: unknown;
  serialized: string;
  sha256: string;
}

export interface ResponseCapture {
  status: number;
  body?: unknown;
}

export interface CallRecord {
  index: number;
  request: RequestCapture;
  response: ResponseCapture | null;
  error: string | null;
  duration_ms: number | null;
}

export interface ReplayCall extends CallRecord {
  used?: boolean;
}

export class ReplayStaleError extends Error {
  constructor(public readonly detail: string) {
    super(`replay-stale-request:${detail}`);
    this.name = 'ReplayStaleError';
  }
}

export interface ThresholdMetrics {
  relevant: number;
  relevantMisses: number;
  irrelevant: number;
  correctIrrelevantOmissions: number;
  irrelevantRetained: number;
  unknown: number;
  mismatches: number;
}

export interface ThresholdEvaluation {
  threshold: number;
  decisions: Record<string, boolean | null>;
  proposed: Record<string, boolean | null>;
  effective: Record<string, boolean>;
  tasks: { proposed: Record<string, TaskDecision>; effective: Record<string, TaskDecision> };
  actionOutputs: { proposed: Record<string, string>; effective: Record<string, string> };
  metrics: ThresholdMetrics;
}

export interface EvaluationRecord {
  version: 1;
  runId: string;
  source: {
    caseId: string;
    caseFingerprint: string;
    diffSha256: string;
    baseSha: string;
    headSha: string;
    testedSha: string;
    metadataCommit: string;
    snapshot: string;
  };
  variant: EvaluationVariant;
  repeat: number;
  date: { started: string; finished: string };
  sdk: { package: string; version: string; model: string | null; requestedModel: string | null };
  calls: CallRecord[];
  observation: Observation | null;
  observationError: string | null;
  policy: { bypass: boolean; reason: string | null };
  thresholds: Record<string, ThresholdEvaluation>;
  error: string | null;
}

export interface Selection {
  version: 1;
  sourceSplit: 'calibration';
  corpusFingerprint: string;
  qualified: boolean;
  selected: { context: ContextVariant; questionMode: QuestionMode; threshold: number };
  metrics: ThresholdMetrics & { runs: number; completeRuns: number; failedRuns: number; variant: string };
  exploratory: boolean;
  caseIds?: string[];
}

export interface CampaignManifest {
  version: 1;
  command: 'live' | 'replay';
  split: EvaluationSplit | null;
  corpusFingerprint: string;
  cases: Array<{ id: string; split: EvaluationSplit; caseFingerprint: string }>;
  variants: EvaluationVariant[];
  repeats: number;
  thresholds: number[];
  sdk: { package: string; version: string; model: string | null };
  created: string;
  updated: string;
  runs: string[];
  selection?: Selection;
}

export interface CampaignOptions {
  root: string;
  split: EvaluationSplit;
  caseIds?: string[];
  apiKey: string;
  apiBaseUrl?: string;
  apiModel?: string;
  output: string;
  selection?: Selection;
  progress?: (message: string) => void;
}

const isRecord = (value: unknown): value is Record<string, any> => typeof value === 'object' && value !== null && !Array.isArray(value);
const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

export function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  return value;
}

export function canonicalJson(value: unknown): string {
  const result = JSON.stringify(stableValue(value));
  if (result === undefined) throw new Error('invalid-json-value');
  return result;
}

function safePath(root: string, value: string): string {
  if (!value || value.includes('\0') || value.startsWith('/') || value.includes('\\')) throw new Error('invalid-evaluation-path');
  const result = resolve(root, value);
  const base = resolve(root);
  if (result !== base && !result.startsWith(`${base}${sep}`)) throw new Error('invalid-evaluation-path');
  return result;
}

async function directoryFingerprint(directory: string): Promise<string> {
  const entries: string[] = [];
  async function visit(current: string): Promise<void> {
    for (const name of (await readdir(current)).sort()) {
      const path = join(current, name);
      const info = await stat(path);
      const key = relative(directory, path).split(sep).join('/');
      if (info.isDirectory()) await visit(path);
      else if (info.isFile()) entries.push(`${key}\0${sha256(await readFile(path))}`);
      else throw new Error('invalid-evaluation-file');
    }
  }
  await visit(directory);
  return sha256(entries.join('\n'));
}

function objectFromJson(value: string, code: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) throw new Error();
    return parsed;
  } catch { throw new Error(code); }
}

export async function readCorpus(root: string): Promise<Corpus> {
  const value: unknown = JSON.parse(await readFile(safePath(root, 'corpus.json'), 'utf8'));
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.cases)) throw new Error('invalid-corpus');
  const cases = value.cases.map(item => {
    if (!isRecord(item) || typeof item.id !== 'string' || !['calibration', 'validation'].includes(item.split as string) ||
      typeof item.diff !== 'string' || typeof item.baseFiles !== 'string' || typeof item.snapshot !== 'string' ||
      !isRecord(item.expected) || !isRecord(item.provenance)) throw new Error('invalid-corpus');
    const expected: Record<string, ExpectedLabel> = {};
    for (const [id, label] of Object.entries(item.expected)) {
      if (!isRecord(label) || !['relevant', 'irrelevant', 'unknown'].includes(label.relevance as string) || typeof label.reason !== 'string') throw new Error('invalid-corpus');
      expected[id] = { relevance: label.relevance as ExpectedLabel['relevance'], reason: label.reason };
    }
    return { id: item.id, split: item.split as EvaluationSplit, diff: item.diff, baseFiles: item.baseFiles,
      snapshot: item.snapshot, expected, provenance: item.provenance };
  });
  if (new Set(cases.map(item => item.id)).size !== cases.length) throw new Error('invalid-corpus');
  return { version: 1, cases };
}

function shaFromProvenance(provenance: Record<string, unknown>, name: string, fallback: string): string {
  const value = provenance[name] ?? fallback;
  if (typeof value !== 'string' || !value) throw new Error(`invalid-provenance:${name}`);
  return value;
}

export function changedPathsFromDiff(diff: string): string[] {
  try {
    const budget = Math.max(1, Buffer.byteLength(diff, 'utf8'));
    return [...new Set(splitDiff(diff, budget).flatMap(chunk => chunk.paths))].sort();
  } catch { throw new Error('invalid-diff-path'); }
}

async function validatePatch(baseDirectory: string, diff: string): Promise<string[]> {
  const patchPath = join(baseDirectory, '.evaluation.patch');
  await writeFile(patchPath, diff, 'utf8');
  try {
    await execFileAsync('git', ['apply', '--check', '--whitespace=nowarn', patchPath], { cwd: baseDirectory, maxBuffer: 1024 * 1024 });
  } catch { throw new Error('invalid-corpus-patch'); }
  await rm(patchPath, { force: true });
  return changedPathsFromDiff(diff);
}

async function externalActions(snapshotRoot: string): Promise<Record<string, ExternalAction>> {
  const path = safePath(snapshotRoot, 'external-actions.json');
  const parsed = objectFromJson(await readFile(path, 'utf8'), 'invalid-external-actions');
  const result: Record<string, ExternalAction> = {};
  for (const [uses, value] of Object.entries(parsed)) {
    if (!isRecord(value) || typeof value.repository !== 'string' || typeof value.commit !== 'string' ||
      typeof value.file !== 'string' || typeof value.content !== 'string' || typeof value.sha !== 'string') throw new Error('invalid-external-actions');
    result[uses] = { repository: value.repository, commit: value.commit, file: value.file, content: value.content, sha: value.sha };
  }
  return result;
}

export async function loadCase(root: string, definition: CorpusCase): Promise<LoadedCase> {
  const diffPath = safePath(root, definition.diff);
  const basePath = safePath(root, definition.baseFiles);
  const snapshotPath = safePath(root, definition.snapshot);
  const repositoryRoot = safePath(snapshotPath, 'repository');
  const diff = await readFile(diffPath, 'utf8');
  const temporary = await mkdtemp(join(tmpdir(), 'jev-evaluation-'));
  try {
    const baseDirectory = join(temporary, 'base');
    await cp(basePath, baseDirectory, { recursive: true });
    const changedPaths = await validatePatch(baseDirectory, diff);
    const baseFingerprint = await directoryFingerprint(basePath);
    const snapshotFingerprint = sha256(canonicalJson({ repository: await directoryFingerprint(repositoryRoot), external: await directoryFingerprint(snapshotPath) }));
    const caseFingerprint = sha256(canonicalJson({ id: definition.id, split: definition.split, expected: definition.expected,
      provenance: definition.provenance, diff: sha256(diff), base: baseFingerprint, snapshot: snapshotFingerprint }));
    const actionInputsValue = objectFromJson(await readFile(join(snapshotPath, 'action-inputs.json'), 'utf8'), 'invalid-action-inputs');
    if (Object.values(actionInputsValue).some(value => typeof value !== 'string')) throw new Error('invalid-action-inputs');
    const actionInputs = actionInputsValue as Record<string, string>;
    const external = await externalActions(snapshotPath);
    const baseSha = shaFromProvenance(definition.provenance, 'base', caseFingerprint.slice(0, 40));
    const headSha = shaFromProvenance(definition.provenance, 'head', sha256(diff).slice(0, 40));
    const testedSha = shaFromProvenance(definition.provenance, 'tested', headSha);
    const metadataCommit = shaFromProvenance(definition.provenance, 'metadataCommit', baseSha);
    return { definition, diff, changedPaths, baseFingerprint, snapshotFingerprint, caseFingerprint, repositoryRoot, actionInputs,
      externalActions: external, baseSha, headSha, testedSha, metadataCommit };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function loadCases(root: string, corpus: Corpus, split: EvaluationSplit, caseIds?: string[]): Promise<LoadedCase[]> {
  const wanted = caseIds ? new Set(caseIds) : undefined;
  const definitions = corpus.cases.filter(item => item.split === split && (!wanted || wanted.has(item.id)));
  if (!definitions.length) throw new Error('no-evaluation-cases');
  if (wanted && definitions.length !== wanted.size) throw new Error('unknown-evaluation-case');
  return Promise.all(definitions.map(item => loadCase(root, item)));
}

export async function corpusFingerprint(corpus: Corpus, loaded: LoadedCase[]): Promise<string> {
  return sha256(canonicalJson({ version: corpus.version, cases: loaded.map(item => ({ id: item.definition.id, split: item.definition.split, fingerprint: item.caseFingerprint })) }));
}

function selectionForContext(selection: ResolvedSelection, context: ContextVariant): ResolvedSelection {
  const result = structuredClone(selection);
  if (context === 'description') {
    for (const task of Object.values(result.tasks)) task.evidence = { description: task.evidence.description };
  }
  return result;
}

export async function resolveEvaluationSelection(loaded: LoadedCase, context: ContextVariant): Promise<{ configured: SelectionDefinition; resolved: ResolveTasksResult; selection: ResolvedSelection }> {
  const configured = parseSelectionInputs(name => loaded.actionInputs[name] ?? '');
  const resolved = await resolveTasks(configured, {
    repository: String(loaded.definition.provenance.repository ?? loaded.definition.provenance.repo ?? 'snapshot/repository'),
    commit: loaded.metadataCommit,
    readFile: async (_commit, file) => readFile(safePath(loaded.repositoryRoot, file)),
    resolveExternal: async request => {
      const action = loaded.externalActions[request.uses];
      return action ? { ...action } : null;
    },
  });
  const expectedIds = Object.keys(loaded.definition.expected).sort();
  const resolvedIds = Object.keys(resolved.selection.tasks).sort();
  if (expectedIds.length !== resolvedIds.length || expectedIds.some((id, index) => id !== resolvedIds[index])) {
    throw new Error(`corpus-task-label-mismatch:${loaded.definition.id}`);
  }
  return { configured, resolved, selection: selectionForContext(resolved.selection, context) };
}

function withoutPolicyPaths(paths: string[]): string[] {
  return paths.filter(path => !path.startsWith('.github/workflows/'));
}

function applyMetadataPolicy(plan: ExecutionPlan, metadata: SelectionMetadata, configured: SelectionDefinition): ExecutionPlan {
  for (const [id, info] of Object.entries(metadata.tasks)) {
    if (!info.incomplete || !plan.tasks[id]) continue;
    if (!configured.tasks[id]?.always) plan.tasks[id]!.reasons = plan.tasks[id]!.reasons.filter(reason => reason !== 'always');
    if (!plan.tasks[id]!.reasons.includes('metadata-unavailable')) plan.tasks[id]!.reasons.push('metadata-unavailable');
  }
  return plan;
}

function proposedMap(plan: ExecutionPlan): Record<string, boolean | null> {
  return Object.fromEntries(Object.entries(plan.tasks).map(([id, task]) => [id, task.proposed_run]));
}

function effectiveMap(plan: ExecutionPlan): Record<string, boolean> {
  return { ...plan.run };
}

export function metricsForLabels(expected: Record<string, ExpectedLabel>, proposed: Record<string, boolean | null>): ThresholdMetrics {
  const metrics: ThresholdMetrics = { relevant: 0, relevantMisses: 0, irrelevant: 0, correctIrrelevantOmissions: 0, irrelevantRetained: 0, unknown: 0, mismatches: 0 };
  for (const [id, label] of Object.entries(expected)) {
    const value = proposed[id];
    if (label.relevance === 'unknown') { metrics.unknown += 1; continue; }
    if (label.relevance === 'relevant') {
      metrics.relevant += 1;
      if (value === false) { metrics.relevantMisses += 1; metrics.mismatches += 1; }
      continue;
    }
    metrics.irrelevant += 1;
    if (value === false) metrics.correctIrrelevantOmissions += 1;
    else { metrics.irrelevantRetained += 1; metrics.mismatches += 1; }
  }
  return metrics;
}

function mergeMetrics(values: ThresholdMetrics[]): ThresholdMetrics {
  return values.reduce((total, item) => ({ relevant: total.relevant + item.relevant, relevantMisses: total.relevantMisses + item.relevantMisses,
    irrelevant: total.irrelevant + item.irrelevant, correctIrrelevantOmissions: total.correctIrrelevantOmissions + item.correctIrrelevantOmissions,
    irrelevantRetained: total.irrelevantRetained + item.irrelevantRetained, unknown: total.unknown + item.unknown, mismatches: total.mismatches + item.mismatches }),
  { relevant: 0, relevantMisses: 0, irrelevant: 0, correctIrrelevantOmissions: 0, irrelevantRetained: 0, unknown: 0, mismatches: 0 });
}

function sdkVersion(): string {
  try { return String(createRequire(resolve(process.cwd(), 'package.json'))('@typesafe-ai/sdk/package.json').version); }
  catch { return 'unknown'; }
}

function bodyText(body: BodyInit | null | undefined): string {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  throw new Error('invalid-sdk-request-body');
}

export interface LiveTransport {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  calls: CallRecord[];
}

export function createLiveTransport(fetchImpl: typeof globalThis.fetch = globalThis.fetch): LiveTransport {
  const calls: CallRecord[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      const started = performance.now();
      const serialized = bodyText(init?.body);
      let body: unknown;
      try { body = JSON.parse(serialized); } catch { body = null; }
      const call: CallRecord = { index: calls.length, request: { body, serialized, sha256: sha256(serialized) }, response: null, error: null, duration_ms: null };
      calls.push(call);
      try {
        const response = await fetchImpl(url, init);
        if (response.ok) {
          const text = await response.clone().text();
          try { call.response = { status: response.status, body: JSON.parse(text) }; }
          catch { call.response = { status: response.status }; call.error = 'invalid-response-body'; }
        } else {
          call.response = { status: response.status };
          call.error = `http-${response.status}`;
        }
        return response;
      } catch {
        call.error = init?.signal?.aborted ? 'timeout' : 'network-error';
        throw new Error('evaluation-network-error');
      } finally { call.duration_ms = performance.now() - started; }
    },
  };
}

export interface ReplayTransport {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  stale: () => ReplayStaleError | null;
}

export function createReplayTransport(expected: ReplayCall[]): ReplayTransport {
  let staleError: ReplayStaleError | null = null;
  return {
    stale: () => staleError,
    fetch: async (_url, init) => {
      if (staleError) throw new Error('replay-request-mismatch');
      const serialized = bodyText(init?.body);
      const bodyHash = sha256(serialized);
      const match = expected.find(call => !call.used && call.request.serialized === serialized && call.request.sha256 === bodyHash);
      if (!match) {
        staleError ??= new ReplayStaleError(`body-mismatch:${bodyHash}`);
        throw new Error('replay-request-mismatch');
      }
      match.used = true;
      if (match.response) {
        const body = match.response.body === undefined ? '' : JSON.stringify(match.response.body);
        return new Response(body, { status: match.response.status, headers: { 'content-type': 'application/json' } });
      }
      if (match.error === 'timeout') return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) { reject(new Error('recorded-timeout')); return; }
        signal?.addEventListener('abort', () => reject(new Error('recorded-timeout')), { once: true });
      });
      throw new Error(match.error ?? 'recorded-provider-error');
    },
  };
}

async function observationFor(
  loaded: LoadedCase,
  variant: EvaluationVariant,
  resolved: { configured: SelectionDefinition; resolved: ResolveTasksResult; selection: ResolvedSelection },
  apiKey: string,
  apiBaseUrl: string | undefined,
  apiModel: string | undefined,
  replayCalls?: ReplayCall[],
): Promise<{ result: Awaited<ReturnType<typeof observeChange>> | null; calls: CallRecord[]; stale: ReplayStaleError | null; evaluationError: string | null }> {
  const transport = replayCalls ? createReplayTransport(replayCalls) : createLiveTransport();
  const taskIds = Object.keys(resolved.selection.tasks).sort();
  const evaluate = (input: Parameters<typeof evaluateJev>[0]): Promise<JevResult> => evaluateJev(input, transport.fetch);
  let result: Awaited<ReturnType<typeof observeChange>> | null = null;
  let evaluationError: string | null = null;
  try {
    const request = { selection: resolved.selection, taskIds, workingDirectories: resolved.resolved.workingDirectories,
      ...(apiBaseUrl ? { apiBaseUrl } : {}), ...(apiModel ? { apiModel } : {}), apiKey, timeoutMs: 120_000, questionMode: variant.questionMode, maxGroupBytes: variant.maxGroupBytes,
      state: { base_sha: loaded.baseSha, head_sha: loaded.headSha, tested_sha: loaded.testedSha, changed_paths: loaded.changedPaths, diff: loaded.diff } };
    result = await observeChange(request, evaluate);
  } catch (error) {
    if (error instanceof ReplayStaleError) evaluationError = error.detail;
    else if (error instanceof ObservationSizeError) evaluationError = error.code;
    else throw error;
  }
  const calls = 'calls' in transport ? transport.calls : (replayCalls ?? []).map(({ used: _used, ...call }) => call);
  if (result) {
    const observedCalls = result.observation.chunks.flatMap(chunk => chunk.requests ?? []);
    for (const observedCall of observedCalls.filter(call => call.error === 'jev-timeout')) {
      const captured = calls.find(call => call.response === null && call.error === null);
      if (captured) captured.error = 'timeout';
    }
  }
  return { result, calls, stale: replayCalls ? (transport as ReplayTransport).stale() : null, evaluationError };
}

export function thresholdEvaluations(
  loaded: LoadedCase,
  variant: EvaluationVariant,
  configured: SelectionDefinition,
  resolved: ResolveTasksResult,
  result: Awaited<ReturnType<typeof observeChange>> | null,
): Record<string, ThresholdEvaluation> {
  const taskIds = Object.keys(resolved.selection.tasks).sort();
  const bypass = globalPathReason(loaded.changedPaths);
  const semanticPaths = withoutPolicyPaths(loaded.changedPaths);
  const values: Record<string, ThresholdEvaluation> = {};
  for (const threshold of THRESHOLDS) {
    const decisions = result ? decisionsFromObservation(result.observation, taskIds, threshold, variant.questionMode) : {};
    const semantic = applyMetadataPolicy(selectTasks({ selection: resolved.selection, changedPaths: semanticPaths, decisions, observationError: result?.failure as any,
      mode: 'enforce' }), resolved.metadata, configured);
    const effective = applyMetadataPolicy(selectTasks({ selection: resolved.selection, changedPaths: loaded.changedPaths, decisions, observationError: result?.failure as any,
      mode: 'shadow', ...(bypass ? { forceAllReason: bypass as ForceAllReason } : {}) }), resolved.metadata, configured);
    const proposed = proposedMap(semantic);
    values[String(threshold)] = { threshold, decisions, proposed, effective: effectiveMap(effective),
      tasks: { proposed: semantic.tasks, effective: effective.tasks },
      actionOutputs: { proposed: actionOutputs(semantic, loaded.testedSha, DEFAULT_REPORT_PATH), effective: actionOutputs(effective, loaded.testedSha, DEFAULT_REPORT_PATH) },
      metrics: metricsForLabels(loaded.definition.expected, proposed) };
  }
  return values;
}

function variantKey(variant: Pick<EvaluationVariant, 'context' | 'questionMode'>): string {
  return `${variant.context}/${variant.questionMode}`;
}

export function chooseSelection(records: EvaluationRecord[], corpusFingerprintValue: string, caseIds?: string[]): Selection {
  const candidates = new Map<string, { context: ContextVariant; questionMode: QuestionMode; metrics: ThresholdMetrics; runs: number; completeRuns: number; failedRuns: number }>();
  const successful = (record: EvaluationRecord): boolean => record.observation?.status === 'complete' && record.observationError === null && record.error === null &&
    Object.values(record.thresholds).every(value => Object.values(value.decisions).every(decision => decision !== null));
  for (const record of records) {
    const key = variantKey(record.variant);
    for (const value of Object.values(record.thresholds)) {
      const candidateKey = `${key}/${value.threshold}`;
      const current = candidates.get(candidateKey) ?? { context: record.variant.context, questionMode: record.variant.questionMode,
        metrics: { relevant: 0, relevantMisses: 0, irrelevant: 0, correctIrrelevantOmissions: 0, irrelevantRetained: 0, unknown: 0, mismatches: 0 }, runs: 0, completeRuns: 0, failedRuns: 0 };
      current.runs += 1;
      if (successful(record)) { current.metrics = mergeMetrics([current.metrics, value.metrics]); current.completeRuns += 1; }
      else current.failedRuns += 1;
      candidates.set(candidateKey, current);
    }
  }
  if (!candidates.size) throw new Error('no-evaluation-metrics');
  const order = (item: { context: ContextVariant; questionMode: QuestionMode }): number =>
    (item.context === 'description' ? 0 : 2) + (item.questionMode === 'single' ? 0 : 1);
  const entries = [...candidates.entries()].map(([key, value]) => ({ key, ...value, threshold: Number(key.split('/').at(-1)) }));
  entries.sort((left, right) => {
    const leftQualified = left.failedRuns === 0 && left.metrics.relevantMisses === 0 && left.metrics.correctIrrelevantOmissions > 0;
    const rightQualified = right.failedRuns === 0 && right.metrics.relevantMisses === 0 && right.metrics.correctIrrelevantOmissions > 0;
    if (leftQualified !== rightQualified) return leftQualified ? -1 : 1;
    if (left.failedRuns !== right.failedRuns) return left.failedRuns - right.failedRuns;
    if (!leftQualified && left.metrics.relevantMisses !== right.metrics.relevantMisses) return left.metrics.relevantMisses - right.metrics.relevantMisses;
    if (left.metrics.correctIrrelevantOmissions !== right.metrics.correctIrrelevantOmissions) return right.metrics.correctIrrelevantOmissions - left.metrics.correctIrrelevantOmissions;
    if (left.threshold !== right.threshold) return left.threshold - right.threshold;
    return order(left) - order(right);
  });
  const selected = entries[0]!;
  return { version: 1, sourceSplit: 'calibration', corpusFingerprint: corpusFingerprintValue,
    qualified: selected.failedRuns === 0 && selected.metrics.relevantMisses === 0 && selected.metrics.correctIrrelevantOmissions > 0,
    exploratory: !(selected.failedRuns === 0 && selected.metrics.relevantMisses === 0 && selected.metrics.correctIrrelevantOmissions > 0),
    selected: { context: selected.context, questionMode: selected.questionMode, threshold: selected.threshold },
    metrics: { ...selected.metrics, runs: selected.runs, completeRuns: selected.completeRuns, failedRuns: selected.failedRuns, variant: `${selected.context}/${selected.questionMode}` },
    ...(caseIds ? { caseIds: [...caseIds].sort() } : {}) };
}

export function replayComparable(record: EvaluationRecord): unknown {
  return stableValue({ source: record.source, variant: record.variant, repeat: record.repeat, calls: record.calls.map(call => {
    const { used: _used, ...replayCall } = call as CallRecord & { used?: boolean };
    return { ...replayCall, duration_ms: null };
  }),
    observation: record.observation ? stripDurations(record.observation) : null, observationError: record.observationError,
    policy: record.policy, thresholds: record.thresholds, error: record.error });
}

function stripDurations(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDurations);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'duration_ms' ? null : stripDurations(item)]));
}

function caseSource(loaded: LoadedCase): EvaluationRecord['source'] {
  return { caseId: loaded.definition.id, caseFingerprint: loaded.caseFingerprint, diffSha256: sha256(loaded.diff), baseSha: loaded.baseSha,
    headSha: loaded.headSha, testedSha: loaded.testedSha, metadataCommit: loaded.metadataCommit, snapshot: loaded.definition.snapshot };
}

export async function evaluateRecord(
  loaded: LoadedCase,
  variant: EvaluationVariant,
  repeat: number,
  apiKey: string,
  apiBaseUrl?: string,
  apiModel?: string,
  replayCalls?: ReplayCall[],
): Promise<EvaluationRecord> {
  const started = new Date().toISOString();
  const resolved = await resolveEvaluationSelection(loaded, variant.context);
  const observed = await observationFor(loaded, variant, resolved, apiKey, apiBaseUrl, apiModel, replayCalls);
  if (observed.stale) throw observed.stale;
  const thresholds = thresholdEvaluations(loaded, variant, resolved.configured, resolved.resolved, observed.result);
  const bypass = globalPathReason(loaded.changedPaths);
  return { version: 1, runId: `${loaded.definition.id}-${variant.context}-${variant.questionMode}-${variant.grouping}-${repeat}`,
    source: caseSource(loaded), variant, repeat, date: { started, finished: new Date().toISOString() },
    sdk: { package: '@typesafe-ai/sdk', version: sdkVersion(), model: observed.result?.model ?? null, requestedModel: apiModel ?? resolved.selection.model },
    calls: observed.calls, observation: observed.result?.observation ?? null, observationError: observed.result?.failure ?? observed.evaluationError,
    policy: { bypass: !!bypass, reason: bypass?.code ?? null }, thresholds, error: observed.evaluationError };
}

export function variantsForCalibration(): EvaluationVariant[] {
  const result: EvaluationVariant[] = [];
  for (const context of ['description', 'enriched'] as const) for (const questionMode of ['single', 'split'] as const) {
    result.push({ context, questionMode, grouping: 'natural', maxGroupBytes: NATURAL_GROUP_BYTES });
    result.push({ context, questionMode, grouping: 'partitioned', maxGroupBytes: PARTITIONED_GROUP_BYTES });
  }
  return result;
}

export function partitionedGroupBytes(diffBytes: number): number {
  return Math.min(PARTITIONED_GROUP_BYTES, Math.max(1024, Math.floor(diffBytes / 2)));
}

export function variantForCase(variant: EvaluationVariant, diffBytes: number): EvaluationVariant {
  return variant.grouping === 'partitioned' ? { ...variant, maxGroupBytes: partitionedGroupBytes(diffBytes) } : variant;
}

export function variantsForValidation(selection: Selection): EvaluationVariant[] {
  const { context, questionMode } = selection.selected;
  return [{ context, questionMode, grouping: 'natural', maxGroupBytes: NATURAL_GROUP_BYTES },
    { context, questionMode, grouping: 'partitioned', maxGroupBytes: PARTITIONED_GROUP_BYTES }];
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function createOutputDirectory(path: string): Promise<string> {
  const output = resolve(path);
  await mkdir(output);
  return output;
}

export function assertSelection(selection: unknown, corpusFingerprintValue: string): asserts selection is Selection {
  if (!isRecord(selection) || selection.version !== 1 || selection.sourceSplit !== 'calibration' ||
    selection.corpusFingerprint !== corpusFingerprintValue || typeof selection.qualified !== 'boolean' || !isRecord(selection.selected) ||
    !['description', 'enriched'].includes(selection.selected.context as string) || !['single', 'split'].includes(selection.selected.questionMode as string) ||
    !THRESHOLDS.includes(selection.selected.threshold as never) ||
    (selection.caseIds !== undefined && (!Array.isArray(selection.caseIds) || selection.caseIds.some(id => typeof id !== 'string') || new Set(selection.caseIds).size !== selection.caseIds.length))) {
    throw new Error('stale-selection');
  }
}

export function assertReplayRecordSource(record: EvaluationRecord, loaded: LoadedCase): void {
  if (record.source.caseId !== loaded.definition.id || record.source.caseFingerprint !== loaded.caseFingerprint ||
    record.source.diffSha256 !== sha256(loaded.diff)) throw new ReplayStaleError(`source:${loaded.definition.id}`);
}

export async function runLiveCampaign(options: CampaignOptions): Promise<{ manifest: CampaignManifest; records: EvaluationRecord[]; output: string }> {
  const corpus = await readCorpus(options.root);
  const loaded = await loadCases(options.root, corpus, options.split, options.caseIds);
  const calibrationLoaded = options.split === 'calibration' ? loaded : await loadCases(options.root, corpus, 'calibration', options.selection?.caseIds);
  const fingerprint = await corpusFingerprint(corpus, calibrationLoaded);
  if (options.split === 'validation') {
    if (!options.selection) throw new Error('validation-requires-selection');
    assertSelection(options.selection, fingerprint);
  }
  const variants = options.split === 'calibration' ? variantsForCalibration() : variantsForValidation(options.selection!);
  const output = await createOutputDirectory(options.output);
  const manifest: CampaignManifest = { version: 1, command: 'live', split: options.split, corpusFingerprint: fingerprint,
    cases: loaded.map(item => ({ id: item.definition.id, split: item.definition.split, caseFingerprint: item.caseFingerprint })), variants, repeats: 3,
    thresholds: [...THRESHOLDS], sdk: { package: '@typesafe-ai/sdk', version: sdkVersion(), model: options.apiModel ?? null },
    created: new Date().toISOString(), updated: new Date().toISOString(), runs: [],
    ...(options.split === 'validation' ? { selection: options.selection } : {}) };
  await mkdir(join(output, 'runs'));
  await writeJson(join(output, 'manifest.json'), manifest);
  const records: EvaluationRecord[] = [];
  let index = 0;
  for (const item of loaded) for (const baseVariant of variants) for (let repeat = 1; repeat <= 3; repeat += 1) {
    const variant = variantForCase(baseVariant, Buffer.byteLength(item.diff));
    const record = await evaluateRecord(item, variant, repeat, options.apiKey, options.apiBaseUrl, options.apiModel);
    const name = `${String(index).padStart(4, '0')}-${record.runId}.json`;
    await writeJson(join(output, 'runs', name), record);
    manifest.runs.push(`runs/${name}`); manifest.updated = new Date().toISOString(); records.push(record); index += 1;
    await writeJson(join(output, 'manifest.json'), manifest);
    options.progress?.(`[${index}/${loaded.length * variants.length * 3}] ${record.runId}: groups=${record.observation?.chunks.length ?? 0} calls=${record.calls.length} status=${record.observation?.status ?? record.error ?? 'error'}`);
  }
  if (options.split === 'calibration') {
    manifest.selection = chooseSelection(records, fingerprint, loaded.map(item => item.definition.id));
    await writeJson(join(output, 'selection.json'), manifest.selection);
    manifest.updated = new Date().toISOString(); await writeJson(join(output, 'manifest.json'), manifest);
  }
  return { manifest, records, output };
}

async function readManifest(campaign: string): Promise<CampaignManifest> {
  const value: unknown = JSON.parse(await readFile(join(campaign, 'manifest.json'), 'utf8'));
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.runs) || typeof value.corpusFingerprint !== 'string') throw new Error('invalid-campaign');
  return value as unknown as CampaignManifest;
}

export async function replayCampaign(root: string, campaignPath: string, caseIds?: string[]): Promise<{ checked: number; stale: number }> {
  const campaign = resolve(campaignPath);
  const manifest = await readManifest(campaign);
  if (!manifest.split) throw new Error('invalid-campaign');
  const corpus = await readCorpus(root);
  const recordedCaseIds = manifest.cases.map(item => item.id);
  const loaded = await loadCases(root, corpus, manifest.split, caseIds ?? recordedCaseIds);
  const calibrationLoaded = await loadCases(root, corpus, 'calibration', manifest.selection?.caseIds ?? (manifest.split === 'calibration' ? recordedCaseIds : undefined));
  const fingerprint = await corpusFingerprint(corpus, calibrationLoaded);
  if (fingerprint !== manifest.corpusFingerprint) throw new ReplayStaleError('corpus');
  const byId = new Map(loaded.map(item => [item.definition.id, item]));
  let checked = 0;
  for (const runPath of manifest.runs) {
    const original: EvaluationRecord = JSON.parse(await readFile(join(campaign, runPath), 'utf8'));
    const item = byId.get(original.source.caseId);
    if (!item) continue;
    assertReplayRecordSource(original, item);
    const replayCalls = original.calls.map(call => ({ ...call, used: false }));
    const replayed = await evaluateRecord(item, original.variant, original.repeat, 'replay-key', 'https://api.typesafe.ai', original.sdk.requestedModel ?? undefined, replayCalls);
    const stale = replayCalls.find(call => !call.used);
    if (stale) throw new ReplayStaleError(`unused-call:${original.runId}`);
    if (canonicalJson(replayComparable(replayed)) !== canonicalJson(replayComparable(original))) throw new ReplayStaleError(`output:${original.runId}`);
    checked += 1;
  }
  return { checked, stale: 0 };
}

import { judgment } from '../fixtures/selection.js';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { choice, type EntryType } from '@typesafe-ai/sdk';
import { resolveTasks, type ResolveTasksResult } from '../../src/metadata.js';
import { buildQuestions, evaluateChoices, evaluateJev, JevError, type ChoiceJudgment, type JevResult, type Usage } from '../../src/jev.js';
import { ObservationSizeError, observeChange, type Observation } from '../../src/observations.js';
import { resolveContextFiles, type ContextResolutionReport } from '../../src/context.js';
import { selectTasks, type ExecutionPlan } from '../../src/policy.js';
import type { SelectionDefinition } from '../../src/tasks.js';

type PassCount = 1 | 2 | 3;
type ContextRequest = Parameters<typeof resolveContextFiles>[0];
type ContextEvaluate = (input: Parameters<typeof evaluateChoices>[0]) => ReturnType<typeof evaluateChoices>;
type FinalRequest = Parameters<typeof evaluateJev>[0];

interface ContextHint { jobId: string; direct: string[]; links: Record<string, string[]> }
interface ContextCase {
  id: string;
  files: Record<string, string>;
  diff: string;
  tasks: SelectionDefinition['tasks'];
  expectedContext: Record<string, string[]>;
  expectedTasks: Record<string, 'relevant' | 'irrelevant'>;
  hints: ContextHint[];
}
interface FinalCall {
  request_hash: string;
  task_ids: string[];
  status: 'completed' | 'failed';
  model: string | null;
  usage: Usage | null;
  duration_ms: number;
  error: 'jev-timeout' | 'jev-error' | 'invalid-response' | null;
}
interface CaseRecord {
  version: 1;
  case_id: string;
  case_hash: string;
  pass_count: PassCount;
  status: 'complete' | 'incomplete';
  started: string;
  finished: string;
  timings_ms: { total: number; context: number; final: number };
  completeness: { status: 'complete' | 'incomplete'; context: 'complete' | 'incomplete'; metadata: 'complete' | 'incomplete'; final: 'complete' | 'incomplete'; reasons: string[] };
  context: ContextResolutionReport;
  selected_files: Record<string, Array<{ path: string; sha256: string }>>;
  final: { status: 'complete' | 'incomplete'; decisions: Record<string, boolean | null>; plan: ExecutionPlan; observation: Observation | null; calls: FinalCall[]; usage: Usage | null; duration_ms: number; error: string | null };
  metrics: { needed_files: number; recalled_files: number; missing_files: Record<string, string[]>; file_recall: number; incorrect_skips: string[]; irrelevant_retained: string[] };
}

const MODEL = 'jev-1.13.0';
const DEADLINE_MS = 120_000;
const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [key, stable((value as Record<string, unknown>)[key])]));
  return value;
}
const canonical = (value: unknown): string => JSON.stringify(stable(value));
const caseHash = (item: ContextCase): string => sha256(canonical({ id: item.id, files: item.files, diff: item.diff, tasks: item.tasks, expectedContext: item.expectedContext, expectedTasks: item.expectedTasks }));

function sourcePath(question: ReturnType<typeof choice>): string {
  const instructions = question.instructions as unknown as { path?: unknown };
  if (typeof instructions.path !== 'string') throw new Error('context-question-missing-path');
  return instructions.path;
}

function choiceAnswer(question: ReturnType<typeof choice>, selected: string): ChoiceJudgment {
  const criteria = Object.keys(question.criteria);
  const choiceValue = criteria.includes(selected) ? selected : criteria[criteria.length - 1]!;
  return { choice: choiceValue, confidence: 1, probabilities: Object.fromEntries(criteria.map(key => [key, key === choiceValue ? 1 : 0])) };
}

function hintFor(item: ContextCase, job: { id?: unknown } | undefined): ContextHint | undefined {
  return typeof job?.id === 'string' ? item.hints.find(hint => hint.jobId === job.id) : undefined;
}

function offlineContextEvaluator(item: ContextCase): ContextEvaluate {
  return async request => {
    const state = request.state as EntryType & { job?: { id?: string }; sources?: Array<{ path: string }> };
    const hint = hintFor(item, state.job);
    const selected = new Set((state.sources ?? []).map(source => source.path));
    const answers = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
      const path = sourcePath(question);
      const answer = selected.has(path) ? 'keep' : hint?.direct.includes(path) || [...selected].some(source => hint?.links[source]?.includes(path)) ? 'inspect' : 'ignore';
      return [id, choiceAnswer(question, answer)];
    }));
    return { model: request.model, usage: { input_tokens: Object.keys(request.questions).length, output_tokens: 1 }, answers };
  };
}

function offlineFinalEvaluator(item: ContextCase): (request: FinalRequest) => Promise<JevResult> {
  return async request => {
    const answers = Object.fromEntries(request.taskIds.map(taskId => {
      const files = ((request.selection.tasks[taskId]?.evidence.contextFiles ?? []) as Array<{ path?: unknown }>);
      const available = new Set(files.flatMap(file => typeof file.path === 'string' ? [file.path] : []));
      const complete = (item.expectedContext[taskId] ?? []).every(path => available.has(path));
      return [taskId, judgment(item.expectedTasks[taskId] === 'relevant' && complete ? 'required' : 'independent')];
    }));
    return { model: request.selection.model, usage: { input_tokens: request.taskIds.length, output_tokens: request.taskIds.length }, answers };
  };
}

function syntheticCases(): ContextCase[] {
  const workflow = '.github/workflows/ci.yml';
  return [
    {
      id: 'python-wrapper-config-scope',
      files: {
        [workflow]: 'jobs:\n  unit:\n    steps:\n      - run: python tools/run_unit.py\n  docs:\n    steps:\n      - run: mkdocs build\n',
        'tools/run_unit.py': 'import subprocess\nimport tomllib\n\nwith open("config/unit.toml", "rb") as stream:\n    config = tomllib.load(stream)\nsubprocess.run(["pytest", config["test_root"]], check=True)\n',
        'config/unit.toml': 'test_root = "tests/unit"\n',
        'tests/unit/test_cart.py': 'from src.cart import total\n\ndef test_cart_total():\n    assert total(5, 2, 1) == 9\n',
        'docs/mkdocs.yml': 'site_name: Example\n',
        'README.md': 'Documentation only.\n',
      },
      diff: 'diff --git a/src/cart.py b/src/cart.py\n--- a/src/cart.py\n+++ b/src/cart.py\n@@ -1 +1 @@\n-return total\n+return total - discount\n',
      tasks: { unit: { resolve_context_files: true, description: 'Runs the Python unit tests for cart behavior.', jobs: [{ workflow, job: 'unit' }] }, docs: { resolve_context_files: true, description: 'Builds the documentation website.', jobs: [{ workflow, job: 'docs' }] } },
      expectedContext: { unit: ['tools/run_unit.py', 'config/unit.toml', 'tests/unit/test_cart.py'], docs: [] },
      expectedTasks: { unit: 'relevant', docs: 'irrelevant' },
      hints: [{ jobId: 'unit', direct: ['tools/run_unit.py'], links: { 'tools/run_unit.py': ['config/unit.toml'], 'config/unit.toml': ['tests/unit/test_cart.py'] } }],
    },
    {
      id: 'go-wrapper-config-scope',
      files: {
        [workflow]: 'jobs:\n  unit:\n    steps:\n      - run: go run tools/check.go\n  docs:\n    steps:\n      - run: mkdocs build\n',
        'tools/check.go': 'config := loadTargets("config/go-check.yaml")\ncmd := exec.Command("go", append([]string{"test"}, config.Packages...)...)\ncmd.Run()\n',
        'config/go-check.yaml': 'packages:\n  - internal/cart/...\n',
        'internal/cart/total_test.go': 'package cart\n\nfunc TestTotal() {}\n',
        'docs/mkdocs.yml': 'site_name: Example\n',
        'go.mod': 'module example.test/cart\n',
      },
      diff: 'diff --git a/internal/cart/total.go b/internal/cart/total.go\n--- a/internal/cart/total.go\n+++ b/internal/cart/total.go\n@@ -1 +1 @@\n-return price * quantity\n+return price*quantity - discount\n',
      tasks: { unit: { resolve_context_files: true, description: 'Runs the Go tests for cart behavior.', jobs: [{ workflow, job: 'unit' }] }, docs: { resolve_context_files: true, description: 'Builds the documentation website.', jobs: [{ workflow, job: 'docs' }] } },
      expectedContext: { unit: ['tools/check.go', 'config/go-check.yaml', 'internal/cart/total_test.go'], docs: [] },
      expectedTasks: { unit: 'relevant', docs: 'irrelevant' },
      hints: [{ jobId: 'unit', direct: ['tools/check.go'], links: { 'tools/check.go': ['config/go-check.yaml'], 'config/go-check.yaml': ['internal/cart/total_test.go'] } }],
    },
    {
      id: 'generic-wrapper-config-scope',
      files: {
        [workflow]: 'jobs:\n  check:\n    steps:\n      - run: node scripts/check.mjs\n  docs:\n    steps:\n      - run: mkdocs build\n',
        'scripts/check.mjs': 'const scope = JSON.parse(readFileSync("config/check-scope.json"));\nspawnSync("node", ["--test", ...scope.paths.map(path => `${path}/check.test.js`)], { stdio: "inherit" });\n',
        'config/check-scope.json': '{"paths":["packages/api"]}\n',
        'packages/api/check.test.js': 'export test from "./handler.js";\n',
        'packages/api/handler.js': 'export function check() { return true; }\n',
        'docs/mkdocs.yml': 'site_name: Example\n',
        'package.json': '{"private":true}\n',
      },
      diff: 'diff --git a/packages/api/handler.js b/packages/api/handler.js\n--- a/packages/api/handler.js\n+++ b/packages/api/handler.js\n@@ -1 +1 @@\n-export function check() { return true; }\n+export function check() { return false; }\n',
      tasks: { check: { resolve_context_files: true, description: 'Runs the API verification command.', jobs: [{ workflow, job: 'check' }] }, docs: { resolve_context_files: true, description: 'Builds the documentation website.', jobs: [{ workflow, job: 'docs' }] } },
      expectedContext: { check: ['scripts/check.mjs', 'config/check-scope.json', 'packages/api/check.test.js'], docs: [] },
      expectedTasks: { check: 'relevant', docs: 'irrelevant' },
      hints: [{ jobId: 'check', direct: ['scripts/check.mjs'], links: { 'scripts/check.mjs': ['config/check-scope.json'], 'config/check-scope.json': ['packages/api/check.test.js'] } }],
    },
  ];
}

function repositoryFor(item: ContextCase, commit: string) {
  return {
    listFiles: async (requestedCommit: string) => { if (requestedCommit !== commit) throw new Error('unexpected-commit'); return Object.keys(item.files).sort(); },
    readFile: async (requestedCommit: string, path: string) => { if (requestedCommit !== commit) throw new Error('unexpected-commit'); const content = item.files[path]; if (content === undefined) throw new Error('missing-file'); return Buffer.from(content); },
  };
}

async function freshResolution(item: ContextCase): Promise<{ configured: SelectionDefinition; resolved: ResolveTasksResult; repository: ReturnType<typeof repositoryFor>; commit: string }> {
  const configured: SelectionDefinition = { model: MODEL, tasks: item.tasks };
  const commit = sha256(item.id).slice(0, 40);
  const repository = repositoryFor(item, commit);
  const resolved = await resolveTasks(configured, { repository: `synthetic/${item.id}`, commit, readFile: repository.readFile });
  return { configured, resolved, repository, commit };
}

function selectedFiles(resolved: ResolveTasksResult): Record<string, Array<{ path: string; sha256: string }>> {
  return Object.fromEntries(Object.entries(resolved.selection.tasks).map(([taskId, task]) => [taskId, ((task.evidence.contextFiles ?? []) as Array<{ path?: unknown; content?: unknown }>).flatMap(file => typeof file.path === 'string' && typeof file.content === 'string' ? [{ path: file.path, sha256: sha256(file.content) }] : []).sort((left, right) => left.path.localeCompare(right.path))]));
}

function changedPaths(diff: string): string[] { return [...new Set([...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(match => match[1]!))].sort(); }

function metricsFor(item: ContextCase, selected: Record<string, Array<{ path: string; sha256: string }>>, plan: ExecutionPlan) {
  const missingByTask = Object.fromEntries(Object.entries(item.expectedContext).map(([taskId, needed]) => {
    const selectedPaths = new Set((selected[taskId] ?? []).map(file => file.path));
    return [taskId, needed.filter(path => !selectedPaths.has(path))];
  }));
  const missingFiles = Object.values(missingByTask).flat();
  const neededFiles = Object.values(item.expectedContext).flat().length;
  return {
    needed_files: neededFiles,
    recalled_files: neededFiles - missingFiles.length,
    missing_files: missingByTask,
    file_recall: neededFiles ? (neededFiles - missingFiles.length) / neededFiles : 1,
    incorrect_skips: Object.entries(item.expectedTasks).filter(([taskId, label]) => label === 'relevant' && plan.run[taskId] === false).map(([taskId]) => taskId),
    irrelevant_retained: Object.entries(item.expectedTasks).filter(([taskId, label]) => label === 'irrelevant' && plan.run[taskId] === true).map(([taskId]) => taskId),
  };
}

async function evaluateCase(item: ContextCase, passCount: PassCount, mode: 'offline' | 'live', apiKey: string, apiBaseUrl?: string, apiModel?: string): Promise<CaseRecord> {
  const started = new Date().toISOString();
  const totalStart = performance.now();
  const reasons: string[] = [];
  const { configured, resolved, repository, commit } = await freshResolution(item);
  const contextStart = performance.now();
  const contextRequest: ContextRequest = { configured, resolved, repository, commit, apiKey, deadline: performance.now() + DEADLINE_MS, ...(apiBaseUrl ? { apiBaseUrl } : {}), ...(apiModel ? { apiModel } : {}) };
  const context = await resolveContextFiles(contextRequest, mode === 'offline' ? offlineContextEvaluator(item) : evaluateChoices, passCount);
  const contextDuration = performance.now() - contextStart;
  const finalCalls: FinalCall[] = [];
  const finalStart = performance.now();
  const finalEvaluator = async (request: FinalRequest): Promise<JevResult> => {
    const questions = buildQuestions(request.selection, request.taskIds);
    const requestHash = sha256(canonical({ model: request.apiModel ?? request.selection.model, state: request.state, questions }));
    const callStart = performance.now();
    try {
      const result = mode === 'offline' ? await offlineFinalEvaluator(item)(request) : await evaluateJev(request);
      finalCalls.push({ request_hash: requestHash, task_ids: [...request.taskIds].sort(), status: 'completed', model: result.model, usage: result.usage, duration_ms: performance.now() - callStart, error: null });
      return result;
    } catch (error) {
      const metadata = error instanceof JevError ? error.metadata : { model: null, usage: null };
      finalCalls.push({ request_hash: requestHash, task_ids: [...request.taskIds].sort(), status: 'failed', model: metadata.model, usage: metadata.usage, duration_ms: performance.now() - callStart, error: error instanceof JevError ? error.code : 'jev-error' });
      throw error;
    }
  };
  let finalResult: Awaited<ReturnType<typeof observeChange>> | null = null;
  let finalError: string | null = null;
  let observationError: Parameters<typeof selectTasks>[0]['observationError'];
  try {
    const remaining = Math.max(0, Math.floor(contextRequest.deadline - performance.now()));
    const final = await observeChange({ selection: resolved.selection, taskIds: Object.keys(resolved.selection.tasks).sort(), workingDirectories: resolved.workingDirectories,
      state: { base_sha: commit, head_sha: sha256(item.diff).slice(0, 40), tested_sha: sha256(item.diff).slice(0, 40), changed_paths: changedPaths(item.diff), diff: item.diff }, apiKey, timeoutMs: remaining,
      ...(apiBaseUrl ? { apiBaseUrl } : {}), ...(apiModel ? { apiModel } : {}) }, finalEvaluator);
    finalResult = final; finalError = final.failure ?? null; observationError = final.failure;
  } catch (error) {
    if (error instanceof ObservationSizeError) { finalError = error.code; observationError = error.code; }
    else finalError = error instanceof Error ? error.name : 'evaluation-error';
  }
  const finalDuration = performance.now() - finalStart;
  const finalStatus = finalResult?.observation.status === 'complete' && finalError === null ? 'complete' : 'incomplete';
  const contextStatus = Object.values(context).every(report => report.status === 'complete') ? 'complete' : 'incomplete';
  const metadataStatus = Object.values(resolved.metadata.tasks).every(metadata => !metadata.incomplete) ? 'complete' : 'incomplete';
  if (contextStatus === 'incomplete') reasons.push('context-resolution-incomplete');
  if (metadataStatus === 'incomplete') reasons.push('metadata-incomplete');
  if (finalStatus === 'incomplete') reasons.push(finalError ?? 'final-evaluation-incomplete');
  const selected = selectedFiles(resolved);
  const decisions = finalResult?.decisions ?? {};
  const plan = selectTasks({ selection: resolved.selection, changedPaths: changedPaths(item.diff), decisions, mode: 'enforce', ...(observationError ? { observationError } : {}) });
  const metrics = metricsFor(item, selected, plan);
  const status = contextStatus === 'complete' && metadataStatus === 'complete' && finalStatus === 'complete' ? 'complete' : 'incomplete';
  return { version: 1, case_id: item.id, case_hash: caseHash(item), pass_count: passCount, status, started, finished: new Date().toISOString(),
    timings_ms: { total: performance.now() - totalStart, context: contextDuration, final: finalDuration },
    completeness: { status, context: contextStatus, metadata: metadataStatus, final: finalStatus, reasons }, context, selected_files: selected,
    final: { status: finalStatus, decisions, plan, observation: finalResult?.observation ?? null, calls: finalCalls, usage: finalResult?.usage ?? null, duration_ms: finalDuration, error: finalError }, metrics };
}

function summarize(records: CaseRecord[]) {
  const waves = [...new Set(records.map(record => record.pass_count))].sort((a, b) => a - b).map(passCount => {
    const rows = records.filter(record => record.pass_count === passCount);
    const incomplete = rows.filter(record => record.status === 'incomplete').length;
    return { pass_count: passCount, cases: rows.length, complete: rows.length - incomplete, incomplete,
      metrics: { needed_files: rows.reduce((sum, row) => sum + row.metrics.needed_files, 0), recalled_files: rows.reduce((sum, row) => sum + row.metrics.recalled_files, 0), incorrect_skips: rows.reduce((sum, row) => sum + row.metrics.incorrect_skips.length, 0), irrelevant_retained: rows.reduce((sum, row) => sum + row.metrics.irrelevant_retained.length, 0) } };
  });
  return { version: 1, cases: [...new Set(records.map(record => record.case_id))].sort(), waves, interpretation: 'File recall and final incorrect skips are reported. Offline judgments are fixture-wiring signals only, never model-quality measurements. No model score or CI savings is calculated. An unavailable or failed stage remains incomplete.' };
}

async function writeJson(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }

async function run(mode: 'offline' | 'live', output: string, apiKey: string, apiBaseUrl?: string, apiModel?: string): Promise<void> {
  const directory = resolve(output);
  await mkdir(directory);
  const cases = syntheticCases();
  const created = new Date().toISOString();
  const manifest = { version: 1, mode, created, updated: created, offline_evaluator: mode === 'offline' ? 'fixture-wiring-only' : null, pass_counts: [1, 2, 3], cases: cases.map(item => ({ id: item.id, case_hash: caseHash(item) })), records: [] as string[] };
  await mkdir(`${directory}/records`); await writeJson(`${directory}/manifest.json`, manifest);
  const records: CaseRecord[] = [];
  let index = 0;
  for (const item of cases) for (const passCount of [1, 2, 3] as const) {
    const record = await evaluateCase(item, passCount, mode, apiKey, apiBaseUrl, apiModel);
    const name = `records/${String(index).padStart(2, '0')}-${item.id}-${passCount}.json`;
    await writeJson(`${directory}/${name}`, record); manifest.records.push(name); manifest.updated = new Date().toISOString(); await writeJson(`${directory}/manifest.json`, manifest);
    records.push(record); index += 1;
    process.stderr.write(`[${index}/${cases.length * 3}] ${item.id} wave=${passCount} status=${record.status} recall=${record.metrics.recalled_files}/${record.metrics.needed_files} incorrect_skips=${record.metrics.incorrect_skips.length}\n`);
  }
  await writeJson(`${directory}/summary.json`, summarize(records));
  await writeJson(`${directory}/comparison.json`, { version: 1, mode, records: records.map(record => ({ case_id: record.case_id, pass_count: record.pass_count, status: record.status, completeness: record.completeness, metrics: record.metrics })) });
  process.stdout.write(`${JSON.stringify({ mode, output: directory, records: records.length, incomplete: records.filter(record => record.status === 'incomplete').length })}\n`);
}

function argumentsFor(values: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < values.length; index += 1) { const value = values[index]!; if (!value.startsWith('--') || !values[index + 1] || values[index + 1]!.startsWith('--')) throw new Error(`invalid-argument:${value}`); result.set(value.slice(2), values[index + 1]!); index += 1; }
  return result;
}

async function main(): Promise<void> {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode !== 'offline' && mode !== 'live') throw new Error('usage: context-resolution.ts offline|live --output DIRECTORY');
  const args = argumentsFor(rest); const output = args.get('output'); if (!output) throw new Error('context-evaluation-requires-output');
  const key = mode === 'live' ? process.env.JEV_API_KEY || process.env.JEV_KEY_API || process.env.TYPESAFE_API_KEY || '' : 'offline-evaluation-key';
  if (mode === 'live' && !key.trim()) throw new Error('live-requires-api-key');
  await run(mode, output, key, args.get('api-base-url'), args.get('api-model'));
}

const isMain = typeof __filename === 'string' && process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(__filename);
if (isMain) main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'context-evaluation-error'}\n`); process.exitCode = 1; });

export { syntheticCases, evaluateCase, metricsFor, summarize };

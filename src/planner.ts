import { InputError } from './input-error.js';
import { resolveTasks, type ResolveTasksOptions, type ResolveTasksResult } from './metadata.js';
import { externalActionResolver } from './external.js';
import {
  ChangeError, GitRepository,
  type ChangeEntry, type ChangeManifest, type EntryIssueCode, type VerifiedComparison,
} from './changes.js';
import { validateSelection, selectionHash, type SelectionDefinition } from './tasks.js';
import { evaluateJev, resolveJevApi, type JevMetadata, type JevApiOptions } from './jev.js';
import { FALLBACK_REASONS, globalPathReason, preselectTasks, selectTasks, type ForceAllReason, type Mode, type Reason } from './policy.js';
import { validateReport, MAX_REPORT_CHUNKS, type Report } from './report.js';
import {
  analyseChange, ObservationSizeError, PATCH_UNIT_LIMIT_REASON,
  type AnalysisOutcome, type Observation, type PatchDelivery, type PatchStream, type TaskState,
} from './observations.js';
import { resolveContextFiles, type ContextResolutionReport } from './context.js';
import { evaluateChoices } from './jev.js';
import { AnalysisBudget, BudgetError, PATCH_UNIT_BYTES, type BudgetCounters } from './budget.js';
import { RateController } from './concurrency.js';
import { TokenMeter, type WindowReport } from './window.js';

export interface Inputs extends JevApiOptions, SelectionDefinition {
  testedRef?: 'head' | 'merge';
  mode: Mode; githubToken: string; apiKey: string;
  allowExternalContext: boolean; forceAll: boolean; timeoutMs: number;
  /** Ceiling for the sum of patch units actually collected locally. */
  maxCollectedPatchBytes: number;
  /** Ceiling for the sum of complete request JSON sent to Jev. */
  maxAnalysisBytes: number;
  /** Ceiling for dispatched Jev calls, preparation and observation together. */
  maxJevCalls: number;
}
export interface Context {
  eventName: string; repository: string; serverUrl: string; testedSha: string;
  baseSha: string; headSha: string; fork: boolean;
  metadataSha?: string;
}
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

export function eventContext(env: NodeJS.ProcessEnv, event: unknown, testedRef: 'head' | 'merge' = 'merge'): Context {
  const { GITHUB_EVENT_NAME: eventName, GITHUB_REPOSITORY: repository, GITHUB_SHA: testedSha } = env;
  const serverUrl = env.GITHUB_SERVER_URL ?? 'https://github.com';
  const url = new URL(serverUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    !eventName || !repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !sha(testedSha)) throw new Error('invalid-event');
  if (eventName !== 'pull_request') return { eventName, repository, serverUrl: url.origin, testedSha, baseSha: testedSha, headSha: testedSha, fork: false };
  if (!object(event) || !object(event.pull_request)) throw new Error('invalid-event');
  const { base, head } = event.pull_request;
  if (!object(base) || !object(head) || !sha(base.sha) || !sha(head.sha) || !object(base.repo) ||
    typeof base.repo.full_name !== 'string' || base.repo.full_name.toLowerCase() !== repository.toLowerCase()) throw new Error('invalid-event');
  const fork = !object(head.repo) || typeof base.repo.id !== 'number' || typeof head.repo.id !== 'number' || typeof head.repo.full_name !== 'string' ||
    head.repo.full_name.toLowerCase() !== repository.toLowerCase() || head.repo.id !== base.repo.id;
  return { eventName, repository, serverUrl: url.origin, testedSha: testedRef === 'head' ? head.sha : testedSha, baseSha: base.sha, headSha: head.sha, fork };
}

type Repository = Pick<GitRepository, 'fetchCommit' | 'readFile' | 'listFiles' | 'verifyComparison' | 'collectManifest' | 'readPatch' | 'dispose'>;
export interface PlannerDependencies {
  createRepository?: (options: { remoteUrl: string; token?: string }) => Promise<Repository>;
  evaluate?: typeof evaluateJev;
  evaluateContext?: typeof evaluateChoices;
  resolveExternal?: ResolveTasksOptions['resolveExternal'];
}

export function validateInputs(inputs: Inputs): void {
  validateSelection({ model: inputs.model, tasks: inputs.tasks });
  if (!['head', 'merge'].includes(inputs.testedRef ?? 'merge')) throw new InputError('tested-ref');
  if (!['shadow', 'enforce'].includes(inputs.mode)) throw new InputError('mode');
  // 0 means unbounded for every ceiling, including the deadline.
  if (!Number.isSafeInteger(inputs.timeoutMs) || inputs.timeoutMs < 0 || inputs.timeoutMs > 2_147_483_647) throw new InputError('timeout-ms');
  if (!Number.isSafeInteger(inputs.maxCollectedPatchBytes) || inputs.maxCollectedPatchBytes < 0) throw new InputError('max-collected-patch-bytes');
  if (!Number.isSafeInteger(inputs.maxAnalysisBytes) || inputs.maxAnalysisBytes < 0) throw new InputError('max-analysis-bytes');
  if (!Number.isSafeInteger(inputs.maxJevCalls) || inputs.maxJevCalls < 0) throw new InputError('max-jev-calls');
  if (typeof inputs.allowExternalContext !== 'boolean') throw new InputError('allow-external-context');
  if (typeof inputs.forceAll !== 'boolean') throw new InputError('force-all');
  resolveJevApi(inputs);
}

/** Entry-level failures mapped to the vocabulary the policy already reports. */
const ISSUE_REASONS: Record<EntryIssueCode, Reason> = {
  submodule: 'submodule-change',
  binary: 'binary-change',
  'too-large': 'diff-too-large',
  unrepresentable: 'unrepresentable-change',
  'git-read-failed': 'git-read-failed',
};
/** Counters for a run that never reached the analysis stage. */
const EMPTY_COUNTERS: BudgetCounters = {
  manifest_entries: null, patches_requested: 0, patches_read: 0,
  patch_bytes_read: 0, patch_bytes_delivered: 0,
  preparation_calls: 0, preparation_bytes: 0, observation_calls: 0, observation_bytes: 0,
  jev_calls: 0, analysis_bytes: 0, attempts: 0, limits_reached: [],
};

/**
 * Entries per read, before anything has been measured.
 *
 * A fixed batch size forced at least one call per sixteen changes however large
 * the window was, which capped the benefit of sizing requests properly. The
 * packer below grows the batch toward the window once real patch sizes are
 * known, so the call count follows total bytes rather than file count.
 */
const INITIAL_UNIT_ENTRIES = 16;
/** Pathspec ceiling of a single read. */
const MAX_UNIT_ENTRIES = 256;

/**
 * Pull patch text one bounded unit at a time.
 *
 * Nothing is collected in advance: a unit is read only when the scheduler asks
 * for it, which is only while some task is still open.
 *
 * A unit that exceeds its allowance is split straight into single entries
 * rather than halved. Every attempt is charged, so halving would bill the
 * oversized file once per level — about five times the per-unit cap for a
 * sixteen-entry unit, which on the default budget exhausts the whole allowance
 * before the file is even isolated and leaves nothing for its neighbours.
 * Splitting once bounds the waste to two attempts: the batch, then the single
 * entry that genuinely does not fit. That entry is reported as an issue rather
 * than delivered as a truncated prefix.
 */
function patchStream(
  repository: Repository,
  comparison: VerifiedComparison,
  entries: readonly ChangeEntry[],
  budget: AnalysisBudget,
  meter: TokenMeter,
): PatchStream {
  const queue = [...entries];
  // Forced splits and oversized reads push work back to the front.
  const pending: ChangeEntry[][] = [];
  let perUnit = INITIAL_UNIT_ENTRIES;
  let bytesPerEntry = 0;
  const take = (): ChangeEntry[] => {
    if (pending.length) return pending.shift()!;
    // Aim a unit at what one request can carry, using the largest per-entry
    // size seen so far so a heavy file cannot be underestimated twice.
    const target = Math.min(meter.stateAndQuestionBytes(), PATCH_UNIT_BYTES);
    const sized = bytesPerEntry > 0 ? Math.floor(target / bytesPerEntry) : perUnit;
    perUnit = Math.max(1, Math.min(MAX_UNIT_ENTRIES, sized, perUnit * 2));
    return queue.splice(0, perUnit);
  };
  return {
    async next(): Promise<PatchDelivery | null> {
      while (pending.length || queue.length) {
        const unit = take();
        if (!unit.length) continue;
        const changeIds = unit.map(entry => entry.id);
        // `patchUnitAllowance` registers the ceiling itself when it is reached.
        const allowance = budget.patchUnitAllowance();
        if (allowance <= 0) return { changeIds, paths: [], diff: '', issue: PATCH_UNIT_LIMIT_REASON };
        // An expired deadline must not start another Git command.
        if (budget.expired()) return { changeIds, paths: [], diff: '', issue: PATCH_UNIT_LIMIT_REASON };
        budget.notePatchRequested();
        const result = await repository.readPatch(comparison, unit, {
          maxUnitBytes: Math.min(allowance, PATCH_UNIT_BYTES),
          timeoutMs: budget.remainingMs(),
        });
        // Charge the work before judging the outcome: a rejected attempt still
        // made Git produce bytes, and a retry must not read them for free.
        budget.chargeRead(result.bytesRead);
        if (result.issue === 'too-large') {
          budget.noteLimit('patch-unit-bytes');
          if (unit.length > 1) {
            // Straight to singletons: halving would bill the cap once per level.
            perUnit = Math.max(1, Math.floor(perUnit / 2));
            pending.unshift(...unit.map(entry => [entry]));
            continue;
          }
        }
        if (result.issue !== null) {
          // A read the deadline cut short is a time stop, not a broken
          // repository: blaming Git here would hide the budget that ran out.
          if (result.issue === 'git-read-failed' && budget.expired()) {
            return { changeIds, paths: result.paths, diff: '', issue: PATCH_UNIT_LIMIT_REASON };
          }
          return { changeIds, paths: result.paths, diff: '', issue: ISSUE_REASONS[result.issue] };
        }
        bytesPerEntry = Math.max(bytesPerEntry, Math.ceil(result.bytes / unit.length));
        try { budget.spendPatchBytes(result.bytes); }
        catch (error) {
          if (!(error instanceof BudgetError)) throw error;
          return { changeIds, paths: result.paths, diff: '', issue: PATCH_UNIT_LIMIT_REASON };
        }
        return { changeIds, paths: result.paths, diff: result.diff, issue: null };
      }
      return null;
    },
  };
}

/**
 * Tasks still worth analysing.
 *
 * Both metadata resolution and context preparation can settle a task by making
 * it mandatory when its evidence is unusable. `enforce` therefore re-filters
 * after each of those steps. `shadow` keeps every task so evaluation campaigns
 * still see a proposal.
 */
function stillOpen(taskIds: readonly string[], resolved: ResolveTasksResult, mode: Mode): string[] {
  if (mode === 'shadow') return [...taskIds];
  return taskIds.filter(id => !resolved.metadata.tasks[id]?.incomplete && resolved.selection.tasks[id]?.always !== true);
}

/** Raised when preparation settled every remaining task. Never an error. */
class NothingLeftToAnalyse extends Error {}

/** Keep only the tasks worth resolving; the rest never reach a file read. */
function restrict(configured: SelectionDefinition, taskIds: readonly string[]): SelectionDefinition {
  const keep = new Set(taskIds);
  return { model: configured.model, tasks: Object.fromEntries(Object.entries(configured.tasks).filter(([id]) => keep.has(id))) };
}

function plainSelection(inputs: Inputs, taskIds?: readonly string[]): ResolveTasksResult['selection'] {
  const keep = taskIds ? new Set(taskIds) : null;
  return { model: inputs.model,
    tasks: Object.fromEntries(Object.entries(inputs.tasks).filter(([id]) => !keep || keep.has(id)).map(([id, task]) => [id, {
      ...(task.always === undefined ? {} : { always: task.always }),
      ...(task.force_paths === undefined ? {} : { force_paths: task.force_paths }),
      evidence: { description: task.description },
    }])) };
}

export async function planChange(inputs: Inputs, context: Context, dependencies: PlannerDependencies = {}) {
  validateInputs(inputs);
  if (inputs.testedRef === 'head' && context.eventName === 'pull_request') context = { ...context, testedSha: context.headSha };
  const configured: SelectionDefinition = { model: inputs.model, tasks: inputs.tasks };
  const api = resolveJevApi(inputs);
  const started = performance.now();
  // `timeout-ms` keeps its historical meaning: the shared deadline for context
  // preparation and evaluation. It therefore starts once the comparison is
  // verified and the inventory is built, so a slow fetch cannot silently eat
  // the analysis allowance. Git commands keep their own separate timeouts.
  let budget: AnalysisBudget | undefined;
  const metadataSha = context.metadataSha ?? context.baseSha;
  let forced: ForceAllReason | undefined;
  if (context.eventName !== 'pull_request') forced = { status: 'bypassed', code: 'non-pull-request' };
  else if (inputs.forceAll) forced = { status: 'bypassed', code: 'force-all' };
  else if (context.fork) forced = { status: 'bypassed', code: 'fork' };
  else if (!inputs.apiKey.trim()) forced = { status: 'bypassed', code: 'missing-api-key' };
  else if (!inputs.allowExternalContext) forced = { status: 'bypassed', code: 'external-context-disabled' };
  // Bypasses need only validated task definitions: no project files or metadata reads.
  let resolved: ResolveTasksResult = {
    selection: plainSelection(inputs),
    metadata: { repository: context.repository, commit: metadataSha, tasks: {} }, workingDirectories: [],
  };
  let repository: Repository | undefined;
  try {
    let manifest: ChangeManifest | undefined;
    let analysisTaskIds: string[] = [];
    if (!forced && Object.keys(inputs.tasks).length) {
      try {
        repository = await (dependencies.createRepository ?? GitRepository.create)({
          remoteUrl: `${context.serverUrl}/${context.repository}.git`, token: inputs.githubToken,
        });
        await repository.fetchCommit(context.baseSha);
        const comparison = await repository.verifyComparison({ baseSha: context.baseSha, headSha: context.headSha,
          testedSha: context.testedSha, testedRef: inputs.testedRef ?? 'merge' });
        // Names, modes and object ids only. No numstat, no blob, no patch.
        manifest = await repository.collectManifest(comparison);
        budget = new AnalysisBudget({
          maxCollectedPatchBytes: inputs.maxCollectedPatchBytes,
          maxAnalysisBytes: inputs.maxAnalysisBytes,
          maxJevCalls: inputs.maxJevCalls,
          deadline: inputs.timeoutMs === 0 ? Number.POSITIVE_INFINITY : performance.now() + inputs.timeoutMs,
        });
        budget.noteManifest(manifest.entries.length);
        forced = globalPathReason(manifest.changedPaths);
        // A partial inventory can never justify a new exclusion.
        if (!manifest.complete) forced ??= { status: 'fallback', code: 'manifest-incomplete' };
      } catch (error) {
        if (!(error instanceof ChangeError)) throw error;
        forced = (error.changedPaths ? globalPathReason(error.changedPaths) : undefined)
          ?? { status: 'fallback', code: error.code };
      }
      if (manifest && repository) {
        // The deterministic rules run before a single byte of content is read.
        const preselection = preselectTasks(plainSelection(inputs), manifest.changedPaths);
        // `enforce` never spends anything on a task whose execution is already
        // settled, nor anything at all once a global protection applies.
        // `shadow` keeps observing every task so evaluation campaigns still see
        // a proposal; the bypasses that precede repository access stay
        // unaffected, since they never reach this point at all.
        analysisTaskIds = inputs.mode === 'shadow'
          ? [...preselection.required, ...preselection.candidates].sort()
          : forced ? [] : preselection.candidates;
        if (analysisTaskIds.length) {
          let metadataAvailable = true;
          const scoped = restrict(configured, analysisTaskIds);
          if (metadataSha !== context.baseSha && Object.values(scoped.tasks).some(task => task.jobs?.length || task.context_files?.length || task.resolve_context_files === true)) {
            try { await repository.fetchCommit(metadataSha); }
            catch (error) {
              if (!(error instanceof ChangeError)) throw error;
              metadataAvailable = false;
            }
          }
          const activeRepository = repository;
          const scopedResolution = await resolveTasks(scoped, {
            repository: context.repository, commit: metadataSha,
            readFile: (commit, path) => {
              if (!metadataAvailable) throw new ChangeError('git-fetch-failed');
              return activeRepository.readFile(commit, path);
            },
            resolveExternal: dependencies.resolveExternal ?? externalActionResolver(context.serverUrl, inputs.githubToken),
          });
          resolved = {
            ...scopedResolution,
            // Unanalysed tasks keep their plain definition: they are already
            // required, so nothing was read on their behalf.
            selection: { model: scopedResolution.selection.model,
              tasks: { ...plainSelection(inputs).tasks, ...scopedResolution.selection.tasks } },
          };
          // Resolving metadata can itself settle a task: unusable evidence makes
          // it mandatory. Asking Jev about it would spend budget on a decision
          // that can no longer change, and would record an analysis state that
          // contradicts the effective plan.
          analysisTaskIds = stillOpen(analysisTaskIds, resolved, inputs.mode);
        }
      }
    }
    const selection = resolved.selection;
    const requestedModel = api.model ?? selection.model;
    const collectionMs = performance.now() - started;
    let decisions: Record<string, boolean | null> | undefined;
    let coverage: Record<string, boolean> | undefined;
    let taskErrors: Record<string, Reason> | undefined;
    let taskStates: Record<string, TaskState> = {};
    let observationError: Reason | undefined;
    let metadata: JevMetadata = { model: null, usage: null };
    let jevMs: number | null = null;
    let observation: Observation | null = null;
    let changesRead = 0;
    let meterReport: WindowReport | null = null;
    let contextResolution: ContextResolutionReport = {};
    if (manifest && repository && budget && analysisTaskIds.length) {
      const activeBudget = budget;
      // One controller for preparation and observation together: a burst in one
      // must not cause rate limiting the other pays for.
      const rate = new RateController();
      const meter = new TokenMeter();
      meterReport = meter.report;
      const callStarted = performance.now();
      try {
        contextResolution = await resolveContextFiles({ configured: restrict(configured, analysisTaskIds), resolved,
          repository, commit: metadataSha, apiKey: inputs.apiKey, deadline: activeBudget.limits.deadline, budget: activeBudget, rate,
          apiBaseUrl: api.baseURL, apiModel: requestedModel }, dependencies.evaluateContext ?? evaluateChoices);
        // Preparation can settle a task too: an incomplete context makes it
        // mandatory. Drop it before a single patch byte is collected.
        analysisTaskIds = stillOpen(analysisTaskIds, resolved, inputs.mode);
        if (!analysisTaskIds.length) throw new NothingLeftToAnalyse();
        const outcome: AnalysisOutcome = await analyseChange({
          selection, taskIds: analysisTaskIds, workingDirectories: resolved.workingDirectories,
          changeIds: manifest.entries.map(entry => entry.id),
          patches: patchStream(repository, manifest.comparison, manifest.entries, activeBudget, meter),
          budget: activeBudget, rate, meter, apiBaseUrl: api.baseURL, apiModel: requestedModel, apiKey: inputs.apiKey,
          stopWhenSettled: inputs.mode !== 'shadow',
          state: { base_sha: manifest.comparison.diffBaseSha, head_sha: context.headSha, tested_sha: context.testedSha },
        }, dependencies.evaluate ?? evaluateJev);
        observation = outcome.observation;
        decisions = outcome.decisions;
        coverage = outcome.coverage;
        taskErrors = outcome.taskErrors;
        taskStates = outcome.states;
        changesRead = outcome.changesRead;
        meterReport = meter.report;
        metadata = outcome;
        observationError = outcome.failure;
      } catch (error) {
        // Every remaining task became mandatory during preparation: stopping is
        // the correct outcome, not a failure.
        if (error instanceof NothingLeftToAnalyse) { /* Nothing left to observe. */ }
        else if (error instanceof ObservationSizeError) {
          observationError = error.code;
          forced ??= { status: 'fallback', code: error.code };
        } else throw error;
      } finally {
        jevMs = performance.now() - callStarted;
        const calls = Object.values(contextResolution).flatMap(job => job.passes.flatMap(pass => pass.calls));
        const usages = [metadata.usage, ...calls.map(call => call.usage)].filter(value => value !== null);
        metadata.usage = usages.length ? usages.reduce((total, usage) => ({ input_tokens: total.input_tokens + usage.input_tokens,
          output_tokens: total.output_tokens + usage.output_tokens }), { input_tokens: 0, output_tokens: 0 }) : null;
        metadata.model ??= calls.find(call => call.model !== null)?.model ?? null;
      }
    }
    const plan = selectTasks({ selection, changedPaths: manifest?.changedPaths ?? [], ...(decisions ? { decisions } : {}),
      ...(coverage ? { coverage } : {}), ...(taskErrors ? { taskErrors } : {}),
      ...(observationError ? { observationError } : {}), mode: inputs.mode, ...(forced ? { forceAllReason: forced } : {}) });
    for (const [id, info] of Object.entries(resolved.metadata.tasks)) {
      if (!info.incomplete) continue;
      if (!configured.tasks[id]?.always) plan.tasks[id]!.reasons = plan.tasks[id]!.reasons.filter(reason => reason !== 'always');
      const contextIncomplete = info.missing.some(item => item.startsWith('context-resolution:'));
      plan.tasks[id]!.reasons.push(contextIncomplete ? 'context-resolution-incomplete' : 'metadata-unavailable');
      // Unusable metadata retains a task for want of evidence just as an
      // incomplete context does. Both are degraded outcomes, so both report
      // `fallback`; leaving one as `planned` would announce a scope of `none`
      // while a task was in fact being kept.
      if (plan.status === 'planned') plan.status = 'fallback';
    }
    if (observation?.strategy === 'chunked-diff') {
      for (const id of analysisTaskIds) plan.tasks[id]!.reasons.push('chunked-observation');
    }
    if (observation && plan.status === 'bypassed') {
      for (const id of analysisTaskIds) plan.tasks[id]!.reasons.push('observation-only');
    }
    const counters: BudgetCounters = budget?.counters ?? EMPTY_COUNTERS;
    // A partial fallback names the tasks kept for missing evidence, read from
    // their explicit reasons. `proposed_run` cannot serve here: a task made
    // mandatory by unusable metadata still carries a proposal of true, so it
    // would disappear from a fallback it is precisely the cause of.
    const retained = Object.keys(plan.tasks)
      .filter(id => plan.tasks[id]!.reasons.some(reason => FALLBACK_REASONS.has(reason))).sort();
    // Every task gets a state, including those settled before any analysis, so
    // the registry never contradicts the plan it accompanies.
    const states: Record<string, TaskState> = Object.fromEntries(Object.keys(plan.tasks).sort().map(id => [id,
      taskStates[id] ?? (retained.includes(id) ? 'fallback-run' : plan.tasks[id]!.run ? 'settled-run' : 'settled-skip')]));
    const report: Report = {
      version: 8, tested_ref: inputs.testedRef ?? 'merge', context_resolution: contextResolution,
      diff_base_sha: manifest?.comparison.diffBaseSha ?? (inputs.testedRef === 'head' ? null : context.baseSha),
      job_metadata: resolved.metadata.tasks, observation_error: observationError ?? null,
      metadata_sha: metadataSha, base_sha: context.baseSha, head_sha: context.headSha, tested_sha: context.testedSha,
      selection_hash: selectionHash(configured),
      // No global diff is built, so the historical whole-diff fields stay null
      // rather than being filled by a read nothing else needed.
      diff_hash: null, diff_bytes: null,
      changed_path_count: manifest?.changedPaths.length ?? null,
      manifest: {
        complete: manifest?.complete ?? false,
        hash: manifest?.manifestHash ?? null,
        change_count: manifest?.entries.length ?? null,
      },
      analysis: {
        ...counters,
        changes_read: changesRead,
        changes_total: manifest?.entries.length ?? null,
        // The counts above are measured; this ratio is inferred, so it is
        // published rather than folded silently into the byte figures.
        bytes_per_token: meterReport,
        analysed_tasks: [...analysisTaskIds].sort(),
        required_without_analysis: Object.keys(plan.tasks).filter(id => !analysisTaskIds.includes(id)).sort(),
        task_states: states,
        coverage: coverage ?? {},
        fallback_scope: plan.status !== 'fallback' ? 'none' : forced ? 'global' : 'partial',
        fallback_tasks: plan.status !== 'fallback' ? [] : forced ? Object.keys(plan.tasks).sort() : retained,

      },
      mode: plan.mode, status: plan.status, model: { requested: requestedModel, expected: selection.model, returned: metadata.model },
      durations_ms: { collection: collectionMs, jev: jevMs, total: performance.now() - started },
      usage: metadata.usage, tasks: plan.tasks,
      observation: observation && observation.chunks.length > MAX_REPORT_CHUNKS
        // Keep the report bounded: the counters above still describe the whole run.
        ? { ...observation, chunks: observation.chunks.slice(0, MAX_REPORT_CHUNKS) }
        : observation,
    };
    validateReport(report);
    return { plan, report };
  } finally { await repository?.dispose(); }
}

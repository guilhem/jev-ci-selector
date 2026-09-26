import { InputError } from './input-error.js';
import {
  ChangeError, GitRepository,
  type ChangeEntry, type ChangeManifest, type EntryIssueCode, type VerifiedComparison,
} from './changes.js';
import { validateSelection, selectionHash, type SelectionDefinition } from './tasks.js';
import { evaluateJev, resolveJevApi, type JevMetadata, type JevApiOptions } from './jev.js';
import { FALLBACK_REASONS, selectTasks, type SafetyReason, type Reason } from './policy.js';
import { validateReport, MAX_REPORT_CHUNKS, type Report } from './report.js';
import {
  analyseChange, ObservationSizeError, PATCH_UNIT_LIMIT_REASON,
  type AnalysisOutcome, type Observation, type PatchDelivery, type PatchStream, type TaskState,
} from './observations.js';
import { evaluateChoices } from './jev.js';
import { AnalysisBudget, BudgetError, PATCH_UNIT_BYTES, type BudgetCounters } from './budget.js';
import { RateController } from './concurrency.js';
import { TokenMeter, type WindowReport } from './window.js';

export interface Inputs extends JevApiOptions, SelectionDefinition {
  testedRef?: 'head' | 'merge';
  githubToken: string; apiKey: string;
  allowExternalContext: boolean; timeoutMs: number;
  /** Ceiling for the sum of patch units actually collected locally. */
  maxCollectedPatchBytes: number;
  /** Ceiling for the sum of complete request JSON sent to Jev. */
  maxAnalysisBytes: number;
  /** Ceiling for dispatched Jev calls, inventory and diff analysis together. */
  maxJevCalls: number;
}
export interface Context {
  eventName: string; repository: string; serverUrl: string; testedSha: string;
  baseSha: string; headSha: string; fork: boolean;
}
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

export function eventContext(env: NodeJS.ProcessEnv, event: unknown, testedRef: 'head' | 'merge' = 'merge'): Context {
  const { GITHUB_EVENT_NAME: eventName, GITHUB_REPOSITORY: repository, GITHUB_SHA: testedSha } = env;
  const serverUrl = env.GITHUB_SERVER_URL ?? 'https://github.com';
  const url = new URL(serverUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    !eventName || !repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !sha(testedSha)) throw new Error('invalid-event');
  if (eventName === 'push' && object(event) && sha(event.before) && sha(event.after)) {
    return { eventName, repository, serverUrl: url.origin, testedSha, baseSha: event.before, headSha: event.after, fork: false };
  }
  // Events without a usable range retain an incoherent comparison for the
  // planner's safety fallback; they must never masquerade as an empty diff.
  if (eventName !== 'pull_request') return { eventName, repository, serverUrl: url.origin, testedSha, baseSha: testedSha, headSha: testedSha, fork: false };
  if (!object(event) || !object(event.pull_request)) throw new Error('invalid-event');
  const { base, head } = event.pull_request;
  if (!object(base) || !object(head) || !sha(base.sha) || !sha(head.sha) || !object(base.repo) ||
    typeof base.repo.full_name !== 'string' || base.repo.full_name.toLowerCase() !== repository.toLowerCase()) throw new Error('invalid-event');
  const fork = !object(head.repo) || typeof base.repo.id !== 'number' || typeof head.repo.id !== 'number' || typeof head.repo.full_name !== 'string' ||
    head.repo.full_name.toLowerCase() !== repository.toLowerCase() || head.repo.id !== base.repo.id;
  return { eventName, repository, serverUrl: url.origin, testedSha: testedRef === 'head' ? head.sha : testedSha, baseSha: base.sha, headSha: head.sha, fork };
}

type Repository = Pick<GitRepository, 'fetchCommit' | 'verifyComparison' | 'collectManifest' | 'readPatch' | 'dispose'>;
export interface PlannerDependencies {
  createRepository?: (options: { remoteUrl: string; token?: string }) => Promise<Repository>;
  evaluate?: typeof evaluateJev;
  evaluateInventory?: typeof evaluateChoices;
}

export function validateInputs(inputs: Inputs): void {
  validateSelection({ model: inputs.model, tasks: inputs.tasks });
  if (!['head', 'merge'].includes(inputs.testedRef ?? 'merge')) throw new InputError('tested-ref');
  if (Object.hasOwn(inputs, 'mode')) throw new InputError('mode');
  if (Object.hasOwn(inputs, 'forceAll')) throw new InputError('force-all');
  // 0 means unbounded for every ceiling, including the deadline.
  if (!Number.isSafeInteger(inputs.timeoutMs) || inputs.timeoutMs < 0 || inputs.timeoutMs > 2_147_483_647) throw new InputError('timeout-ms');
  if (!Number.isSafeInteger(inputs.maxCollectedPatchBytes) || inputs.maxCollectedPatchBytes < 0) throw new InputError('max-collected-patch-bytes');
  if (!Number.isSafeInteger(inputs.maxAnalysisBytes) || inputs.maxAnalysisBytes < 0) throw new InputError('max-analysis-bytes');
  if (!Number.isSafeInteger(inputs.maxJevCalls) || inputs.maxJevCalls < 0) throw new InputError('max-jev-calls');
  if (typeof inputs.allowExternalContext !== 'boolean') throw new InputError('allow-external-context');
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

export async function planChange(inputs: Inputs, context: Context, dependencies: PlannerDependencies = {}) {
  validateInputs(inputs);
  if (inputs.testedRef === 'head' && context.eventName === 'pull_request') context = { ...context, testedSha: context.headSha };
  const testedRef = context.eventName === 'push' ? 'push' : inputs.testedRef ?? 'merge';
  const selection: SelectionDefinition = { model: inputs.model, tasks: inputs.tasks };
  const api = resolveJevApi(inputs);
  const started = performance.now();
  // The shared analysis deadline starts once the comparison is
  // verified and the inventory is built, so a slow fetch cannot silently eat
  // the analysis allowance. Git commands keep their own separate timeouts.
  let budget: AnalysisBudget | undefined;
  let forced: SafetyReason | undefined;
  if (context.fork) forced = { status: 'bypassed', code: 'fork' };
  else if (!inputs.apiKey.trim()) forced = { status: 'bypassed', code: 'missing-api-key' };
  else if (!inputs.allowExternalContext) forced = { status: 'bypassed', code: 'external-context-disabled' };
  else if (context.baseSha === context.headSha || [context.baseSha, context.headSha].includes('0'.repeat(40))) {
    forced = { status: 'fallback', code: 'sha-incoherent' };
  }
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
          testedSha: context.testedSha, testedRef });
        // Names, modes and object ids only. No numstat, no blob, no patch.
        manifest = await repository.collectManifest(comparison);
        budget = new AnalysisBudget({
          maxCollectedPatchBytes: inputs.maxCollectedPatchBytes,
          maxAnalysisBytes: inputs.maxAnalysisBytes,
          maxJevCalls: inputs.maxJevCalls,
          deadline: inputs.timeoutMs === 0 ? Number.POSITIVE_INFINITY : performance.now() + inputs.timeoutMs,
        });
        budget.noteManifest(manifest.entries.length);
        // A partial inventory can never justify a new exclusion.
        if (!manifest.complete) forced ??= { status: 'fallback', code: 'manifest-incomplete' };
      } catch (error) {
        if (!(error instanceof ChangeError)) throw error;
        forced = { status: 'fallback', code: error.code };
      }
      if (manifest && repository && !forced) analysisTaskIds = Object.keys(selection.tasks).sort();
    }
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
    if (manifest && repository && budget && analysisTaskIds.length) {
      const activeBudget = budget;
      // One controller for inventory and diff analysis together: a burst in one
      // must not cause rate limiting the other pays for.
      const rate = new RateController();
      const meter = new TokenMeter();
      meterReport = meter.report;
      const callStarted = performance.now();
      try {
        const outcome: AnalysisOutcome = await analyseChange({
          selection, taskIds: analysisTaskIds,
          changeIds: manifest.entries.map(entry => entry.id),
          // Names, statuses and modes only. A task the paths alone already
          // implicate is settled before any content is read.
          inventory: manifest.entries.map(entry => ({ id: entry.id, status: entry.status,
            oldPath: entry.oldPath, newPath: entry.newPath, oldMode: entry.oldMode, newMode: entry.newMode })),
          evaluateInventory: dependencies.evaluateInventory ?? evaluateChoices,
          patches: patchStream(repository, manifest.comparison, manifest.entries, activeBudget, meter),
          budget: activeBudget, rate, meter, apiBaseUrl: api.baseURL, apiModel: requestedModel, apiKey: inputs.apiKey,
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
        if (error instanceof ObservationSizeError) {
          observationError = error.code;
          forced ??= { status: 'fallback', code: error.code };
        } else throw error;
      } finally {
        jevMs = performance.now() - callStarted;
      }
    }
    const plan = selectTasks({ selection, ...(decisions ? { decisions } : {}),
      ...(coverage ? { coverage } : {}), ...(taskErrors ? { taskErrors } : {}),
      ...(observationError ? { observationError } : {}), ...(forced ? { safetyReason: forced } : {}) });
    if (observation?.strategy === 'chunked-diff') {
      for (const id of analysisTaskIds) plan.tasks[id]!.reasons.push('chunked-observation');
    }
    const counters: BudgetCounters = budget?.counters ?? EMPTY_COUNTERS;
    // A partial fallback names tasks kept because their evidence was incomplete.
    const retained = Object.keys(plan.tasks)
      .filter(id => plan.tasks[id]!.reasons.some(reason => FALLBACK_REASONS.has(reason))).sort();
    // Every task gets a state, including those settled before any analysis, so
    // the registry never contradicts the plan it accompanies.
    const states: Record<string, TaskState> = Object.fromEntries(Object.keys(plan.tasks).sort().map(id => [id,
      taskStates[id] ?? (retained.includes(id) ? 'fallback-run' : plan.tasks[id]!.run ? 'settled-run' : 'settled-skip')]));
    const report: Report = {
      version: 10, tested_ref: testedRef,
      diff_base_sha: manifest?.comparison.diffBaseSha ?? null,
      observation_error: observationError ?? null,
      base_sha: context.baseSha, head_sha: context.headSha, tested_sha: context.testedSha,
      selection_hash: selectionHash(selection),
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
      status: plan.status, model: { requested: requestedModel, expected: selection.model, returned: metadata.model },
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

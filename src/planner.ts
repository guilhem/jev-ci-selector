import { InputError } from './input-error.js';
import { resolveTasks, type ResolveTasksOptions, type ResolveTasksResult } from './metadata.js';
import { externalActionResolver } from './external.js';
import { ChangeError, GitRepository, type ChangeSet } from './changes.js';
import { validateSelection, selectionHash, type SelectionDefinition } from './tasks.js';
import { evaluateJev, resolveJevApi, type JevMetadata, type JevApiOptions } from './jev.js';
import { globalPathReason, selectTasks, type ForceAllReason, type Mode } from './policy.js';
import { validateReport, type Report } from './report.js';
import { observeChange, ObservationSizeError, type Observation } from './observations.js';

export interface Inputs extends JevApiOptions, SelectionDefinition {
  testedRef?: 'head' | 'merge';
  mode: Mode; githubToken: string; apiKey: string;
  allowExternalContext: boolean; forceAll: boolean; timeoutMs: number; maxDiffBytes: number;
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

type Repository = Pick<GitRepository, 'fetchCommit' | 'readFile' | 'collect' | 'dispose'>;
export interface PlannerDependencies {
  createRepository?: (options: { remoteUrl: string; token?: string }) => Promise<Repository>;
  evaluate?: typeof evaluateJev;
  resolveExternal?: ResolveTasksOptions['resolveExternal'];
}

export function validateInputs(inputs: Inputs): void {
  validateSelection({ model: inputs.model, skip_below: inputs.skip_below, tasks: inputs.tasks });
  if (!['head', 'merge'].includes(inputs.testedRef ?? 'merge')) throw new InputError('tested-ref');
  if (!['shadow', 'enforce'].includes(inputs.mode)) throw new InputError('mode');
  if (!Number.isSafeInteger(inputs.timeoutMs) || inputs.timeoutMs < 1 || inputs.timeoutMs > 2_147_483_647) throw new InputError('timeout-ms');
  if (!Number.isSafeInteger(inputs.maxDiffBytes) || inputs.maxDiffBytes < 1) throw new InputError('max-diff-bytes');
  if (typeof inputs.allowExternalContext !== 'boolean') throw new InputError('allow-external-context');
  if (typeof inputs.forceAll !== 'boolean') throw new InputError('force-all');
  resolveJevApi(inputs);
}

export async function planChange(inputs: Inputs, context: Context, dependencies: PlannerDependencies = {}) {
  validateInputs(inputs);
  if (inputs.testedRef === 'head' && context.eventName === 'pull_request') context = { ...context, testedSha: context.headSha };
  const configured: SelectionDefinition = { model: inputs.model, skip_below: inputs.skip_below, tasks: inputs.tasks };
  const api = resolveJevApi(inputs);
  const started = performance.now();
  const metadataSha = context.metadataSha ?? context.baseSha;
  let forced: ForceAllReason | undefined;
  if (context.eventName !== 'pull_request') forced = { status: 'bypassed', code: 'non-pull-request' };
  else if (inputs.forceAll) forced = { status: 'bypassed', code: 'force-all' };
  else if (context.fork) forced = { status: 'bypassed', code: 'fork' };
  else if (!inputs.apiKey.trim()) forced = { status: 'bypassed', code: 'missing-api-key' };
  else if (!inputs.allowExternalContext) forced = { status: 'bypassed', code: 'external-context-disabled' };
  // Bypasses need only validated task definitions: no project files or metadata reads.
  let resolved: ResolveTasksResult = {
    selection: { model: inputs.model, skip_below: inputs.skip_below,
      tasks: Object.fromEntries(Object.entries(inputs.tasks).map(([id, task]) => [id, {
        ...(task.always === undefined ? {} : { always: task.always }),
        ...(task.force_paths === undefined ? {} : { force_paths: task.force_paths }),
        evidence: { description: task.description },
      }])) },
    metadata: { repository: context.repository, commit: metadataSha, tasks: {} }, workingDirectories: [],
  };
  let repository: Repository | undefined;
  try {
    let change: ChangeSet | undefined;
    if (!forced && Object.keys(inputs.tasks).length) {
      try {
        repository = await (dependencies.createRepository ?? GitRepository.create)({
          remoteUrl: `${context.serverUrl}/${context.repository}.git`, token: inputs.githubToken,
        });
        await repository.fetchCommit(context.baseSha);
        change = await repository.collect({ baseSha: context.baseSha, headSha: context.headSha,
          testedSha: context.testedSha, testedRef: inputs.testedRef ?? 'merge', maxDiffBytes: inputs.maxDiffBytes });
        forced = globalPathReason(change.changedPaths);
      } catch (error) {
        if (!(error instanceof ChangeError)) throw error;
        forced = (error.changedPaths ? globalPathReason(error.changedPaths) : undefined)
          ?? { status: 'fallback', code: error.code };
      }
      if (change && repository) {
        let metadataAvailable = true;
        if (metadataSha !== context.baseSha && Object.values(inputs.tasks).some(task => task.jobs?.length || task.context_files?.length)) {
          try { await repository.fetchCommit(metadataSha); }
          catch (error) {
            if (!(error instanceof ChangeError)) throw error;
            metadataAvailable = false;
          }
        }
        const activeRepository = repository;
        resolved = await resolveTasks(configured, {
          repository: context.repository, commit: metadataSha,
          readFile: (commit, path) => {
            if (!metadataAvailable) throw new ChangeError('git-fetch-failed');
            return activeRepository.readFile(commit, path);
          },
          resolveExternal: dependencies.resolveExternal ?? externalActionResolver(context.serverUrl, inputs.githubToken),
        });
      }
    }
    const selection = resolved.selection;
    const requestedModel = api.model ?? selection.model;
    const collectionMs = performance.now() - started;
    let decisions: Record<string, boolean | null> | undefined;
    let observationError: import('./policy.js').Reason | undefined;
    let metadata: JevMetadata = { model: null, usage: null };
    let jevMs: number | null = null;
    let observation: Observation | null = null;
    const candidates = Object.keys(selection.tasks).sort();
    // Workflow protection keeps full CI while still allowing an authorized observation.
    if (change && candidates.length) {
      const callStarted = performance.now();
      try {
        const result = await observeChange({ selection, taskIds: candidates, workingDirectories: resolved.workingDirectories,
          apiBaseUrl: api.baseURL, apiModel: requestedModel,
          apiKey: inputs.apiKey, timeoutMs: inputs.timeoutMs,
          state: { base_sha: change.diffBaseSha ?? context.baseSha, head_sha: context.headSha, tested_sha: context.testedSha,
            changed_paths: change.changedPaths, diff: change.diff } }, dependencies.evaluate ?? evaluateJev);
        observation = result.observation;
        decisions = result.decisions;
        metadata = result;
        observationError = result.failure;
      } catch (error) {
        if (!(error instanceof ObservationSizeError)) throw error;
        observationError = error.code;
        forced ??= { status: 'fallback', code: error.code };
      } finally { jevMs = performance.now() - callStarted; }
    }
    const plan = selectTasks({ selection, changedPaths: change?.changedPaths ?? [], ...(decisions ? { decisions } : {}),
      ...(observationError ? { observationError } : {}), mode: inputs.mode, ...(forced ? { forceAllReason: forced } : {}) });
    for (const [id, info] of Object.entries(resolved.metadata.tasks)) {
      if (!info.incomplete) continue;
      if (!configured.tasks[id]?.always) plan.tasks[id]!.reasons = plan.tasks[id]!.reasons.filter(reason => reason !== 'always');
      plan.tasks[id]!.reasons.push('metadata-unavailable');
    }
    if (observation?.strategy === 'chunked-diff') {
      for (const id of candidates) plan.tasks[id]!.reasons.push('chunked-observation');
    }
    if (observation && plan.status === 'bypassed') {
      for (const id of candidates) plan.tasks[id]!.reasons.push('observation-only');
    }
    const report: Report = {
      version: 5, tested_ref: inputs.testedRef ?? 'merge',
      diff_base_sha: change?.diffBaseSha ?? (inputs.testedRef === 'head' ? null : context.baseSha),
      job_metadata: resolved.metadata.tasks, observation_error: observationError ?? null,
      metadata_sha: metadataSha, base_sha: context.baseSha, head_sha: context.headSha, tested_sha: context.testedSha,
      selection_hash: selectionHash(configured), skip_below: selection.skip_below,
      diff_hash: change?.diffHash ?? null, diff_bytes: change?.diffBytes ?? null, changed_path_count: change?.changedPaths.length ?? null,
      mode: plan.mode, status: plan.status, model: { requested: requestedModel, expected: selection.model, returned: metadata.model },
      durations_ms: { collection: collectionMs, jev: jevMs, total: performance.now() - started },
      usage: metadata.usage, tasks: plan.tasks, observation,
    };
    validateReport(report);
    return { plan, report };
  } finally { await repository?.dispose(); }
}

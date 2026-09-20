import { resolveCatalog, type ResolveCatalogOptions } from './metadata.js';
import { externalActionResolver } from './external.js';
import { createHash } from 'node:crypto';
import { ChangeError, GitRepository, type ChangeSet } from './changes.js';
import { ConfigError, parseCatalog, validateConfigPath } from './config.js';
import { evaluateJev, resolveJevApi, type JevMetadata, type JevApiOptions } from './jev.js';
import { globalPathReason, selectTasks, type ForceAllReason, type Mode } from './policy.js';
import { validateReport, type Report } from './report.js';
import { observeChange, ObservationSizeError, type Observation } from './observations.js';

export interface Inputs extends JevApiOptions {
  testedRef?: 'head' | 'merge';
  config: string; mode: Mode; githubToken: string; apiKey: string;
  allowExternalContext: boolean; forceAll: boolean; timeoutMs: number; maxDiffBytes: number;
}
export interface Context {
  eventName: string; repository: string; serverUrl: string; testedSha: string;
  baseSha: string; headSha: string; fork: boolean;
  configSha?: string;
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
  resolveExternal?: ResolveCatalogOptions['resolveExternal'];
}

export async function planChange(inputs: Inputs, context: Context, dependencies: PlannerDependencies = {}) {
  validateConfigPath(inputs.config);
  if (!['head', 'merge'].includes(inputs.testedRef ?? 'merge')) throw new Error('invalid-input');
  if (inputs.testedRef === 'head' && context.eventName === 'pull_request') context = { ...context, testedSha: context.headSha };
  const api = resolveJevApi(inputs);
  if (!['shadow', 'enforce'].includes(inputs.mode) || !Number.isSafeInteger(inputs.timeoutMs) || inputs.timeoutMs < 1 || inputs.timeoutMs > 2_147_483_647 ||
    !Number.isSafeInteger(inputs.maxDiffBytes) || inputs.maxDiffBytes < 1) throw new Error('invalid-input');
  const started = performance.now();
  const repository = await (dependencies.createRepository ?? GitRepository.create)({
    remoteUrl: `${context.serverUrl}/${context.repository}.git`, token: inputs.githubToken,
  });
  try {
    const configSha = context.configSha ?? context.baseSha;
    let configBytes: Buffer;
    try {
      await repository.fetchCommit(configSha);
      configBytes = await repository.readFile(configSha, inputs.config);
    } catch { throw new ConfigError(); }
    let source: string;
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(configBytes); }
    catch { throw new ConfigError(); }
    const configuredCatalog = parseCatalog(source);
    const resolved = await resolveCatalog(configuredCatalog, {
      repository: context.repository, commit: configSha,
      readFile: (commit, file) => repository.readFile(commit, file),
      resolveExternal: dependencies.resolveExternal ?? externalActionResolver(context.serverUrl, inputs.githubToken),
    });
    const catalog = resolved.catalog;
    const requestedModel = api.model ?? catalog.model;
    let forced: ForceAllReason | undefined;
    if (context.eventName !== 'pull_request') forced = { status: 'bypassed', code: 'non-pull-request' };
    else if (inputs.forceAll) forced = { status: 'bypassed', code: 'force-all' };
    else if (context.fork) forced = { status: 'bypassed', code: 'fork' };
    else if (!inputs.apiKey.trim()) forced = { status: 'bypassed', code: 'missing-api-key' };
    else if (!inputs.allowExternalContext) forced = { status: 'bypassed', code: 'external-context-disabled' };
    let change: ChangeSet | undefined;
    if (!forced) {
      try {
        if (configSha !== context.baseSha) await repository.fetchCommit(context.baseSha);
        change = await repository.collect({ baseSha: context.baseSha, headSha: context.headSha,
          testedSha: context.testedSha, testedRef: inputs.testedRef ?? 'merge', maxDiffBytes: inputs.maxDiffBytes });
        forced = globalPathReason(catalog, change.changedPaths, inputs.config);
      } catch (error) {
        if (!(error instanceof ChangeError)) throw error;
        forced = (error.changedPaths ? globalPathReason(catalog, error.changedPaths, inputs.config) : undefined)
          ?? { status: 'fallback', code: error.code };
      }
    }
    const collectionMs = performance.now() - started;
    let decisions: Record<string, boolean | null> | undefined;
    let observationError: import('./policy.js').Reason | undefined;
    let metadata: JevMetadata = { model: null, usage: null };
    let jevMs: number | null = null;
    let observation: Observation | null = null;
    const candidates = Object.keys(catalog.tasks).filter(id => catalog.tasks[id]!.question).sort();
    // Both modes observe the same job questions, independently of path policy.
    // Explicit opt-outs and unsupported Git changes still prevent every API call.
    if (change && candidates.length) {
      const callStarted = performance.now();
      try {
        const result = await observeChange({ catalog, taskIds: candidates, workingDirectories: resolved.workingDirectories,
          apiBaseUrl: api.baseURL, apiModel: requestedModel,
          apiKey: inputs.apiKey, timeoutMs: inputs.timeoutMs,
          state: { base_sha: change.diffBaseSha ?? context.baseSha, head_sha: context.headSha, tested_sha: context.testedSha,
            changed_paths: change.changedPaths, diff: change.diff } }, inputs.mode === 'shadow', dependencies.evaluate ?? evaluateJev);
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
    const plan = selectTasks({ catalog, changedPaths: change?.changedPaths ?? [], ...(decisions ? { decisions } : {}), ...(observationError ? { observationError } : {}),
      mode: inputs.mode, configPath: inputs.config, ...(forced ? { forceAllReason: forced } : {}) });
    for (const [id, info] of Object.entries(resolved.metadata.tasks)) {
      if (!info.incomplete) continue;
      if (!configuredCatalog.tasks[id]?.always) plan.tasks[id]!.reasons = plan.tasks[id]!.reasons.filter(reason => reason !== 'always');
      plan.tasks[id]!.reasons.push('metadata-unavailable');
    }
    if (observation?.strategy === 'chunked-diff') {
      for (const id of candidates) {
        plan.tasks[id]!.probability = null;
        plan.tasks[id]!.reasons.push('chunked-observation');
      }
    }
    if (observation && plan.status === 'bypassed') {
      for (const id of candidates) plan.tasks[id]!.reasons.push('observation-only');
    }
    const report: Report = {
      version: 4, tested_ref: inputs.testedRef ?? 'merge', diff_base_sha: change?.diffBaseSha ?? (inputs.testedRef === 'head' ? null : context.baseSha), job_metadata: resolved.metadata.tasks, observation_error: observationError ?? null, config_sha: configSha, base_sha: context.baseSha, head_sha: context.headSha, tested_sha: context.testedSha,
      catalog_hash: createHash('sha256').update(configBytes).digest('hex'),
      diff_hash: change?.diffHash ?? null, diff_bytes: change?.diffBytes ?? null, changed_path_count: change?.changedPaths.length ?? null,
      mode: plan.mode, status: plan.status, model: { requested: requestedModel, expected: catalog.model, returned: metadata.model },
      durations_ms: { collection: collectionMs, jev: jevMs, total: performance.now() - started },
      usage: metadata.usage, tasks: plan.tasks, observation,
    };
    validateReport(report);
    return { plan, report };
  } finally { await repository.dispose(); }
}

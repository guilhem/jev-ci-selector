import { createHash } from 'node:crypto';
import { ChangeError, GitRepository, type ChangeSet } from './changes.js';
import { ConfigError, parseCatalog, validateConfigPath } from './config.js';
import { evaluateJev, JevError, resolveJevApi, type JevMetadata, type JevApiOptions } from './jev.js';
import { globalPathReason, selectTasks, semanticTaskIds, type ForceAllReason, type Mode } from './policy.js';
import { validateReport, type Report } from './report.js';

export interface Inputs extends JevApiOptions {
  config: string; mode: Mode; githubToken: string; apiKey: string;
  allowExternalContext: boolean; forceAll: boolean; timeoutMs: number; maxDiffBytes: number;
}
export interface Context {
  eventName: string; repository: string; serverUrl: string; testedSha: string;
  baseSha: string; headSha: string; fork: boolean;
}
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

export function eventContext(env: NodeJS.ProcessEnv, event: unknown): Context {
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
  return { eventName, repository, serverUrl: url.origin, testedSha, baseSha: base.sha, headSha: head.sha, fork };
}

type Repository = Pick<GitRepository, 'fetchCommit' | 'readFile' | 'collect' | 'dispose'>;
export interface PlannerDependencies {
  createRepository?: (options: { remoteUrl: string; token?: string }) => Promise<Repository>;
  evaluate?: typeof evaluateJev;
}

export async function planChange(inputs: Inputs, context: Context, dependencies: PlannerDependencies = {}) {
  validateConfigPath(inputs.config);
  const api = resolveJevApi(inputs);
  if (!['shadow', 'enforce'].includes(inputs.mode) || !Number.isSafeInteger(inputs.timeoutMs) || inputs.timeoutMs < 1 || inputs.timeoutMs > 2_147_483_647 ||
    !Number.isSafeInteger(inputs.maxDiffBytes) || inputs.maxDiffBytes < 1) throw new Error('invalid-input');
  const started = performance.now();
  const repository = await (dependencies.createRepository ?? GitRepository.create)({
    remoteUrl: `${context.serverUrl}/${context.repository}.git`, token: inputs.githubToken,
  });
  try {
    let configBytes: Buffer;
    try {
      await repository.fetchCommit(context.baseSha);
      configBytes = await repository.readFile(context.baseSha, inputs.config);
    } catch { throw new ConfigError(); }
    let source: string;
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(configBytes); }
    catch { throw new ConfigError(); }
    const catalog = parseCatalog(source);
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
        change = await repository.collect({ baseSha: context.baseSha, headSha: context.headSha,
          testedSha: context.testedSha, maxDiffBytes: inputs.maxDiffBytes });
        forced = globalPathReason(catalog, change.changedPaths, inputs.config);
      } catch (error) {
        if (!(error instanceof ChangeError)) throw error;
        forced = (error.changedPaths ? globalPathReason(catalog, error.changedPaths, inputs.config) : undefined)
          ?? { status: 'fallback', code: error.code };
      }
    }
    const collectionMs = performance.now() - started;
    let probabilities: Record<string, number> = {};
    let metadata: JevMetadata = { model: null, usage: null };
    let jevMs: number | null = null;
    const candidates = semanticTaskIds(catalog, change?.changedPaths ?? []);
    if (!forced && candidates.length) {
      if (!change) throw new Error('missing-change');
      const callStarted = performance.now();
      try {
        const result = await (dependencies.evaluate ?? evaluateJev)({ catalog, taskIds: candidates,
          apiBaseUrl: api.baseURL, apiModel: requestedModel,
          apiKey: inputs.apiKey, timeoutMs: inputs.timeoutMs,
          state: { base_sha: context.baseSha, head_sha: context.headSha, tested_sha: context.testedSha,
            changed_paths: change.changedPaths, diff: change.diff } });
        probabilities = result.probabilities;
        metadata = result;
      } catch (error) {
        if (!(error instanceof JevError)) throw error;
        forced = { status: 'fallback', code: error.code };
        metadata = error.metadata;
      } finally { jevMs = performance.now() - callStarted; }
    }
    const plan = selectTasks({ catalog, changedPaths: change?.changedPaths ?? [], probabilities,
      mode: inputs.mode, configPath: inputs.config, ...(forced ? { forceAllReason: forced } : {}) });
    const report: Report = {
      version: 2, config_sha: context.baseSha, base_sha: context.baseSha, head_sha: context.headSha, tested_sha: context.testedSha,
      catalog_hash: createHash('sha256').update(configBytes).digest('hex'),
      diff_hash: change?.diffHash ?? null, diff_bytes: change?.diffBytes ?? null, changed_path_count: change?.changedPaths.length ?? null,
      mode: plan.mode, status: plan.status, model: { requested: requestedModel, expected: catalog.model, returned: metadata.model },
      durations_ms: { collection: collectionMs, jev: jevMs, total: performance.now() - started },
      usage: metadata.usage, tasks: plan.tasks,
    };
    validateReport(report);
    return { plan, report };
  } finally { await repository.dispose(); }
}

import { eventContext, type Context } from './planner.js';

/** Resolve an operator-selected PR without checking out or executing its code. */
export async function manualContext(env: NodeJS.ProcessEnv, number: string, mode: string, token: string,
  fetchImpl: typeof fetch = globalThis.fetch): Promise<Context> {
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || mode !== 'shadow' || !/^[1-9][0-9]*$/.test(number) ||
    !Number.isSafeInteger(Number(number))) throw new Error('invalid-manual-request');
  const workflow = eventContext(env, {});
  const api = workflow.serverUrl === 'https://github.com' ? 'https://api.github.com' : `${workflow.serverUrl}/api/v3`;
  const response = await fetchImpl(`${api}/repos/${workflow.repository}/pulls/${number}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('pull-request-unavailable');
  const pull = await response.json() as Record<string, unknown>;
  if (pull.state !== 'open' || typeof pull.merge_commit_sha !== 'string') throw new Error('merge-unavailable');
  const context = eventContext({ ...env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_SHA: pull.merge_commit_sha }, { pull_request: pull });
  // The manual operator selected this workflow revision. Its catalog is trusted;
  // the target PR still supplies only immutable Git data, never executable code.
  return { ...context, configSha: workflow.testedSha };
}

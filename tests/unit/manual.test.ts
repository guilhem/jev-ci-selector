import assert from 'node:assert/strict';
import { test } from 'node:test';
import { manualContext } from '../../src/manual.js';

const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const mergeSha = 'c'.repeat(40);
const workflowSha = 'd'.repeat(40);
const env = {
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REPOSITORY: 'acme/example',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_SHA: workflowSha,
};

function pullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: 'open',
    merge_commit_sha: mergeSha,
    base: { sha: baseSha, repo: { full_name: 'acme/example', id: 7 } },
    head: { sha: headSha, repo: { full_name: 'acme/example', id: 7 } },
    ...overrides,
  };
}

test('resolves an open PR with immutable SHAs', async () => {
  let seenUrl = '';
  let seenInit: RequestInit | undefined;
  const context = await manualContext(env, '42', 'shadow', 'github-token', async (url, init) => {
    seenUrl = url.toString();
    seenInit = init;
    return Response.json(pullRequest());
  });

  assert.equal(seenUrl, 'https://api.github.com/repos/acme/example/pulls/42');
  assert.equal(seenInit?.redirect, 'error');
  assert.equal((seenInit?.headers as Record<string, string>).Authorization, 'Bearer github-token');
  assert.equal((seenInit?.headers as Record<string, string>).Accept, 'application/vnd.github+json');
  assert.ok(seenInit?.signal instanceof AbortSignal);
  assert.deepEqual(context, {
    eventName: 'pull_request', repository: 'acme/example', serverUrl: 'https://github.com',
    testedSha: mergeSha, baseSha, headSha, fork: false,
  });
});

test('supports enforce diagnostics and exact head testing without a merge commit', async () => {
  const context = await manualContext(env, '42', 'enforce', 'github-token', async () => Response.json(pullRequest({
    merge_commit_sha: undefined,
  })), 'head');
  assert.equal(context.testedSha, headSha);
  assert.equal(context.headSha, headSha);
});

test('rejects invalid event, mode, PR number, missing merge, and unavailable API responses', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return Response.json(pullRequest()); };
  for (const [eventName, mode, number] of [
    ['pull_request', 'shadow', '42'], ['workflow_dispatch', 'invalid', '42'], ['workflow_dispatch', 'shadow', '0'],
    ['workflow_dispatch', 'shadow', '4.2'], ['workflow_dispatch', 'shadow', ''],
  ] as const) {
    await assert.rejects(manualContext({ ...env, GITHUB_EVENT_NAME: eventName }, number, mode, 'token', fetchImpl), /invalid-manual-request/);
  }
  await assert.rejects(manualContext(env, '42', 'shadow', 'token', async () => Response.json({ state: 'open' })), /merge-unavailable/);
  await assert.rejects(manualContext(env, '42', 'shadow', 'token', async () => new Response('nope', { status: 500 })), /pull-request-unavailable/);
  assert.equal(calls, 0);
});

test('retains fork status and rejects closed pull requests', async () => {
  const fork = await manualContext(env, '42', 'shadow', 'token', async () => Response.json(pullRequest({
    head: { sha: headSha, repo: { full_name: 'someone/example', id: 8 } },
  })));
  assert.equal(fork.fork, true);
  assert.equal(fork.baseSha, baseSha);
  await assert.rejects(manualContext(env, '42', 'shadow', 'token', async () => Response.json(pullRequest({ state: 'closed' }))), /merge-unavailable/);
});

test('rejects redirects and does not retry the GitHub API request', async () => {
  let calls = 0;
  await assert.rejects(manualContext(env, '42', 'shadow', 'token', async (_url, init) => {
    calls += 1;
    assert.equal(init?.redirect, 'error');
    throw new TypeError('redirect rejected');
  }), /redirect rejected/);
  assert.equal(calls, 1);
});

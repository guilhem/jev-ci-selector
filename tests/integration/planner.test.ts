import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stringify } from 'yaml';
import { createHash } from 'node:crypto';
import { planChange, eventContext, type Inputs, type Context, type PlannerDependencies } from '../../src/planner.js';
import { ConfigError, type RoutingCatalog } from '../../src/config.js';
import { ChangeError } from '../../src/changes.js';
import { evaluateJev, JevError } from '../../src/jev.js';
import { actionOutputs } from '../../src/report.js';
import { patch } from '../fixtures/diff.js';

const inputs: Inputs = { config: '.github/task-routing.yaml', mode: 'enforce', githubToken: 'github-private', apiKey: 'typesafe-private',
  allowExternalContext: true, forceAll: false, timeoutMs: 1000, maxDiffBytes: 65536 };
const context: Context = { eventName: 'pull_request', repository: 'acme/example', serverUrl: 'https://github.com',
  baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), testedSha: 'c'.repeat(40), fork: false };
const customApi = { apiBaseUrl: 'https://opencode.ai/zen/', apiModel: 'jev-1.13-free' };
function routingCatalog(): RoutingCatalog {
  return { model: 'jev-1.13.0', skip_below: 0.05, tasks: {
    unit: { description: 'Does this change affect unit checks?', jobs: [{ workflow: '.github/workflows/ci.yml', job: 'unit' }], always: true },
    helm: { description: 'Does this change affect chart rendering?', jobs: [{ workflow: '.github/workflows/ci.yml', job: 'helm' }], force_paths: ['charts/**'] },
    e2e: { description: 'Does this change affect network routing?', jobs: [{ workflow: '.github/workflows/ci.yml', job: 'e2e' }] },
    build: { description: 'Does this change affect compilation?', jobs: [{ workflow: '.github/workflows/ci.yml', job: 'build' }] },
    prepare: { description: 'Does this change affect generated files?', jobs: [{ workflow: '.github/workflows/ci.yml', job: 'prepare' }] },
  } };
}
const routingWorkflow = `jobs:
  prepare:
    steps: []
  build:
    steps: []
  e2e:
    steps: []
  helm:
    steps: []
  unit:
    steps: []
`;
function fixture(options: { source?: string; paths?: string[]; diff?: string; failure?: Error; jevFailure?: Error } = {}) {
  const calls = { fetch: [] as string[], read: [] as string[], collect: 0, evaluate: 0, dispose: 0 };
  const dependencies: PlannerDependencies = {
    createRepository: async () => ({
      fetchCommit: async sha => { calls.fetch.push(sha); },
      readFile: async (sha, path) => {
        calls.read.push(`${sha}:${path}`);
        if (path === '.github/workflows/ci.yml') return Buffer.from(routingWorkflow);
        if (!path.startsWith('.github/workflows/')) return Buffer.from(options.source ?? stringify(routingCatalog()));
        throw new Error(`missing:${path}`);
      },
      collect: async params => {
        calls.collect++; assert.equal(params.testedSha, context.testedSha);
        if (options.failure) throw options.failure;
        const diff = options.diff ?? patch();
        return { changedPaths: options.paths ?? ['source.txt'], diff, diffBytes: Buffer.byteLength(diff), diffHash: createHash('sha256').update(diff).digest('hex') };
      },
      dispose: async () => { calls.dispose++; },
    }),
    evaluate: async request => {
      calls.evaluate++; assert.equal(request.catalog.model, 'jev-1.13.0');
      if (options.jevFailure) throw options.jevFailure;
      return { probabilities: Object.fromEntries(request.taskIds.map(id => [id, 0])), model: 'jev-1.13.0', usage: { input_tokens: 100, output_tokens: 20 } };
    },
  };
  return { calls, dependencies };
}

test('planner uses only base config, tested merge SHA, source-free report and stable effective outputs', async () => {
  const { calls, dependencies } = fixture();
  const { plan, report } = await planChange({ ...inputs, mode: 'shadow' }, context, dependencies);
  assert.deepEqual(calls, { fetch: [context.baseSha], read: [`${context.baseSha}:${inputs.config}`, `${context.baseSha}:.github/workflows/ci.yml`], collect: 1, evaluate: 1, dispose: 1 });
  assert.equal(report.tested_sha, context.testedSha); assert.equal(report.config_sha, context.baseSha);
  assert.equal(report.version, 4); assert.ok(report.observation);
  assert.deepEqual(report.model, { requested: 'jev-1.13.0', expected: 'jev-1.13.0', returned: 'jev-1.13.0' });
  assert.equal(report.tasks.helm!.proposed_run, false); assert.equal(report.tasks.helm!.run, true);
  assert.ok(!JSON.stringify(report).includes('SENTINEL'));
  assert.ok(!JSON.stringify(report).includes(inputs.apiKey));
  const outputs = actionOutputs(plan, context.testedSha, '/tmp/report.json');
  assert.equal(outputs.status, 'planned'); assert.equal(outputs['has-tasks'], 'true');
  assert.deepEqual(Object.keys(JSON.parse(outputs.run!)), ['build', 'e2e', 'helm', 'prepare', 'unit']);
});
test('custom API selection reports the sent alias and pinned version and falls back on a version change', async () => {
  for (const mode of ['shadow', 'enforce'] as const) for (const returnedModel of ['jev-1.13.0', 'jev-1.13.1']) {
    const f = fixture();
    let requests = 0;
    const { plan, report } = await planChange({ ...inputs, ...customApi, mode }, context, {
      ...f.dependencies,
      evaluate: request => evaluateJev(request, async (url, init) => {
        requests++;
        assert.equal(url, 'https://opencode.ai/zen/v1/systemone');
        const body = JSON.parse(init!.body as string);
        assert.equal(body.model, customApi.apiModel);
        return Response.json({ model: returnedModel,
          answers: Object.fromEntries(request.taskIds.map(id => [id, { type: 'noul', noul: 0 }])),
          usage: { input_tokens: 10, output_tokens: 1 } });
      }),
    });
    assert.equal(requests, 1);
    assert.deepEqual(report.model, { requested: customApi.apiModel, expected: 'jev-1.13.0', returned: returnedModel });
    assert.equal(plan.status, returnedModel === 'jev-1.13.0' ? 'planned' : 'fallback');
    assert.equal(plan.tasks.helm!.run, mode === 'shadow' || returnedModel !== 'jev-1.13.0');
    if (returnedModel !== 'jev-1.13.0') {
      assert.ok(Object.values(plan.run).every(Boolean));
      assert.deepEqual(plan.tasks.helm!.reasons, mode === 'shadow' ? ['invalid-response', 'shadow-mode'] : ['invalid-response']);
    }
  }
});
test('invalid API configuration fails before repository or API access', async () => {
  for (const options of [{ apiBaseUrl: 'http://api.test' }, { apiModel: 'invalid model' }]) {
    let repositories = 0;
    await assert.rejects(planChange({ ...inputs, ...options }, context, {
      createRepository: async () => { repositories++; throw new Error('unexpected-repository-access'); },
    }), /invalid-input/);
    assert.equal(repositories, 0);
  }
});
test('explicit bypasses never collect diff or call Jev; missing config still blocks', async () => {
  const cases: [Partial<Inputs>, Partial<Context>, string][] = [
    [{ forceAll: true }, {}, 'force-all'], [{ apiKey: '' }, {}, 'missing-api-key'],
    [{ allowExternalContext: false }, {}, 'external-context-disabled'], [{}, { fork: true }, 'fork'],
    [{}, { eventName: 'push' }, 'non-pull-request'], [{}, { eventName: 'schedule' }, 'non-pull-request'],
    [{}, { eventName: 'merge_group' }, 'non-pull-request'],
  ];
  for (const mode of ['shadow', 'enforce'] as const) for (const api of [{}, customApi]) for (const [inputOverride, contextOverride, reason] of cases) {
    const { calls, dependencies } = fixture();
    const { plan, report } = await planChange({ ...inputs, ...api, ...inputOverride, mode }, { ...context, ...contextOverride }, dependencies);
    assert.equal(calls.collect, 0); assert.equal(calls.evaluate, 0); assert.equal(plan.status, 'bypassed');
    assert.ok(Object.values(plan.run).every(Boolean)); assert.ok(plan.tasks.helm!.reasons.includes(reason as never));
    assert.equal(report.model.returned, null); assert.equal(report.usage, null); assert.equal(report.diff_hash, null); assert.equal(report.durations_ms.jev, null);
  }
  const invalid = fixture({ source: 'tasks: {}' });
  await assert.rejects(planChange({ ...inputs, forceAll: true }, context, invalid.dependencies), ConfigError);
  assert.equal(invalid.calls.dispose, 1); assert.equal(invalid.calls.evaluate, 0);
});
test('policy edits including custom catalog paths bypass using base policy', async () => {
  for (const path of [inputs.config, '.github/workflows/ci.yml', 'custom/catalog.yml']) {
    const f = fixture({ paths: [path] });
    const { plan } = await planChange({ ...inputs, config: path === 'custom/catalog.yml' ? path : inputs.config }, context, f.dependencies);
    assert.equal(plan.status, 'bypassed'); assert.equal(f.calls.evaluate, 1);
  }
  const binaryWithPolicy = fixture({ failure: new ChangeError('binary-change', [inputs.config, 'asset.bin']) });
  const { plan } = await planChange(inputs, context, binaryWithPolicy.dependencies);
  assert.equal(plan.status, 'bypassed'); assert.equal(binaryWithPolicy.calls.evaluate, 0);
});
test('collection and Jev failures globally fall back; internal failures block', async () => {
  for (const failure of [new ChangeError('diff-too-large'), new ChangeError('sha-incoherent'), new ChangeError('binary-change'), new ChangeError('git-fetch-failed')]) {
    const f = fixture({ failure });
    const { plan } = await planChange(inputs, context, f.dependencies);
    assert.equal(plan.status, 'fallback'); assert.ok(Object.values(plan.run).every(Boolean)); assert.equal(f.calls.evaluate, 0);
  }
  for (const code of ['jev-timeout', 'jev-error', 'invalid-response'] as const) {
    const f = fixture({ jevFailure: new JevError(code) });
    const { plan } = await planChange(inputs, context, f.dependencies);
    assert.equal(plan.status, 'fallback'); assert.ok(Object.values(plan.run).every(Boolean));
    assert.equal(plan.tasks.helm!.proposed_run, null); assert.equal(plan.tasks.helm!.probability, null);
  }
  await assert.rejects(planChange(inputs, context, fixture({ failure: new Error('internal defect') }).dependencies));
  await assert.rejects(planChange(inputs, context, fixture({ jevFailure: new Error('internal defect') }).dependencies));
});
test('fully deterministic catalog keeps its mandatory task and observes its description', async () => {
  const value = routingCatalog(); value.tasks = { unit: { ...value.tasks.unit!, always: true } };
  const f = fixture({ source: stringify(value) });
  const { plan, report } = await planChange(inputs, context, f.dependencies);
  assert.equal(plan.status, 'planned'); assert.equal(f.calls.evaluate, 1);
  assert.equal(report.tasks.unit!.probability, null); assert.equal(report.tasks.unit!.proposed_run, true);
});
test('event snapshots are immutable, strict and conservatively identify forks', () => {
  const env = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: context.repository, GITHUB_SHA: context.testedSha };
  const repo = { full_name: context.repository, id: 1 };
  const event = { pull_request: { base: { sha: context.baseSha, repo }, head: { sha: context.headSha, repo } } };
  assert.deepEqual(eventContext(env, event), context);
  assert.equal(eventContext(env, { pull_request: { ...event.pull_request, head: { ...event.pull_request.head, repo: null } } }).fork, true);
  for (const bad of [{}, { pull_request: { base: { sha: 'main' }, head: {} } }]) assert.throws(() => eventContext(env, bad));
  assert.throws(() => eventContext({ ...env, GITHUB_SERVER_URL: 'https://github.com@evil.test/path' }, event));
  const nonPr = eventContext({ ...env, GITHUB_EVENT_NAME: 'push' }, {});
  assert.equal(nonPr.baseSha, context.testedSha);
});

test('shadow observes configured force paths, per-task force paths, and always tasks with questions', async () => {
  const globalCatalog = routingCatalog();
  globalCatalog.force_all_paths = ['generated/**'];
  const global = fixture({ source: stringify(globalCatalog), paths: ['generated/output.ts'] });
  const globalTaskIds: string[] = [];
  const globalEvaluate = global.dependencies.evaluate!;
  const globalResult = await planChange({ ...inputs, mode: 'shadow' }, context, {
    ...global.dependencies,
    evaluate: async request => { globalTaskIds.push(...request.taskIds); return globalEvaluate(request); },
  });
  assert.equal(global.calls.collect, 1);
  assert.equal(global.calls.evaluate, 1);
  assert.equal(globalResult.plan.status, 'bypassed');
  assert.deepEqual([...new Set(globalTaskIds)].sort(), ['build', 'e2e', 'helm', 'prepare', 'unit']);
  assert.ok(globalResult.report.observation);

  const taskCatalog = routingCatalog();
  taskCatalog.tasks.helm!.force_paths = ['source.txt'];
  const task = fixture({ source: stringify(taskCatalog) });
  const taskIds: string[] = [];
  const taskEvaluate = task.dependencies.evaluate!;
  const taskResult = await planChange({ ...inputs, mode: 'shadow' }, context, {
    ...task.dependencies,
    evaluate: async request => { taskIds.push(...request.taskIds); return taskEvaluate(request); },
  });
  assert.ok(taskIds.includes('helm'));
  assert.equal(taskResult.plan.status, 'planned');
  assert.ok(taskResult.plan.tasks.helm!.reasons.includes('path-match'));

  const alwaysCatalog = routingCatalog();
  alwaysCatalog.tasks.unit = { ...alwaysCatalog.tasks.unit!, always: true };
  const always = fixture({ source: stringify(alwaysCatalog) });
  const alwaysTaskIds: string[] = [];
  const alwaysEvaluate = always.dependencies.evaluate!;
  const alwaysResult = await planChange({ ...inputs, mode: 'shadow' }, context, {
    ...always.dependencies,
    evaluate: async request => { alwaysTaskIds.push(...request.taskIds); return alwaysEvaluate(request); },
  });
  assert.ok(alwaysTaskIds.includes('unit'));
  assert.equal(alwaysResult.plan.tasks.unit!.run, true);
});

test('enforce groups large observations and manual catalog reads use workflow SHA before base collection', async () => {
  const enforce = fixture({ diff: patch(1600) });
  const enforced = await planChange(inputs, context, enforce.dependencies);
  assert.ok(enforce.calls.evaluate > 1);
  assert.equal(enforced.report.observation?.strategy, 'chunked-diff');
  assert.ok(enforced.report.observation!.chunks.length > 1);

  const configSha = 'd'.repeat(40);
  const manual = fixture();
  const manualResult = await planChange({ ...inputs, mode: 'shadow' }, { ...context, configSha }, manual.dependencies);
  assert.deepEqual(manual.calls.fetch, [configSha, context.baseSha]);
  assert.deepEqual(manual.calls.read, [configSha + ':' + inputs.config, configSha + ':.github/workflows/ci.yml']);
  assert.equal(manualResult.report.config_sha, configSha);
});

test('chunked shadow observation retains raw scores and proposes a task when any chunk is high', async () => {
  const f = fixture({ diff: patch(1600) });
  const evaluate = async (request: Parameters<NonNullable<PlannerDependencies['evaluate']>>[0]) => {
    const state = request.state as { chunk?: { index: number } };
    const score = state.chunk?.index === 1 ? 0.9 : 0.01;
    return { probabilities: Object.fromEntries(request.taskIds.map(id => [id, score])),
      model: 'jev-1.13.0', usage: { input_tokens: 5, output_tokens: 2 } };
  };
  const { plan, report } = await planChange({ ...inputs, mode: 'shadow' }, context, { ...f.dependencies, evaluate });
  assert.equal(report.observation?.strategy, 'chunked-diff');
  assert.ok(report.observation?.chunks.some(chunk => chunk.probabilities?.prepare === 0.9));
  assert.equal(plan.tasks.prepare!.probability, null);
  assert.equal(plan.tasks.prepare!.proposed_run, true);
});

test('routing jobs keep native workflow dependencies out of selector policy and never publish their contents', async () => {
  const source = stringify({ model: 'jev-1.13.0', skip_below: 0.05, tasks: {
    compile: { description: 'Does this change affect compilation?', jobs: [{ workflow: '.github/workflows/check.yml', job: 'build' }] },
    verify: { description: 'Does this change affect tests?', jobs: [{ workflow: '.github/workflows/check.yml', job: 'tests' }], context_files: ['test.config.ts'] },
  } });
  const files: Record<string, string> = {
    [inputs.config]: source,
    '.github/workflows/check.yml': 'jobs:\n  build:\n    steps:\n      - run: make build\n  tests:\n    needs: build\n    steps:\n      - run: make test\n',
    'test.config.ts': 'PRIVATE-CONFIG-SENTINEL',
  };
  const f = fixture({ source });
  const originalCreate = f.dependencies.createRepository!;
  const { plan, report } = await planChange(inputs, context, {
    ...f.dependencies,
    createRepository: async options => ({ ...await originalCreate(options), readFile: async (sha, file) => {
      assert.equal(sha, context.baseSha); assert.ok(Object.hasOwn(files, file)); return Buffer.from(files[file]!);
    } }),
    evaluate: async request => {
      assert.match(request.catalog.tasks.verify!.question!, /PRIVATE-CONFIG-SENTINEL/);
      return { probabilities: { compile: 0.01, verify: 0.8 }, model: 'jev-1.13.0', usage: { input_tokens: 1, output_tokens: 1 } };
    },
  });
  assert.equal(plan.run.compile, false); assert.ok(!plan.tasks.compile!.reasons.includes('dependency'));
  assert.equal(plan.run.verify, true);
  assert.equal(report.version, 4);
  assert.match(JSON.stringify(report.job_metadata), /workflow-job/);
  assert.ok(!JSON.stringify(report).includes('PRIVATE-CONFIG-SENTINEL'));
});

test('missing job metadata keeps the affected task and records the evidence gap', async () => {
  const source = stringify({ model: 'jev-1.13.0', skip_below: 0.05,
    tasks: { verify: { description: 'Does this change affect tests?', jobs: [{ workflow: '.github/workflows/missing.yml', job: 'verify' }] } } });
  const f = fixture({ source });
  const originalCreate = f.dependencies.createRepository!;
  const { plan, report } = await planChange(inputs, context, { ...f.dependencies,
    createRepository: async options => ({ ...await originalCreate(options), readFile: async (_sha, file) => {
      if (file !== inputs.config) throw new Error('missing'); return Buffer.from(source);
    } }),
  });
  assert.equal(plan.run.verify, true);
  assert.ok(plan.tasks.verify!.reasons.includes('metadata-unavailable'));
  assert.ok(!plan.tasks.verify!.reasons.includes('always'));
  assert.match(JSON.stringify(report.job_metadata), /workflow-missing/);
});

test('a failed observation preserves deterministic global policy and per-task reasons', async () => {
  const f = fixture({ paths: ['.github/workflows/ci.yml', 'charts/values.yml'], jevFailure: new JevError('jev-timeout') });
  const { plan, report } = await planChange(inputs, context, f.dependencies);
  assert.equal(plan.status, 'bypassed');
  assert.equal(report.observation_error, 'jev-timeout');
  assert.ok(plan.tasks.helm!.reasons.includes('protected-path'));
  assert.ok(plan.tasks.helm!.reasons.includes('path-match'));
  assert.ok(plan.tasks.unit!.reasons.includes('always'));
  assert.equal(report.observation?.status, 'incomplete');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stringify, parse } from 'yaml';
import { createHash } from 'node:crypto';
import { planChange, eventContext, type Inputs, type Context, type PlannerDependencies } from '../../src/planner.js';
import { type SelectionDefinition } from '../../src/tasks.js';
import { ChangeError } from '../../src/changes.js';
import { evaluateJev, JevError } from '../../src/jev.js';
import { actionOutputs, summary } from '../../src/report.js';
import { judgment } from '../fixtures/selection.js';
import { patch } from '../fixtures/diff.js';

const inputs: Inputs = { ...routingSelection(), mode: 'enforce', githubToken: 'github-private', apiKey: 'typesafe-private',
  allowExternalContext: true, forceAll: false, timeoutMs: 1000, maxDiffBytes: 65536 };
const context: Context = { eventName: 'pull_request', repository: 'acme/example', serverUrl: 'https://github.com',
  baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), testedSha: 'c'.repeat(40), fork: false };
const customApi = { apiBaseUrl: 'https://opencode.ai/zen/', apiModel: 'jev-1.13-free' };
function routingSelection(): SelectionDefinition {
  const result: SelectionDefinition = { model: 'jev-1.13.0', tasks: {
    unit: { description: 'Does this change affect unit checks?', jobs: [{ workflow: '.github/workflows/ci.yml', job: 'unit' }], always: true },
    helm: { description: 'Does this change affect chart rendering?', jobs: [{ workflow: '.github/workflows/ci.yml', job: 'helm' }], force_paths: ['charts/**'] },
    e2e: { description: 'Does this change affect network routing?', jobs: [{ workflow: '.github/workflows/ci.yml', job: 'e2e' }] },
    build: { description: 'Does this change affect compilation?', jobs: [{ workflow: '.github/workflows/ci.yml', job: 'build' }] },
    prepare: { description: 'Does this change affect generated files?', jobs: [{ workflow: '.github/workflows/ci.yml', job: 'prepare' }] },
  } };
  for (const task of Object.values(result.tasks)) task.resolve_context_files = false;
  return result;
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
function fixture(options: { paths?: string[]; diff?: string; failure?: Error; jevFailure?: Error } = {}) {
  const calls = { fetch: [] as string[], read: [] as string[], collect: 0, evaluate: 0, dispose: 0 };
  const dependencies: PlannerDependencies = {
    createRepository: async () => ({
      fetchCommit: async sha => { calls.fetch.push(sha); },
      listFiles: async () => [],
      readFile: async (sha, path) => {
        calls.read.push(`${sha}:${path}`);
        if (path === '.github/workflows/ci.yml') return Buffer.from(routingWorkflow);
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
      calls.evaluate++; assert.equal(request.selection.model, 'jev-1.13.0');
      if (options.jevFailure) throw options.jevFailure;
      return { answers: Object.fromEntries(request.taskIds.map(id => [id, judgment()])), model: 'jev-1.13.0', usage: { input_tokens: 100, output_tokens: 20 } };
    },
  };
  return { calls, dependencies };
}

test('planner uses only base metadata, tested merge SHA, source-free report and stable effective outputs', async () => {
  const { calls, dependencies } = fixture();
  const { plan, report } = await planChange({ ...inputs, mode: 'shadow' }, context, dependencies);
  assert.deepEqual(calls, { fetch: [context.baseSha], read: [`${context.baseSha}:.github/workflows/ci.yml`], collect: 1, evaluate: 1, dispose: 1 });
  assert.equal(report.tested_sha, context.testedSha); assert.equal(report.metadata_sha, context.baseSha);
  assert.equal(report.version, 7); assert.ok(report.observation);
  assert.deepEqual(report.model, { requested: 'jev-1.13.0', expected: 'jev-1.13.0', returned: 'jev-1.13.0' });
  assert.equal(report.tasks.helm!.proposed_run, false); assert.equal(report.tasks.helm!.run, true);
  assert.ok(!JSON.stringify(report).includes('SENTINEL'));
  assert.ok(!JSON.stringify(report).includes(inputs.apiKey));
  const outputs = actionOutputs(plan, context.testedSha, '/tmp/report.json');
  assert.equal(outputs.status, 'planned'); assert.equal(outputs['has-tasks'], 'true');
  assert.deepEqual(Object.keys(JSON.parse(outputs.run!)), ['build', 'e2e', 'helm', 'prepare', 'unit']);
});

test('Choice reaches the SDK with explicit job scope and preserves enforce, shadow, protected paths and incomplete fallback', async () => {
  for (const scenario of ['enforce', 'shadow', 'workflow', 'missing'] as const) {
    const f = fixture({ paths: scenario === 'workflow' ? ['.github/workflows/ci.yml'] : ['source.txt'] });
    const configured = { ...inputs, mode: scenario === 'shadow' ? 'shadow' as const : 'enforce' as const };
    configured.tasks = { ...configured.tasks, helm: { ...configured.tasks.helm!, context_files: ['ci/check.conf'] } };
    const create = f.dependencies.createRepository!;
    const { plan, report } = await planChange(configured, context, {
      ...f.dependencies,
      createRepository: async options => {
        const repository = await create(options);
        return { ...repository, listFiles: async () => { throw new Error('discovery was not enabled'); },
          readFile: async (sha, path) => path === 'ci/check.conf' ? Buffer.from('PRIVATE-SCOPE-SENTINEL') : repository.readFile(sha, path) };
      },
      evaluate: request => evaluateJev(request, async (_url, init) => {
        const body = JSON.parse(init!.body as string);
        const task = body.questions.helm.instructions.task;
        assert.equal(body.questions.helm.type, 'choice');
        assert.equal(task.description, configured.tasks.helm!.description);
        assert.equal(task.jobs[0].id, 'helm');
        assert.deepEqual(task.contextFiles, [{ path: 'ci/check.conf', content: 'PRIVATE-SCOPE-SENTINEL' }]);
        return Response.json({ model: 'jev-1.13.0', usage: { input_tokens: 10, output_tokens: 2 },
          answers: Object.fromEntries(Object.keys(body.questions).filter(id => scenario !== 'missing' || id !== 'prepare').map(id => {
            const choice = id === 'e2e' ? 'unresolved' : id === 'build' ? 'required' : 'independent';
            return [id, { type: 'choice', choice, confidence: 1,
              probabilities: Object.fromEntries(['required', 'independent', 'unresolved'].map(option => [option, option === choice ? 1 : 0])) }];
          })) });
      }),
    });
    assert.ok(!JSON.stringify(report).includes('PRIVATE-SCOPE-SENTINEL'));
    assert.deepEqual(Object.keys(report.context_resolution), []);
    if (scenario === 'enforce') {
      assert.deepEqual(plan.run, { build: true, e2e: true, helm: false, prepare: false, unit: true });
      assert.deepEqual(report.tasks.helm!.reasons, ['jev-independent']);
      assert.deepEqual(report.tasks.e2e!.reasons, ['jev-not-independent']);
      assert.equal(report.observation!.chunks[0]!.judgments!.e2e!.choice, 'unresolved');
      assert.match(summary(report), /e2e=unresolved/);
    } else assert.ok(Object.values(plan.run).every(Boolean), scenario);
    if (scenario === 'missing') assert.equal(plan.status, 'fallback');
    if (scenario === 'workflow') assert.equal(plan.status, 'bypassed');
    if (scenario === 'shadow') assert.equal(report.tasks.helm!.proposed_run, false);
  }
});
test('opt-in context resolution feeds the final evaluation and reports all inference usage', async () => {
  const f = fixture();
  const definition: SelectionDefinition = { model: 'jev-1.13.0', tasks: {
    helm: { resolve_context_files: true, description: 'Renders charts', jobs: [{ workflow: '.github/workflows/ci.yml', job: 'helm' }] },
  } };
  const create = f.dependencies.createRepository!;
  let finalBudget = 0;
  const { plan, report } = await planChange({ ...inputs, ...definition }, context, {
    ...f.dependencies,
    createRepository: async options => {
      const repository = await create(options);
      return { ...repository, listFiles: async sha => { assert.equal(sha, context.baseSha); return ['charts/config.yml']; },
        readFile: async (sha, path) => path === 'charts/config.yml' ? Buffer.from('PRIVATE-CONFIG-SENTINEL') : repository.readFile(sha, path) };
    },
    evaluateContext: async request => {
      assert.ok(!JSON.stringify(request.state).includes(context.headSha));
      return { model: 'jev-1.13.0', usage: { input_tokens: 10, output_tokens: 2 }, answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
        const selected = Object.hasOwn(question.criteria, 'keep') ? 'keep' : 'inspect';
        return [id, { choice: selected, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(option => [option, option === selected ? 1 : 0])) }];
      })) };
    },
    evaluate: async request => {
      finalBudget = request.timeoutMs;
      assert.ok(JSON.stringify(request.selection.tasks.helm!.evidence).includes('PRIVATE-CONFIG-SENTINEL'));
      return { model: 'jev-1.13.0', usage: { input_tokens: 30, output_tokens: 3 }, answers: { helm: judgment('required') } };
    },
  });
  assert.equal(plan.tasks.helm!.run, true);
  assert.equal(report.context_resolution['.github/workflows/ci.yml#helm']!.passes.length, 2);
  assert.deepEqual(report.usage, { input_tokens: 50, output_tokens: 7 });
  assert.ok(finalBudget > 0 && finalBudget < inputs.timeoutMs);
  assert.ok(!JSON.stringify(report).includes('PRIVATE-CONFIG-SENTINEL'));
});
test('context reports preserve literal Git paths whether ignored or retained and escape their display', async () => {
  for (const separator of ['\n', '\r']) for (const retained of [false, true]) {
    const path = `config/line${separator}|\`scope.cfg`;
    const f = fixture();
    const create = f.dependencies.createRepository!;
    const reads: string[] = [];
    const { plan, report } = await planChange({ ...inputs, tasks: { check: { resolve_context_files: true, description: 'Checks configuration.' } } }, context, {
      ...f.dependencies,
      createRepository: async options => ({ ...await create(options), listFiles: async () => [path],
        readFile: async (sha, file) => {
          assert.equal(sha, context.baseSha);
          reads.push(file);
          assert.equal(file, path);
          return Buffer.from('PRIVATE-CONFIG-SENTINEL');
        },
      }),
      evaluateContext: async request => ({ model: 'jev-1.13.0', usage: { input_tokens: 10, output_tokens: 2 },
        answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
          const selected = retained ? Object.hasOwn(question.criteria, 'keep') ? 'keep' : 'inspect' : 'ignore';
          return [id, { choice: selected, confidence: 1,
            probabilities: Object.fromEntries(Object.keys(question.criteria).map(option => [option, option === selected ? 1 : 0])) }];
        })),
      }),
      evaluate: async request => {
        const files = request.selection.tasks.check!.evidence.contextFiles as Array<{ path: string }>;
        assert.deepEqual(files.map(file => file.path), retained ? [path] : []);
        return { model: 'jev-1.13.0', usage: { input_tokens: 1, output_tokens: 1 }, answers: { check: judgment() } };
      },
    });
    assert.equal(plan.status, 'planned');
    assert.equal(actionOutputs(plan, context.testedSha, '/tmp/report.json').check, 'false');
    assert.deepEqual(reads, retained ? [path] : []);
    const resolution = JSON.parse(JSON.stringify(report)).context_resolution['task:check'];
    for (const pass of resolution.passes) {
      assert.deepEqual(pass.calls[0].paths, [path]);
      assert.deepEqual(Object.keys(pass.calls[0].judgments), [path]);
    }
    assert.deepEqual(resolution.sources.map((source: { path: string }) => source.path), retained ? [path] : []);
    const display = summary(report);
    assert.ok(!display.includes(path));
    if (retained) assert.ok(display.includes('config/line \\|\\`scope.cfg'));
    assert.ok(!JSON.stringify(report).includes('PRIVATE-CONFIG-SENTINEL'));
  }
});
test('a preparation failure keeps its job while an explicitly configured unrelated task may still skip', async () => {
  const f = fixture();
  const definition: SelectionDefinition = { model: 'jev-1.13.0', tasks: {
    helm: { resolve_context_files: true, description: 'Renders charts', jobs: [{ workflow: '.github/workflows/ci.yml', job: 'helm' }] },
    build: { description: 'Builds', resolve_context_files: false },
  } };
  const create = f.dependencies.createRepository!;
  const { plan, report } = await planChange({ ...inputs, ...definition }, context, {
    ...f.dependencies,
    createRepository: async options => ({ ...await create(options), listFiles: async () => ['config.ini'] }),
    evaluateContext: async () => { throw new JevError('jev-error', { model: 'jev-1.13.0', usage: { input_tokens: 7, output_tokens: 1 } }); },
  });
  assert.equal(plan.tasks.helm!.run, true);
  assert.equal(plan.tasks.build!.run, false);
  assert.equal(plan.status, 'fallback');
  assert.ok(plan.tasks.helm!.reasons.includes('context-resolution-incomplete'));
  assert.equal(report.context_resolution['.github/workflows/ci.yml#helm']!.status, 'incomplete');
  assert.deepEqual(report.usage, { input_tokens: 107, output_tokens: 21 });
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
          answers: Object.fromEntries(request.taskIds.map(id => [id, { type: 'choice', ...judgment() }])),
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
test('explicit bypasses never collect diff or call Jev; invalid tasks still block', async () => {
  const cases: [Partial<Inputs>, Partial<Context>, string][] = [
    [{ forceAll: true }, {}, 'force-all'], [{ apiKey: '' }, {}, 'missing-api-key'],
    [{ allowExternalContext: false }, {}, 'external-context-disabled'], [{}, { fork: true }, 'fork'],
    [{}, { eventName: 'push' }, 'non-pull-request'], [{}, { eventName: 'schedule' }, 'non-pull-request'],
    [{}, { eventName: 'merge_group' }, 'non-pull-request'],
  ];
  for (const mode of ['shadow', 'enforce'] as const) for (const api of [{}, customApi]) for (const [inputOverride, contextOverride, reason] of cases) {
    const { calls, dependencies } = fixture();
    const { plan, report } = await planChange({ ...inputs, ...api, ...inputOverride, mode }, { ...context, ...contextOverride }, dependencies);
    assert.deepEqual(calls.fetch, []); assert.deepEqual(calls.read, []); assert.equal(calls.dispose, 0); assert.equal(calls.collect, 0); assert.equal(calls.evaluate, 0); assert.equal(plan.status, 'bypassed');
    assert.ok(Object.values(plan.run).every(Boolean)); assert.ok(plan.tasks.helm!.reasons.includes(reason as never));
    assert.equal(report.model.returned, null); assert.equal(report.usage, null); assert.equal(report.diff_hash, null); assert.equal(report.durations_ms.jev, null);
  }
  const invalid = fixture();
  await assert.rejects(planChange({ ...inputs, tasks: { bad: {} } as never, forceAll: true }, context, invalid.dependencies));
  assert.equal(invalid.calls.dispose, 0); assert.equal(invalid.calls.evaluate, 0);
});
test('workflow edits retain protection even on binary changes', async () => {
  for (const options of [{ paths: ['.github/workflows/ci.yml'] }, { failure: new ChangeError('binary-change', ['.github/workflows/ci.yml', 'asset.bin']) }]) {
    const f = fixture(options);
    const { plan } = await planChange(inputs, context, f.dependencies);
    assert.equal(plan.status, 'bypassed');
  }
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
    assert.equal(plan.tasks.helm!.proposed_run, null);
  }
  await assert.rejects(planChange(inputs, context, fixture({ failure: new Error('internal defect') }).dependencies));
  await assert.rejects(planChange(inputs, context, fixture({ jevFailure: new Error('internal defect') }).dependencies));
});
test('fully deterministic selection keeps its mandatory task and observes its description', async () => {
  const value = routingSelection(); value.tasks = { unit: { ...value.tasks.unit!, always: true } };
  const f = fixture();
  const { plan, report } = await planChange({ ...inputs, ...value }, context, f.dependencies);
  assert.equal(plan.status, 'planned'); assert.equal(f.calls.evaluate, 1);
 assert.equal(report.tasks.unit!.proposed_run, true);
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
  const taskSelection = routingSelection();
  taskSelection.tasks.helm!.force_paths = ['source.txt'];
  const task = fixture();
  const taskIds: string[] = [];
  const taskEvaluate = task.dependencies.evaluate!;
  const taskResult = await planChange({ ...inputs, ...taskSelection, mode: 'shadow' }, context, {
    ...task.dependencies,
    evaluate: async request => { taskIds.push(...request.taskIds); return taskEvaluate(request); },
  });
  assert.ok(taskIds.includes('helm'));
  assert.equal(taskResult.plan.status, 'planned');
  assert.ok(taskResult.plan.tasks.helm!.reasons.includes('path-match'));

  const alwaysSelection = routingSelection();
  alwaysSelection.tasks.unit = { ...alwaysSelection.tasks.unit!, always: true };
  const always = fixture();
  const alwaysTaskIds: string[] = [];
  const alwaysEvaluate = always.dependencies.evaluate!;
  const alwaysResult = await planChange({ ...inputs, ...alwaysSelection, mode: 'shadow' }, context, {
    ...always.dependencies,
    evaluate: async request => { alwaysTaskIds.push(...request.taskIds); return alwaysEvaluate(request); },
  });
  assert.ok(alwaysTaskIds.includes('unit'));
  assert.equal(alwaysResult.plan.tasks.unit!.run, true);
});

test('enforce groups large observations and manual metadata reads use workflow SHA', async () => {
  const enforce = fixture({ diff: patch(1600) });
  const enforced = await planChange(inputs, context, enforce.dependencies);
  assert.ok(enforce.calls.evaluate > 1);
  assert.equal(enforced.report.observation?.strategy, 'chunked-diff');
  assert.ok(enforced.report.observation!.chunks.length > 1);

  const metadataSha = 'd'.repeat(40);
  const manual = fixture();
  const manualResult = await planChange({ ...inputs, mode: 'shadow' }, { ...context, metadataSha }, manual.dependencies);
  assert.deepEqual(manual.calls.fetch, [context.baseSha, metadataSha]);
  assert.deepEqual(manual.calls.read, [metadataSha + ':.github/workflows/ci.yml']);
  assert.equal(manualResult.report.metadata_sha, metadataSha);
});

test('chunked shadow observation retains raw judgments and proposes a task when any chunk requires it', async () => {
  const f = fixture({ diff: patch(1600) });
  const evaluate = async (request: Parameters<NonNullable<PlannerDependencies['evaluate']>>[0]) => {
    const state = request.state as { chunk?: { index: number } };
    const answer = judgment(state.chunk?.index === 1 ? 'required' : 'independent');
    return { answers: Object.fromEntries(request.taskIds.map(id => [id, answer])),
      model: 'jev-1.13.0', usage: { input_tokens: 5, output_tokens: 2 } };
  };
  const { plan, report } = await planChange({ ...inputs, mode: 'shadow' }, context, { ...f.dependencies, evaluate });
  assert.equal(report.observation?.strategy, 'chunked-diff');
  assert.ok(report.observation?.chunks.some(chunk => chunk.judgments?.prepare?.choice === 'required'));
  assert.equal(plan.tasks.prepare!.proposed_run, true);
});

test('routing jobs keep native workflow dependencies out of selector policy and never publish their contents', async () => {
  const source = stringify({ model: 'jev-1.13.0', tasks: {
    compile: { description: 'Does this change affect compilation?', jobs: [{ workflow: '.github/workflows/check.yml', job: 'build' }] },
    verify: { description: 'Does this change affect tests?', jobs: [{ workflow: '.github/workflows/check.yml', job: 'tests' }], context_files: ['test.config.ts'] },
  } });
  const files: Record<string, string> = {
    '.github/workflows/check.yml': 'jobs:\n  build:\n    steps:\n      - run: make build\n  tests:\n    needs: build\n    steps:\n      - run: make test\n',
    'test.config.ts': 'PRIVATE-CONFIG-SENTINEL',
  };
  const f = fixture();
  const originalCreate = f.dependencies.createRepository!;
  const { plan, report } = await planChange({ ...inputs, ...parse(source) }, context, {
    ...f.dependencies,
    createRepository: async options => ({ ...await originalCreate(options), readFile: async (sha, file) => {
      assert.equal(sha, context.baseSha); assert.ok(Object.hasOwn(files, file)); return Buffer.from(files[file]!);
    } }),
    evaluate: async request => {
      assert.match(JSON.stringify(request.selection.tasks.verify!.evidence), /PRIVATE-CONFIG-SENTINEL/);
      return { answers: { compile: judgment(), verify: judgment('required') }, model: 'jev-1.13.0', usage: { input_tokens: 1, output_tokens: 1 } };
    },
  });
  assert.equal(plan.run.compile, false);
  assert.equal(plan.run.verify, true);
  assert.equal(report.version, 7);
  assert.match(JSON.stringify(report.job_metadata), /workflow-job/);
  assert.ok(!JSON.stringify(report).includes('PRIVATE-CONFIG-SENTINEL'));
});

test('missing job metadata keeps the affected task and records the evidence gap', async () => {
  const source = stringify({ model: 'jev-1.13.0',
    tasks: { verify: { description: 'Does this change affect tests?', jobs: [{ workflow: '.github/workflows/missing.yml', job: 'verify' }] } } });
  const f = fixture();
  const originalCreate = f.dependencies.createRepository!;
  const { plan, report } = await planChange({ ...inputs, ...parse(source) }, context, { ...f.dependencies,
    createRepository: async options => ({ ...await originalCreate(options), readFile: async (_sha, file) => {
      throw new Error('missing');
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


test('description-only selection needs no metadata and can exclude a task', async () => {
  const f = fixture();
  const result = await planChange({ ...inputs, tasks: { check: { description: 'Checks backend rules.' } } }, context, f.dependencies);
  assert.equal(result.plan.run.check, false);
  assert.deepEqual(f.calls.fetch, [context.baseSha]); assert.deepEqual(f.calls.read, []);
  assert.equal(f.calls.evaluate, 1);
  assert.ok(!result.plan.tasks.check!.reasons.includes('metadata-unavailable'));
});
test('empty selection avoids repository creation and inference', async () => {
  const result = await planChange({ ...inputs, tasks: {} }, context, {
    createRepository: async () => { throw new Error('unexpected repository'); },
    evaluate: async () => { throw new Error('unexpected inference'); },
  });
  assert.equal(result.plan.hasTasks, false);
  assert.deepEqual(result.plan.selected, []);
});

test('repository creation and base fetch failures retain every task', async () => {
  for (const stage of ['create', 'fetch'] as const) {
    const f = fixture();
    const create = f.dependencies.createRepository!;
    const { plan } = await planChange(inputs, context, { ...f.dependencies,
      createRepository: async options => {
        if (stage === 'create') throw new ChangeError('git-fetch-failed');
        return { ...await create(options), fetchCommit: async () => { throw new ChangeError('git-fetch-failed'); } };
      },
    });
    assert.equal(plan.status, 'fallback');
    assert.ok(Object.values(plan.run).every(Boolean));
    assert.equal(f.calls.collect, 0); assert.equal(f.calls.evaluate, 0);
    assert.deepEqual(f.calls.read, []);
    assert.equal(f.calls.dispose, stage === 'create' ? 0 : 1);
  }
});

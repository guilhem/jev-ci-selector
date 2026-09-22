import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveTasks } from '../../src/metadata.js';
import { resolveContextFiles } from '../../src/context.js';
import { JevError, type evaluateChoices } from '../../src/jev.js';
import type { SelectionDefinition } from '../../src/tasks.js';
import { REQUEST_BYTES } from '../../src/observations.js';

const workflow = '.github/workflows/ci.yml';
const files = {
  [workflow]: 'jobs:\n  check:\n    steps:\n      - run: python tools/verify.py\n  docs:\n    steps:\n      - run: make docs\n',
  'tools/verify.py': 'PRIVATE-SOURCE\nload_config("settings/check.toml")\n',
  'settings/check.toml': 'include = ["library/**"]\n',
  'explicit.md': 'USER-PROVIDED-SCOPE',
  'docs/Makefile': 'docs: generate\n',
  'README.md': 'Not relevant to the job.\n',
};
type ChoiceRequest = Parameters<typeof evaluateChoices>[0];
function response(request: ChoiceRequest, decide: (path: string, request: ChoiceRequest) => string) {
  return { model: request.model, usage: { input_tokens: 10, output_tokens: 1 },
    answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
      const path = (question.instructions as { path: string }).path;
      const chosen = decide(path, request);
      return [id, { choice: chosen, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === chosen ? 1 : 0])) }];
    })) };
}
async function setup(options: { tasks?: SelectionDefinition['tasks']; contents?: Record<string, string>; commit?: string } = {}) {
  const contents: Record<string, string> = options.contents ?? files;
  const configured: SelectionDefinition = { model: 'jev-1.13.0', tasks: options.tasks ?? {
    unit: { resolve_context_files: true, description: 'Checks behavior', jobs: [{ workflow, job: 'check' }], context_files: ['explicit.md'] },
  } };
  const commit = options.commit ?? 'a'.repeat(40);
  const reads: string[] = [];
  let inventories = 0;
  const repository = {
    listFiles: async (sha: string) => { assert.equal(sha, commit); inventories++; return Object.keys(contents).reverse(); },
    readFile: async (sha: string, path: string) => {
      assert.equal(sha, commit); reads.push(path);
      if (!(path in contents)) throw new Error('missing-file');
      return Buffer.from(contents[path]!);
    },
  };
  const resolved = await resolveTasks(configured, { repository: 'example/repo', commit, readFile: repository.readFile });
  const requests: ChoiceRequest[] = [];
  const evaluate: typeof evaluateChoices = async request => {
    requests.push(request);
    const sources = (request.state as { sources: Array<{ path: string; content: string }> }).sources;
    return response(request, path => {
      if (sources.some(source => source.path === path)) return 'keep';
      if (path === 'tools/verify.py') return 'inspect';
      if (sources.some(source => source.content.includes('load_config')) && path === 'settings/check.toml') return 'inspect';
      return 'ignore';
    });
  };
  return { configured, resolved, repository, commit, apiKey: 'SECRET', deadline: performance.now() + 10000,
    evaluate, requests, reads, inventories: () => inventories };
}

test('two read waves discover indirect configuration and always preserve explicit context', async () => {
  const f = await setup();
  const report = await resolveContextFiles(f, f.evaluate);
  assert.equal(f.requests.length, 2);
  assert.equal(report[`${workflow}#check`]!.status, 'complete');
  assert.deepEqual(report[`${workflow}#check`]!.sources.map(source => source.path), ['settings/check.toml', 'tools/verify.py']);
  const evidence = f.resolved.selection.tasks.unit!.evidence;
  assert.deepEqual((evidence.contextFiles as Array<{ path: string }>).map(source => source.path), ['explicit.md', 'settings/check.toml', 'tools/verify.py']);
  assert.ok(JSON.stringify(evidence).includes('PRIVATE-SOURCE'));
  assert.ok(!JSON.stringify(report).includes('PRIVATE-SOURCE'));
  assert.ok(!JSON.stringify(report).includes('SECRET'));
  assert.ok(f.resolved.metadata.tasks.unit!.provenance.some(item => item.kind === 'resolved-context-file' && item.locator.commit === f.commit));
});

test('omitted or false opt-in makes no preparation call or inventory and keeps its original evidence', async () => {
  for (const option of [{}, { resolve_context_files: false }]) {
    const f = await setup({ tasks: { explicit: { description: 'Checks behavior', jobs: [{ workflow, job: 'check' }], context_files: ['explicit.md'], ...option } } });
    const before = structuredClone(f.resolved.selection);
    assert.deepEqual(Object.keys(await resolveContextFiles(f, async () => { throw new Error('unexpected-call'); })), []);
    assert.equal(f.inventories(), 0);
    assert.deepEqual(f.resolved.selection, before);
  }
});

test('job context is prepared once, shared only with enabled tasks, and multi-job tasks receive the union', async () => {
  const f = await setup({ tasks: {
    unit: { resolve_context_files: true, description: 'first task', jobs: [{ workflow, job: 'check' }] },
    shared: { resolve_context_files: true, description: 'different task wording', jobs: [{ workflow, job: 'check' }] },
    disabled: { description: 'explicit only', jobs: [{ workflow, job: 'check' }], resolve_context_files: false },
    both: { resolve_context_files: true, description: 'both jobs', jobs: [{ workflow, job: 'check' }, { workflow, job: 'docs' }] },
  } });
  const report = await resolveContextFiles(f, async request => {
    f.requests.push(request);
    const state = request.state as { job: { id: string }; sources: Array<{ path: string }> };
    return response(request, path => state.sources.some(source => source.path === path) ? 'keep'
      : path === (state.job.id === 'check' ? 'tools/verify.py' : 'docs/Makefile') ? 'inspect' : 'ignore');
  });
  assert.equal(f.requests.length, 4);
  assert.deepEqual(report[`${workflow}#check`]!.task_ids, ['both', 'shared', 'unit']);
  assert.equal(f.reads.filter(path => path === 'tools/verify.py').length, 1);
  assert.deepEqual(f.resolved.selection.tasks.disabled!.evidence.contextFiles, []);
  assert.deepEqual((f.resolved.selection.tasks.both!.evidence.contextFiles as Array<{ path: string }>).map(file => file.path), ['docs/Makefile', 'tools/verify.py']);
  assert.ok(!JSON.stringify(f.requests).includes('different task wording'));
});

test('same job, inventory and relevant contents produce identical requests across commits and task descriptions', async () => {
  const a = await setup();
  const b = await setup({ commit: 'b'.repeat(40), tasks: { renamed: { resolve_context_files: true, description: 'Other description', jobs: [{ workflow, job: 'check' }] } } });
  const first = await resolveContextFiles(a, a.evaluate);
  const second = await resolveContextFiles(b, b.evaluate);
  assert.deepEqual(first[`${workflow}#check`]!.passes.map(pass => pass.calls.map(call => call.request_hash)), second[`${workflow}#check`]!.passes.map(pass => pass.calls.map(call => call.request_hash)));
  const c = await setup({ contents: { ...files, 'tools/verify.py': 'load_config("different.toml")\n' } });
  const third = await resolveContextFiles(c, c.evaluate);
  assert.equal(first[`${workflow}#check`]!.passes[0]!.calls[0]!.request_hash, third[`${workflow}#check`]!.passes[0]!.calls[0]!.request_hash);
  assert.notEqual(first[`${workflow}#check`]!.passes[1]!.calls[0]!.request_hash, third[`${workflow}#check`]!.passes[1]!.calls[0]!.request_hash);
});

test('a task without jobs uses its description; uncertain files remain available', async () => {
  const f = await setup({ tasks: { go: { resolve_context_files: true, description: 'Runs the Go tests' } }, contents: { 'go.mod': 'module sample', 'internal/parser.go': 'package parser' } });
  const report = await resolveContextFiles(f, async request => {
    assert.equal((request.state as { description: string }).description, 'Runs the Go tests');
    return response(request, () => 'uncertain');
  });
  assert.equal(report['task:go']!.sources.length, 2);
  assert.equal(report['task:go']!.passes.length, 2);
});

test('failed, unreadable, oversized and invalid resolutions retain affected tasks', async () => {
  for (const failure of ['api', 'read', 'size', 'invalid', 'timeout', 'inventory']) {
    const f = await setup();
    if (failure === 'read') f.repository.readFile = async () => { throw new Error('SECRET-FILE'); };
    if (failure === 'inventory') f.repository.listFiles = async () => { throw new Error('SECRET-INVENTORY'); };
    if (failure === 'size') f.repository.readFile = async () => Buffer.from('large'.repeat(20000));
    if (failure === 'timeout') f.deadline = performance.now() - 1;
    const report = await resolveContextFiles(f, async request => {
      if (failure === 'api') throw new JevError('jev-error');
      if (failure === 'invalid') return { model: f.configured.model, usage: { input_tokens: 1, output_tokens: 1 }, answers: {} };
      return f.evaluate(request);
    });
    const info = report[`${workflow}#check`]!;
    assert.equal(info.status, 'incomplete', failure);
    assert.equal(f.resolved.selection.tasks.unit!.always, true, failure);
    assert.equal(f.resolved.metadata.tasks.unit!.incomplete, true, failure);
    assert.ok(!JSON.stringify(report).includes('SECRET-'), failure);
  }
});

test('all paths are covered by bounded batches with at most three concurrent calls', async () => {
  const contents = Object.fromEntries(Array.from({ length: 350 }, (_, i) => [`nested/file-${i}.anything`, 'data']));
  const f = await setup({ contents, tasks: { check: { resolve_context_files: true, description: 'Checks project configuration' } } });
  let active = 0;
  let peak = 0;
  const visited: string[] = [];
  await resolveContextFiles(f, async request => {
    peak = Math.max(peak, ++active);
    assert.ok(Buffer.byteLength(JSON.stringify({ model: request.model, state: request.state, questions: request.questions })) <= REQUEST_BYTES);
    await new Promise(resolve => setTimeout(resolve, 2));
    const result = response(request, path => { visited.push(path); return 'ignore'; });
    active--; return result;
  });
  assert.deepEqual(visited.sort(), Object.keys(contents).sort());
  assert.ok(peak > 1 && peak <= 3);
});

test('second-pass source batches preserve full files and retain discoveries from any batch', async () => {
  const a = 'config=c.ini\n' + 'a'.repeat(45000);
  const b = 'unrelated guide\n' + 'b'.repeat(45000);
  const f = await setup({ tasks: { check: { resolve_context_files: true, description: 'Runs a configured check' } }, contents: { 'a.md': a, 'b.md': b, 'c.ini': 'scope=src/' } });
  const states: Array<{ sources: Array<{ path: string; content: string }> }> = [];
  const report = await resolveContextFiles(f, async request => {
    const state = request.state as { sources: Array<{ path: string; content: string }> };
    states.push(state);
    return response(request, path => {
      if (!state.sources.length) return path.endsWith('.md') ? 'inspect' : 'ignore';
      if (state.sources.some(source => source.path === path)) return 'discard';
      return path === 'c.ini' && state.sources.some(source => source.path === 'a.md') ? 'inspect' : 'ignore';
    });
  });
  assert.equal(report['task:check']!.status, 'complete');
  assert.equal(report['task:check']!.passes.length, 2);
  assert.equal(report['task:check']!.passes[1]!.calls.length, 2);
  assert.deepEqual(states.slice(1).flatMap(state => state.sources.map(source => source.content)), [a, b]);
  assert.deepEqual(report['task:check']!.sources.map(source => source.path), ['c.ini']);
  assert.deepEqual((f.resolved.selection.tasks.check!.evidence.contextFiles as Array<{ path: string }>).map(source => source.path), ['c.ini']);
});

test('an oversized multi-job union retains only its affected task without dropping explicit files', async () => {
  const f = await setup({ contents: { [workflow]: files[workflow], 'a.txt': 'a'.repeat(34000), 'b.txt': 'b'.repeat(34000), 'explicit.md': 'declared' }, tasks: {
    first: { resolve_context_files: true, description: 'First job', jobs: [{ workflow, job: 'check' }] },
    both: { resolve_context_files: true, description: 'Both jobs', jobs: [{ workflow, job: 'check' }, { workflow, job: 'docs' }], context_files: ['explicit.md'] },
  } });
  await resolveContextFiles(f, async request => {
    const state = request.state as { job: { id: string }; sources: Array<{ path: string }> };
    return response(request, path => state.sources.some(source => source.path === path) ? 'keep'
      : path === (state.job.id === 'check' ? 'a.txt' : 'b.txt') ? 'inspect' : 'ignore');
  });
  assert.equal(f.resolved.metadata.tasks.first!.incomplete, false);
  assert.equal(f.resolved.metadata.tasks.both!.incomplete, true);
  assert.equal(f.resolved.selection.tasks.both!.always, true);
  assert.ok(f.resolved.metadata.tasks.both!.missing.includes('context-resolution:combined-context-too-large'));
  assert.deepEqual(f.resolved.selection.tasks.both!.evidence.contextFiles, [{ path: 'explicit.md', content: 'declared' }]);
});

test('the shared question style states the wording once and keeps the meaning', async () => {
  const seen: Array<{ state: unknown; questions: Record<string, { instructions: unknown; criteria: Record<string, string> }> }> = [];
  const evaluate = async (input: never) => {
    const request = input as unknown as typeof seen[number] & { model: string };
    seen.push(request);
    return { model: 'jev-1.13.0', usage: { input_tokens: 1000, output_tokens: 1 },
      answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
        const option = Object.keys(question.criteria)[0]!;
        return [id, { type: 'choice', choice: option, confidence: 1,
          probabilities: Object.fromEntries(Object.keys(question.criteria).map(o => [o, o === option ? 1 : 0])) }];
      })) };
  };
  const paths = Array.from({ length: 40 }, (_, index) => `src/module-${index}.ts`);
  const size = async (style: 'inline' | 'shared') => {
    seen.length = 0;
    await resolveContextFiles({
      configured: { model: 'jev-1.13.0', tasks: { unit: { description: 'Verifies units.', resolve_context_files: true } } },
      resolved: {
        selection: { model: 'jev-1.13.0', tasks: { unit: { evidence: { description: 'Verifies units.' } } } },
        metadata: { repository: 'acme/example', commit: 'a'.repeat(40),
          tasks: { unit: { incomplete: false, missing: [], provenance: [], hashes: {}, warnings: [], nativeDependencies: [] } } },
        workingDirectories: [],
      },
      repository: { listFiles: async () => paths, readFile: async () => Buffer.from('body\n') },
      commit: 'a'.repeat(40), apiKey: 'k', deadline: performance.now() + 60_000,
    } as never, evaluate as never, 1, style);
    const first = seen[0]!;
    const question = Object.values(first.questions)[0]!;
    return { question: Buffer.byteLength(JSON.stringify(question)),
      state: JSON.stringify(first.state) };
  };

  const inline = await size('inline');
  const shared = await size('shared');
  assert.ok(shared.question * 2 < inline.question,
    `a shared question (${shared.question}B) must be far smaller than an inline one (${inline.question}B)`);
  // The wording is not lost, only moved: it is stated once in the state.
  assert.ok(shared.state.includes('question_contract'));
  assert.ok(shared.state.includes('Topic similarity is insufficient'));
  assert.ok(!inline.state.includes('question_contract'));
});

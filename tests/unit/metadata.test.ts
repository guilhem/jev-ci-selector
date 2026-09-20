import { parseCatalog } from '../../src/config.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCatalog, type RoutingCatalog } from '../../src/config.js';
import { resolveCatalog } from '../../src/metadata.js';

const workflow = `name: CI
defaults:
  run:
    working-directory: app
jobs:
  prepare:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm run prepare
        working-directory: packages/web
  unit:
    needs: [prepare, deploy]
    if: \${{ matrix.node == '20' }}
    strategy:
      matrix:
        node: ['20']
    steps:
      - uses: ./.github/actions/composite
      - run: npm run unit
        working-directory: packages/web
      - run: bun test
      - run: bun run tests/unit/metadata.test.ts
`;

const composite = `name: Composite
description: Runs the checked-in unit setup
inputs:
  mode:
    description: Test mode
outputs:
  result:
    description: Result name
runs:
  using: composite
  steps:
    - uses: example/tools/setup@v1
    - run: echo \"\${{ inputs.mode }}\"
      shell: bash
`;

const packageJson = JSON.stringify({ scripts: { prepare: 'npm run generate', generate: 'node generate.mjs', unit: 'npm run unit:fast', 'unit:fast': 'vitest run' } }, null, 2);

function resolverFiles() {
  const files = new Map<string, string>([
    ['.github/workflows/ci.yml', workflow],
    ['.github/actions/composite/action.yml', composite],
    ['packages/web/package.json', packageJson],
    ['vitest.config.mts', 'export default { test: { environment: "node" } };\n'],
  ]);
  return {
    readFile: async (_commit: string, file: string) => {
      const value = files.get(file);
      if (value === undefined) throw new Error(`missing:${file}`);
      return value;
    },
    resolveExternal: async (request: { repository: string; commit: string; uses: string; path: string; ref: string }) => {
      if (request.uses === 'actions/checkout@v4') return {
        repository: request.repository, commit: 'checkout-sha', file: 'action.yml', content: 'name: Checkout\ndescription: Checkout source\nruns:\n  using: node24\n  main: main.js\n', sha: 'checkout-sha',
      };
      if (request.uses === 'example/tools/setup@v1') return {
        repository: request.repository, commit: 'setup-sha', file: 'action.yml', content: 'name: Setup\ndescription: Set up tools\nruns:\n  using: node24\n  main: main.js\n', sha: 'setup-sha',
      };
      return null;
    },
  };
}

test('resolves workflow, actions, scripts, context, provenance, and same-workflow needs', async () => {
  const input: RoutingCatalog = {
    model: 'jev-1.13.0',
    skip_below: 0.05,
    tasks: {
      prepare: { description: 'Does this change affect generated files?', jobs: [{ workflow: '.github/workflows/ci.yml', job: 'prepare' }] },
      unit: { description: 'Does this change affect unit behavior?', jobs: [{ workflow: '.github/workflows/ci.yml', job: 'unit' }], context_files: ['vitest.config.mts'] },
    },
  };
  const result = await resolveCatalog(input, { repository: 'acme/project', commit: 'base-sha', ...resolverFiles() });
  assert.deepEqual(result.catalog.tasks.prepare!.requires, undefined);
  assert.deepEqual(result.catalog.tasks.unit!.requires, undefined);
  assert.equal(result.metadata.tasks.unit!.incomplete, false);
  assert.equal(result.metadata.tasks.unit!.workflow, '.github/workflows/ci.yml');
  assert.equal(result.metadata.tasks.unit!.job, 'unit');
  assert.deepEqual(result.metadata.tasks.unit!.nativeDependencies, ['deploy', 'prepare']);
  assert.equal(result.metadata.tasks.unit!.warnings.some(item => item.includes('package-script-absent')), false);
  assert.deepEqual(result.workingDirectories, ['app', 'packages/web']);
  assert.equal(result.catalog.tasks.unit!.question!.includes('matrix.node'), false);
  assert.equal(result.catalog.tasks.unit!.question!.includes('"if"'), false);
  assert.match(result.catalog.tasks.unit!.question!, /vitest\.config\.mts/);
  assert.match(result.catalog.tasks.prepare!.question!, /Checkout source/);
  assert.match(result.catalog.tasks.unit!.question!, /unit:fast/);
  assert.equal(result.catalog.tasks.unit!.question!.includes('repository'), false);
  assert.equal(result.catalog.tasks.unit!.question!.includes('provenance'), false);
  assert.equal(result.catalog.tasks.unit!.question!.includes('\n'), false);
  assert.ok(result.metadata.tasks.unit!.provenance.some(item => item.kind === 'workflow-job' && item.locator.location.line > 0));
  assert.ok(result.metadata.tasks.unit!.provenance.some(item => item.kind === 'context-file'));
  assert.ok(Object.keys(result.metadata.tasks.unit!.hashes).every(key => key.startsWith('source:')));
  const provenanceKeys = result.metadata.tasks.unit!.provenance.map(item => `${item.locator.repository}:${item.locator.commit}:${item.locator.file}:${item.locator.location.line}:${item.locator.location.column}`);
  assert.equal(new Set(provenanceKeys).size, provenanceKeys.length);
  assert.equal(JSON.stringify(result.metadata).includes('Checkout source'), false);
  assert.doesNotThrow(() => validateCatalog(result.catalog));
});

test('unresolved metadata is explicit and prevents omission through normalized always', async () => {
  const input: RoutingCatalog = {
    model: 'jev-1.13.0',
    skip_below: 0.05,
    tasks: { missing: { description: 'Does this change affect the missing unit job?', jobs: [{ workflow: '.github/workflows/missing.yml', job: 'unit' }], context_files: ['missing.ts'] } },
  };
  const result = await resolveCatalog(input, {
    repository: 'acme/project', commit: 'base-sha',
    readFile: async () => { throw new Error('missing'); },
  });
  assert.equal(result.catalog.tasks.missing!.always, true);
  assert.equal(result.metadata.tasks.missing!.incomplete, true);
  assert.ok(result.metadata.tasks.missing!.warnings.some(item => item.startsWith('workflow-missing:')));
  assert.doesNotThrow(() => validateCatalog(result.catalog));
});

test('aggregates deduplicated job references and expands an omitted job to all workflow jobs', async () => {
  const input = parseCatalog(`model: jev-1.13.0
skip_below: 0.05
tasks:
  all:
    description: Does this change affect any CI job?
    jobs:
      - workflow: .github/workflows/ci.yml
      - workflow: .github/workflows/ci.yml
      - workflow: .github/workflows/ci.yml
        job: unit
`);
  const result = await resolveCatalog(input, {
    repository: 'acme/project', commit: 'base-sha',
    readFile: async (_commit, file) => file === '.github/workflows/ci.yml'
      ? 'jobs:\n  build:\n    name: Build\n    steps: []\n  unit:\n    name: Unit\n    steps: []\n'
      : (() => { throw new Error(`missing:${file}`); })(),
  });
  const evidence = JSON.parse(result.catalog.tasks.all!.question!);
  assert.deepEqual(evidence.jobs.map((job: { id: string }) => job.id), ['build', 'unit']);
  assert.equal(result.metadata.tasks.all!.incomplete, false);
  assert.equal(result.catalog.tasks.all!.requires, undefined);
});

test('composite bodies are opaque and are not expanded into model metadata', async () => {
  const catalog = parseCatalog(`model: jev-1.13.0
skip_below: 0.05
tasks:
  unit:
    description: Does this change affect unit behavior?
    jobs:
      - workflow: .github/workflows/ci.yml
        job: unit
`);
  const calls: string[] = [];
  const result = await resolveCatalog(catalog, {
    repository: 'acme/app', commit: 'base-sha',
    readFile: async (commit, file) => {
      calls.push(`${commit}:${file}`);
      if (file === '.github/workflows/ci.yml') return `jobs:
  unit:
    steps:
      - uses: example/tools/composite@v2
`;
      throw new Error('missing');
    },
    resolveExternal: async () => ({ repository: 'example/tools', commit: 'external-sha', sha: 'external-sha', file: 'composite/action.yml',
      content: 'name: Composite\nruns:\n  using: composite\n  steps:\n    - uses: ./.github/actions/setup-bun\n' }),
  });
  assert.equal(result.metadata.tasks.unit!.incomplete, false);
  assert.deepEqual(calls, ['base-sha:.github/workflows/ci.yml']);
  const evidence = JSON.parse(result.catalog.tasks.unit!.question!);
  assert.deepEqual(evidence.actions, [{ uses: 'example/tools/composite@v2', name: 'Composite' }]);
  assert.equal(result.catalog.tasks.unit!.question!.includes('setup-bun'), false);
});

test('metadata resolution rejects the abandoned public catalog shape', async () => {
  const input = { version: 1, model: 'jev-1.13.0', skip_below: 0.05, tasks: { unit: { always: true } } };
  await assert.rejects(resolveCatalog(input as unknown as RoutingCatalog, {
    repository: 'acme/project', commit: 'base-sha', readFile: () => { throw new Error('unused'); },
  }), /invalid-catalog/);
});

async function resolveFixture(body: string, files: Record<string, string> = {}) {
  const input = parseCatalog('model: jev-1.13.0\nskip_below: 0.05\ntasks:\n  unit:\n    description: Does this change affect unit behavior?\n    jobs:\n      - workflow: .github/workflows/ci.yml\n        job: unit\n');
  return resolveCatalog(input, { repository: 'acme/project', commit: 'trusted', readFile: (_sha, file) => {
    if (file === '.github/workflows/ci.yml') return body;
    if (files[file] === undefined) throw new Error('missing');
    return files[file]!;
  } });
}

test('does not attribute switched-directory or workspace scripts to the root manifest', async () => {
  for (const command of ['cd server && npm run unit', 'npm --prefix server run unit', 'pnpm --dir server run unit', 'npm run unit --workspace server']) {
    const result = await resolveFixture(`jobs:\n  unit:\n    steps:\n      - run: ${command}\n`, {
      'package.json': JSON.stringify({ scripts: { unit: 'frontend-check' } }),
      'server/package.json': JSON.stringify({ scripts: { unit: 'backend-check' } }),
    });
    assert.equal(result.metadata.tasks.unit!.incomplete, true, command);
    assert.equal(result.catalog.tasks.unit!.always, true);
    assert.deepEqual(JSON.parse(result.catalog.tasks.unit!.question!).packageScripts, []);
    assert.ok(result.metadata.tasks.unit!.missing.includes('package-script-execution-context-unresolved'));
  }
  const nested = await resolveFixture('jobs:\n  unit:\n    steps:\n      - run: npm run test\n', {
    'package.json': JSON.stringify({ scripts: { test: 'cd server && npm run unit', unit: 'wrong-root-script' } }),
  });
  assert.equal(nested.metadata.tasks.unit!.incomplete, true);
  assert.deepEqual(JSON.parse(nested.catalog.tasks.unit!.question!).packageScripts.map((s: {name: string}) => s.name), ['test']);
});

test('retains workflow defaults for non-package commands with exact provenance', async () => {
  const result = await resolveFixture('defaults:\n  run:\n    working-directory: server\n    shell: bash\njobs:\n  unit:\n    steps:\n      - run: python -m unittest discover\n');
  const evidence = JSON.parse(result.catalog.tasks.unit!.question!);
  assert.equal(evidence.jobs[0].steps[0].working_directory, 'server');
  assert.equal(evidence.jobs[0].steps[0].shell, 'bash');
  assert.equal(result.metadata.tasks.unit!.incomplete, false);
  assert.ok(result.metadata.tasks.unit!.provenance.some(source => source.kind === 'workflow-defaults' && source.locator.file === '.github/workflows/ci.yml' && source.locator.location.line === 2));
});

test('does not resolve package scripts from opaque composite action bodies', async () => {
  const result = await resolveFixture('defaults:\n  run:\n    working-directory: unrelated\njobs:\n  unit:\n    steps:\n      - uses: ./.github/actions/check\n', {
    '.github/actions/check/action.yml': 'runs:\n  using: composite\n  steps:\n    - run: npm run root\n      shell: bash\n    - run: npm run unit\n      shell: bash\n      working-directory: server\n',
    'package.json': JSON.stringify({ scripts: { root: 'node root-check.js' } }),
    'server/package.json': JSON.stringify({ scripts: { unit: 'npm run nested', nested: 'node server-check.js' } }),
  });
  const evidence = JSON.parse(result.catalog.tasks.unit!.question!);
  assert.equal(result.metadata.tasks.unit!.incomplete, false);
  assert.deepEqual(evidence.packageScripts, []);
  assert.equal(result.metadata.tasks.unit!.provenance.some(source => source.kind === 'action-step'), false);
  assert.equal(result.workingDirectories.includes('server'), false);
});

test('unresolved reusable workflows retain the job explicitly', async () => {
  const result = await resolveFixture('jobs:\n  unit:\n    uses: ./.github/workflows/reusable.yml\n');
  assert.equal(result.metadata.tasks.unit!.incomplete, true);
  assert.equal(result.catalog.tasks.unit!.always, true);
  assert.ok(result.metadata.tasks.unit!.missing.some(reason => reason.startsWith('reusable-workflow-unresolved:')));
});

test('repeated action references retain supplied input descriptions across jobs', async () => {
  const files: Record<string, string> = {
    '.github/workflows/ci.yml': `jobs:
  first:
    steps:
      - uses: ./action
        with:
          first: yes
  second:
    steps:
      - uses: ./action
        with:
          second: yes
`,
    'action/action.yml': `name: Shared
description: Shared verification
inputs:
  first:
    description: First verification parameter
  second:
    description: Second verification parameter
runs:
  using: node24
  main: index.js
`,
  };
  const result = await resolveCatalog({ model: 'jev-1.13.0', skip_below: 0.1, tasks: {
    check: { description: 'Shared checks', jobs: [{ workflow: '.github/workflows/ci.yml' }] },
  } }, { repository: 'acme/project', commit: 'trusted', readFile: async (_commit, path) => {
    if (!(path in files)) throw new Error('missing');
    return files[path]!;
  } });
  assert.equal(result.metadata.tasks.check!.incomplete, false);
  assert.match(result.catalog.tasks.check!.question!, /First verification parameter/);
  assert.match(result.catalog.tasks.check!.question!, /Second verification parameter/);
});

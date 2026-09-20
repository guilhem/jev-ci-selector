import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stringify, parse } from 'yaml';
import { readFileSync } from 'node:fs';
import { parseCatalog, validateCatalog, validateConfigPath, ConfigError, type RoutingCatalog } from '../../src/config.js';
import { catalog } from '../fixtures/catalog.js';

function routingCatalog(): RoutingCatalog {
  return {
    model: 'jev-1.13.0',
    skip_below: 0.05,
    tasks: {
      unit: {
        description: 'Does this change affect unit behavior?',
        jobs: [{ workflow: '.github/workflows/ci.yml', job: 'unit' }],
        context_files: ['vitest.config.mts'],
      },
      lint: {
        description: 'Does this change affect static analysis?',
        jobs: [{ workflow: '.github/workflows/ci.yml', job: 'lint' }],
        always: true,
        force_paths: ['src/**'],
      },
    },
  };
}

test('routing catalogs parse strictly and preserve zero threshold', () => {
  const value = routingCatalog(); value.skip_below = 0;
  assert.deepEqual(parseCatalog(stringify(value)), value);
});

test('public catalogs require descriptions and nonempty job references', () => {
  const value = routingCatalog();
  for (const invalid of [
    { ...value, version: 1 },
    { ...value, tasks: { unit: { ...value.tasks.unit, description: undefined } } },
    { ...value, tasks: { unit: { ...value.tasks.unit, description: '   ' } } },
    { ...value, tasks: { unit: { ...value.tasks.unit, jobs: [] } } },
    { ...value, tasks: { unit: { ...value.tasks.unit, question: 'legacy' } } },
    { ...value, tasks: { unit: { ...value.tasks.unit, requires: ['lint'] } } },
    { ...value, tasks: { unit: { ...value.tasks.unit, workflow: '.github/workflows/ci.yml', job: 'unit' } } },
  ]) assert.throws(() => parseCatalog(stringify(invalid)), ConfigError);
});

test('duplicates, aliases, unknown fields, invalid IDs, models and paths are fatal', () => {
  const source = stringify(routingCatalog());
  for (const invalid of [source + 'version: 1\n', 'model: jev-1.13.0\ntasks: {unit: {}, unit: {}}',
    source.replace('description:', 'surprise:\n    description:'), source.replace('unit:', '__proto__:'),
    source.replace('unit:', 'plan:'), source.replace('unit:', 'bad.id:'),
    source.replace('jev-1.13.0', 'jev-latest'), source + 'unknown: true\n',
    source.replace('0.05', '1.01'), source.replace('0.05', '-0.01'), source.replace('0.05', '.nan'),
    source.replace('unit:', 'unit: &anchor').replace('lint:', 'lint: *anchor\n  other:')]) {
    assert.throws(() => parseCatalog(invalid), ConfigError);
  }
});

test('internal compiled catalogs retain strict policy validation and dependencies', () => {
  for (const requires of [['absent'], ['e2e']]) {
    const value = catalog(); value.tasks.e2e!.requires = requires;
    assert.throws(() => validateCatalog(value), ConfigError);
  }
  const value = catalog(); value.tasks.prepare!.requires = ['e2e'];
  assert.throws(() => validateCatalog(value), ConfigError);
});

test('only literal relative catalog paths and positive glob patterns', () => {
  for (const path of ['/tmp/policy', '../policy', 'x/../policy', './policy', 'x//policy', 'x\\y', 'x\0y']) {
    assert.throws(() => validateConfigPath(path), ConfigError);
  }
  validateConfigPath('policy/catalog.yml');
  for (const pattern of ['!src/**', '/src/**', '../src/**']) {
    const value = catalog(); value.force_all_paths = [pattern];
    assert.throws(() => validateCatalog(value), ConfigError);
  }
});

test('force_paths remains the only supported task path rule', () => {
  const value = routingCatalog();
  assert.doesNotThrow(() => parseCatalog(stringify(value)));
  assert.throws(() => parseCatalog(stringify({ ...value, tasks: { unit: { ...value.tasks.unit, run_if_paths: ['src/**'] } } })), ConfigError);
});

test('task outputs cannot collide with standard outputs or another task regardless of case', () => {
  const metadata = parse(readFileSync('action.yml', 'utf8'));
  for (const name of [...Object.keys(metadata.outputs), 'constructor', 'plan', 'ci-required', 'ci-contract']) {
    for (const id of [name, name.toUpperCase()]) {
      const value = routingCatalog(); value.tasks = { [id]: { description: 'Always inspect this task.', jobs: [{ workflow: '.github/workflows/ci.yml', job: id }] } };
      assert.throws(() => parseCatalog(stringify(value)), ConfigError, `reserved output/task ID: ${id}`);
    }
  }
  const value = routingCatalog(); value.tasks.Helm = { description: 'Inspect Helm.', jobs: [{ workflow: '.github/workflows/ci.yml', job: 'helm' }] };
  assert.doesNotThrow(() => parseCatalog(stringify(value)));
  value.tasks = { Helm: value.tasks.Helm!, helm: { description: 'Inspect Helm twice.', jobs: [{ workflow: '.github/workflows/ci.yml', job: 'helm2' }] } };
  assert.throws(() => parseCatalog(stringify(value)), ConfigError, 'GitHub output lookup is case-insensitive');
});

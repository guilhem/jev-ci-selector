import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stringify, parse } from 'yaml';
import { readFileSync } from 'node:fs';
import { parseTasks, validateSelection, parseSelectionInputs, selectionHash } from '../../src/tasks.js';
import { selection } from '../fixtures/selection.js';

const task = { description: 'Checks unit behavior.' };
const inputs = (values: Record<string, string>) => parseSelectionInputs(name => values[name] ?? '');
test('tasks are required but explicit empty tasks are valid', () => {
  for (const source of ['', '   ', 'null', '[]', './tasks.yml']) assert.throws(() => parseTasks(source));
  assert.deepEqual(parseTasks('{}'), {});
  assert.throws(() => inputs({}));
  assert.deepEqual(inputs({ tasks: '{}' }), { model: 'jev-1.13.0', tasks: {} });
});
test('only descriptions and optional deterministic rules are accepted', () => {
  assert.deepEqual(parseTasks(stringify({ unit: task })), { unit: { ...task, always: false } });
  assert.deepEqual(parseTasks(stringify({ unit: { ...task, always: true, force_paths: ['src/**'] } })),
    { unit: { ...task, always: true, force_paths: ['src/**'] } });
  for (const invalid of ['description', {}, { description: ' ' }, { ...task, question: 'unsupported' },
    { ...task, requires: ['build'] }, { ...task, always: 'true' }, { ...task, unknown: true }]) {
    assert.throws(() => parseTasks(stringify({ unit: invalid })));
  }
});
test('retired context fields are rejected even when empty or disabled', () => {
  for (const legacy of [{ jobs: [{ workflow: '.github/workflows/ci.yml', job: 'unit' }] },
    { jobs: [] }, { context_files: ['package.json'] }, { context_files: [] },
    { resolve_context_files: true }, { resolve_context_files: false }]) {
    assert.throws(() => parseTasks(stringify({ unit: { ...task, ...legacy } })));
    assert.throws(() => validateSelection({ model: 'jev-1.13.0', tasks: { unit: { ...task, ...legacy } } }));
  }
});
test('selection identity includes descriptions and deterministic rules', () => {
  const implicit = inputs({ tasks: stringify({ unit: task }) });
  const explicit = inputs({ tasks: stringify({ unit: { ...task, always: false } }) });
  assert.equal(selectionHash(implicit), selectionHash(explicit));
  for (const change of [{ description: 'Checks another behavior.' }, { always: true }, { force_paths: ['src/**'] }]) {
    assert.notEqual(selectionHash(implicit), selectionHash(inputs({ tasks: stringify({ unit: { ...task, ...change } }) })));
  }
});
test('models are strict and the selection contract contains only model and tasks', () => {
  assert.equal(inputs({ tasks: '{}', model: 'jev-2.3.4' }).model, 'jev-2.3.4');
  for (const model of ['jev-latest', 'other-1.2.3', 'jev-1.2']) assert.throws(() => inputs({ tasks: '{}', model }));
  for (const extra of [{ skip_below: 0.05 }, { judgment: 'choice' }]) {
    assert.throws(() => validateSelection({ model: 'jev-1.13.0', tasks: {}, ...extra }));
    assert.throws(() => validateSelection({ ...selection(), ...extra }));
  }
  const metadata = parse(readFileSync('action.yml', 'utf8'));
  assert.ok(!Object.hasOwn(metadata.inputs, 'judgment'));
  assert.ok(!Object.hasOwn(metadata.inputs, 'skip-below'));
  assert.doesNotThrow(() => validateSelection(selection()));
});
test('unknown fields, duplicate keys, YAML aliases and invalid IDs are rejected', () => {
  for (const source of ['unit: {description: one}\nunit: {description: two}', 'unit: &x {description: one}\nother: *x', 'unit: {description: one, description: two}',
    stringify({ 'bad.id': task }), stringify({ unit: task, UNIT: task }), stringify({ unit: { ...task, extra: 1 } })]) assert.throws(() => parseTasks(source));
});
test('paths are repository-relative and force globs positive', () => {
  for (const pattern of ['!src/**', '/src/**', '../src/**']) assert.throws(() => parseTasks(stringify({ unit: { ...task, force_paths: [pattern] } })));
  assert.doesNotThrow(() => parseTasks(stringify({ unit: { ...task, force_paths: ['src/**'] } })));
});
test('outputs reserve standard names but not template job names', () => {
  const metadata = parse(readFileSync('action.yml', 'utf8'));
  for (const name of [...Object.keys(metadata.outputs), 'constructor', '__proto__', 'prototype']) for (const id of [name, name.toUpperCase()]) {
    assert.throws(() => parseTasks(stringify({ [id]: task })), id);
  }
  for (const id of ['plan', 'ci-contract', 'ci-required']) assert.doesNotThrow(() => parseTasks(stringify({ [id]: task })));
});

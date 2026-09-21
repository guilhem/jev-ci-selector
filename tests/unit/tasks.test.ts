import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stringify, parse } from 'yaml';
import { readFileSync } from 'node:fs';
import { parseTasks, validateSelection, validateResolvedSelection, parseSelectionInputs, selectionHash } from '../../src/tasks.js';
import { selection } from '../fixtures/selection.js';

const task = { description: 'Checks unit behavior.' };
const inputs = (values: Record<string, string>) => parseSelectionInputs(name => values[name] ?? '');
test('tasks are required but explicit empty tasks are valid', () => {
  for (const source of ['', '   ', 'null', '[]', './tasks.yml']) assert.throws(() => parseTasks(source));
  assert.deepEqual(parseTasks('{}'), {});
  assert.throws(() => inputs({}));
  assert.deepEqual(inputs({ tasks: '{}' }), { model: 'jev-1.13.0', skip_below: 0.05, tasks: {} });
});
test('descriptions suffice; job metadata is optional and strict when supplied', () => {
  assert.deepEqual(parseTasks(stringify({ unit: task })), { unit: { ...task, always: false, resolve_context_files: false } });
  assert.doesNotThrow(() => parseTasks(stringify({ unit: { ...task, jobs: [{ workflow: '.github/workflows/ci.yml' }] } })));
  for (const invalid of ['description', {}, { description: ' ' }, { ...task, jobs: [] }, { ...task, jobs: [{ job: 'unit' }] },
    { ...task, question: 'unsupported' }, { ...task, requires: ['build'] }, { ...task, always: 'true' }, { ...task, unknown: true }]) {
    assert.throws(() => parseTasks(stringify({ unit: invalid })));
  }
});
test('context resolution defaults off, validates booleans, and is part of the selection identity', () => {
  const implicit = inputs({ tasks: stringify({ unit: task }) });
  const enabled = inputs({ tasks: stringify({ unit: { ...task, resolve_context_files: true } }) });
  const disabled = inputs({ tasks: stringify({ unit: { ...task, resolve_context_files: false } }) });
  assert.equal(disabled.tasks.unit!.resolve_context_files, false);
  assert.equal(selectionHash(implicit), selectionHash(disabled));
  assert.notEqual(selectionHash(implicit), selectionHash(enabled));
  for (const value of ['false', 0, null]) assert.throws(() => parseTasks(stringify({ unit: { ...task, resolve_context_files: value } })));
});
test('models and decimal thresholds are strict; zero is preserved', () => {
  assert.equal(inputs({ tasks: '{}', 'skip-below': '0' }).skip_below, 0);
  assert.equal(inputs({ tasks: '{}', model: 'jev-2.3.4' }).model, 'jev-2.3.4');
  for (const value of ['NaN', 'Infinity', '-0.1', '1.01', '0.2suffix']) assert.throws(() => inputs({ tasks: '{}', 'skip-below': value }));
  for (const model of ['jev-latest', 'other-1.2.3', 'jev-1.2']) assert.throws(() => inputs({ tasks: '{}', model }));
  assert.throws(() => validateSelection({ model: 'jev-1.13.0', skip_below: NaN, tasks: {} }));
  assert.doesNotThrow(() => validateResolvedSelection(selection()));
});
test('unknown fields, duplicate keys, YAML aliases and invalid IDs are rejected', () => {
  for (const source of ['unit: {description: one}\nunit: {description: two}', 'unit: &x {description: one}\nother: *x', 'unit: {description: one, description: two}',
    stringify({ 'bad.id': task }), stringify({ unit: task, UNIT: task }), stringify({ unit: { ...task, extra: 1 } })]) assert.throws(() => parseTasks(source));
});
test('paths are repository-relative and force globs positive', () => {
  for (const path of ['/tmp/file', '../file', 'x/../file', 'x\\y', 'x\0y']) {
    assert.throws(() => parseTasks(stringify({ unit: { ...task, context_files: [path] } })));
    assert.throws(() => parseTasks(stringify({ unit: { ...task, jobs: [{ workflow: path }] } })));
  }
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

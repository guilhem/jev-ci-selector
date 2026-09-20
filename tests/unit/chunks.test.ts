import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { ChunkError, splitDiff } from '../../src/chunks.js';

function bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

test('round trips UTF-8 bytes and reports exact source ranges', () => {
  const diff = [
    'diff --git a/café.txt b/café.txt\n',
    'index 123..456 100644\n',
    '--- a/café.txt\n',
    '+++ b/café.txt\n',
    '@@ -1,3 +1,3 @@\n',
    '-ancienne ligne\n',
    '+nouvelle ligne avec 🦄 et accents é\n',
    ' texte conservé\n',
  ].join('');
  const chunks = splitDiff(diff, 58);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.map((chunk) => chunk.diff).join(''), diff);
  assert.equal(createHash('sha256').update(Buffer.from(chunks.map((chunk) => chunk.diff).join(''))).digest('hex'),
    createHash('sha256').update(Buffer.from(diff)).digest('hex'));
  for (const chunk of chunks) {
    assert.equal(Buffer.from(diff).subarray(chunk.startByte, chunk.endByte).toString('utf8'), chunk.diff);
    assert.ok(bytes(chunk.diff) + bytes(chunk.context) <= 58);
  }
  for (let index = 1; index < chunks.length; index += 1) {
    assert.equal(chunks[index]!.startByte, chunks[index - 1]!.endByte);
  }
});

test('uses file and hunk headers as continuation context', () => {
  const diff = [
    'diff --git a/one.txt b/one.txt\n',
    'index 111..222 100644\n',
    '@@ -1,2 +1,2 @@\n',
    '-one\n',
    '+un texte assez long pour forcer une coupure\n',
    'diff --git a/two.txt b/two.txt\n',
    'index 333..444 100644\n',
    '@@ -1,2 +1,2 @@\n',
    '-two\n',
    '+un autre texte\n',
  ].join('');
  const chunks = splitDiff(diff, 72);
  assert.ok(chunks.some((chunk) => chunk.context.includes('diff --git a/one.txt')));
  assert.ok(chunks.some((chunk) => chunk.context.includes('@@ -1,2 +1,2 @@')));
  const secondFile = chunks.find((chunk) => chunk.diff.startsWith('diff --git a/two.txt'));
  assert.ok(secondFile);
  assert.equal(secondFile.context, '');
  for (const chunk of chunks) {
    assert.ok(!chunk.context.includes('index '));
    assert.ok(bytes(chunk.diff) + bytes(chunk.context) <= 72);
  }
});

test('splits a large line only at Unicode boundaries and is deterministic', () => {
  const line = `+${'é🦄'.repeat(80)}\n`;
  const diff = `diff --git a/large.txt b/large.txt\n@@ -1 +1 @@\n${line}`;
  const first = splitDiff(diff, 80);
  const second = splitDiff(diff, 80);
  assert.deepEqual(second, first);
  assert.equal(first.map((chunk) => chunk.diff).join(''), diff);
  for (const chunk of first) {
    assert.ok(bytes(chunk.diff) + bytes(chunk.context) <= 80);
    assert.equal(Buffer.from(chunk.diff, 'utf8').toString('utf8'), chunk.diff);
  }
});

test('honors exact size boundaries and rejects impossible budgets', () => {
  const diff = '+🦄\n';
  assert.deepEqual(splitDiff(diff, bytes(diff)), [{ diff, context: '', startByte: 0, endByte: bytes(diff) }]);
  assert.throws(() => splitDiff(diff, 3), (error: unknown) => error instanceof ChunkError && error.code === 'line-too-large');
  assert.throws(() => splitDiff('', 0), (error: unknown) => error instanceof ChunkError && error.code === 'invalid-budget');
  assert.throws(() => splitDiff('diff --git a/x b/x\n@@ -1 +1 @@\n+x\n', bytes('diff --git a/x b/x\n') + 1),
    (error: unknown) => error instanceof ChunkError && error.code === 'context-too-large');
});

test('returns a consistent empty chunk', () => {
  assert.deepEqual(splitDiff('', 1), [{ diff: '', context: '', startByte: 0, endByte: 0 }]);
});

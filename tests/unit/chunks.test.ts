import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChunkError, splitDiff, type DiffChunk } from '../../src/chunks.js';

function bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', [
    '-c', 'user.name=Chunks Test',
    '-c', 'user.email=chunks@example.invalid',
    '-c', 'core.quotePath=true',
    '-c', 'core.hooksPath=/dev/null',
    ...args,
  ], { cwd: root, encoding: 'utf8' });
}

async function patchFixture(prepare: (root: string) => Promise<void>, mutate: (root: string) => Promise<void>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'jev-chunks-'));
  try {
    git(root, 'init', '-q', '-b', 'main');
    await prepare(root);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
    await mutate(root);
    git(root, 'add', '-A');
    return git(root, 'diff', '--cached', '--no-ext-diff', '--no-color', '--full-index', '-U1');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function assertLossless(diff: string, chunks: DiffChunk[], maxBytes: number): void {
  assert.equal(chunks.map(chunk => chunk.diff).join(''), diff);
  let previousEnd = 0;
  for (const chunk of chunks) {
    assert.equal(chunk.startByte, previousEnd);
    assert.equal(Buffer.from(diff).subarray(chunk.startByte, chunk.endByte).toString('utf8'), chunk.diff);
    assert.ok(bytes(chunk.diff) + bytes(chunk.context) <= maxBytes);
    assert.ok(chunk.diff.length === 0 || chunk.diff.endsWith('\n') || chunk.endByte === bytes(diff));
    previousEnd = chunk.endByte;
  }
  assert.equal(previousEnd, bytes(diff));
}

test('groups complete nearby Git files and reports their decoded paths', async () => {
  const diff = await patchFixture(
    async root => {
      await mkdir(join(root, 'docs'), { recursive: true });
      await mkdir(join(root, 'src'), { recursive: true });
      await writeFile(join(root, 'docs', 'guide.txt'), 'old guide\n');
      await writeFile(join(root, 'src', 'one.txt'), 'old one\n');
      await writeFile(join(root, 'src', 'two.txt'), 'old two\n');
    },
    async root => {
      await writeFile(join(root, 'docs', 'guide.txt'), 'new guide\n');
      await writeFile(join(root, 'src', 'one.txt'), 'new one\n');
      await writeFile(join(root, 'src', 'two.txt'), 'new two\n');
    },
  );
  const sections = diff.split(/(?=^diff --git )/mu).filter(Boolean);
  assert.equal(sections.length, 3);
  const srcBudget = bytes(sections[1]!) + bytes(sections[2]!);
  const chunks = splitDiff(diff, srcBudget, ['src']);
  assertLossless(diff, chunks, srcBudget);
  assert.deepEqual(chunks.map(chunk => chunk.paths), [['docs/guide.txt'], ['src/one.txt', 'src/two.txt']]);
  assert.equal(chunks[0]!.context, '');
  assert.equal(chunks[1]!.context, '');

  const hintedBudget = bytes(sections[0]!) + bytes(sections[1]!);
  const hinted = splitDiff(diff, hintedBudget, ['.']);
  assert.deepEqual(hinted.map(chunk => chunk.paths), [['docs/guide.txt', 'src/one.txt'], ['src/two.txt']]);
});

test('partitions a large Git file at hunk or line boundaries with header context', async () => {
  const base = Array.from({ length: 80 }, (_, index) => `line ${index}\n`).join('');
  const changed = base
    .replace('line 5\n', `line 5 changed with accents é and emoji 🦄\n`)
    .replace('line 45\n', `line 45 changed with accents é and emoji 🦄\n`)
    .replace('line 75\n', `line 75 changed with accents é and emoji 🦄\n`);
  const diff = await patchFixture(
    async root => {
      await writeFile(join(root, 'src-large.txt'), base);
    },
    async root => {
      await writeFile(join(root, 'src-large.txt'), changed);
    },
  );
  const firstFileHeader = diff.indexOf('diff --git ');
  const firstHunk = diff.indexOf('@@ ');
  assert.ok(firstFileHeader >= 0 && firstHunk > firstFileHeader);
  const maxBytes = bytes(diff.slice(0, firstHunk)) + bytes(diff.slice(firstHunk).split('\n').slice(0, 4).join('\n'));
  const chunks = splitDiff(diff, maxBytes);
  assert.ok(chunks.length > 1);
  assertLossless(diff, chunks, maxBytes);
  assert.ok(chunks.slice(1).some(chunk => chunk.context.startsWith('diff --git a/src-large.txt b/src-large.txt\n')));
  assert.ok(chunks.slice(1).some(chunk => chunk.context.includes('@@ ')));
  assert.ok(chunks.every(chunk => chunk.paths.length === 1 && chunk.paths[0] === 'src-large.txt'));
});

test('decodes quoted octal paths for renames, deletions, and additions', async () => {
  const diff = await patchFixture(
    async root => {
      await mkdir(join(root, 'old'), { recursive: true });
      await mkdir(join(root, 'foo b'), { recursive: true });
      await writeFile(join(root, 'old', 'café file.txt'), 'same content\n');
      await writeFile(join(root, 'foo b', 'bar.txt'), 'old path\n');
      await writeFile(join(root, 'gone file.txt'), 'gone\n');
    },
    async root => {
      git(root, 'mv', 'old/café file.txt', 'renamed café file.txt');
      await writeFile(join(root, 'foo b', 'bar.txt'), 'new path\n');
      await rm(join(root, 'gone file.txt'));
      await writeFile(join(root, 'new file é.txt'), 'new\n');
    },
  );
  assert.match(diff, /diff --git "a\/old\/caf\\303\\251 file\.txt" "b\/renamed caf\\303\\251 file\.txt"/u);
  const chunks = splitDiff(diff, bytes(diff));
  assert.equal(chunks.length, 1);
  assertLossless(diff, chunks, bytes(diff));
  const paths = chunks.flatMap(chunk => chunk.paths);
  assert.ok(paths.includes('old/café file.txt'));
  assert.ok(paths.includes('renamed café file.txt'));
  assert.ok(paths.includes('gone file.txt'));
  assert.ok(paths.includes('new file é.txt'));
  assert.ok(paths.includes('foo b/bar.txt'));
});

test('rejects malformed Git patch syntax explicitly and never cuts an oversized line', async () => {
  const diff = await patchFixture(
    async root => { await writeFile(join(root, 'file.txt'), 'old\n'); },
    async root => { await writeFile(join(root, 'file.txt'), `new ${'x'.repeat(160)}\n`); },
  );
  const header = diff.slice(0, diff.indexOf('\n') + 1);
  const malformed = diff.replace(header, 'diff --git "a/file.txt\\q" "b/file.txt"\n');
  assert.throws(() => splitDiff(malformed, bytes(diff)), (error: unknown) =>
    error instanceof ChunkError && error.code === 'unparseable-diff');

  const line = diff.split('\n').find(value => value.startsWith('+new '));
  assert.ok(line);
  assert.throws(() => splitDiff(diff, bytes(line!) + 2), (error: unknown) =>
    error instanceof ChunkError && error.code === 'line-too-large');
  assert.throws(() => splitDiff(diff, 0), (error: unknown) =>
    error instanceof ChunkError && error.code === 'invalid-budget');
});

test('returns an empty valid patch chunk', () => {
  assert.deepEqual(splitDiff('', 1), [{ diff: '', context: '', startByte: 0, endByte: 0, paths: [] }]);
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { ChangeError, GitRepository } from '../../src/changes.js';

interface Fixture {
  root: string;
  remote: string;
  base: string;
  head: string;
  tested: string;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Jev Test', '-c', 'user.email=jev@example.invalid', '-c', 'core.hooksPath=/dev/null', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

async function fixture(setup: (work: string) => Promise<void>): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'jev-changes-test-'));
  const work = join(root, 'work');
  const remote = join(root, 'remote.git');
  await mkdir(work);
  try {
    git(work, 'init', '--quiet', '-b', 'main');
    await setup(work);
    git(work, 'add', '--all');
    git(work, 'commit', '--quiet', '--allow-empty', '-m', 'base');
    const base = git(work, 'rev-parse', 'HEAD');
    git(work, 'switch', '--quiet', '-c', 'feature');
    await writeFile(join(work, 'feature marker.txt'), 'feature\n');
    await setup(work);
    git(work, 'add', '--all');
    git(work, 'commit', '--quiet', '-m', 'head');
    const head = git(work, 'rev-parse', 'HEAD');
    git(work, 'switch', '--quiet', 'main');
    git(work, 'merge', '--quiet', '--no-ff', 'feature', '-m', 'tested merge');
    const tested = git(work, 'rev-parse', 'HEAD');
    git(root, 'init', '--bare', '--quiet', remote);
    git(work, 'push', '--quiet', remote, 'HEAD:refs/heads/main');
    return { root, remote, base, head, tested };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function withRepository<T>(fixtureValue: Fixture, callback: (repository: GitRepository) => Promise<T>): Promise<T> {
  const repository = await GitRepository.create({ remoteUrl: pathToFileURL(fixtureValue.remote).href });
  try {
    return await callback(repository);
  } finally {
    await repository.dispose();
    await rm(fixtureValue.root, { recursive: true, force: true });
  }
}

test('collects a tested merge tree and preserves special paths', async () => {
  const value = await fixture(async (work) => {
    await writeFile(join(work, 'verification scope.md'), 'Unit verification scope.\n');
    await writeFile(join(work, 'old name [x].txt'), 'same content\n');
    await writeFile(join(work, '-\t-\told.txt'), 'unique tab rename\n');
    await writeFile(join(work, 'delete me.txt'), 'gone\n');
    await writeFile(join(work, 'run me.sh'), '#!/bin/sh\nprintf ok\n', { mode: 0o644 });
  });
  const work = join(value.root, 'work');
  try {
    // Amend the feature tree after the generic fixture setup to exercise a
    // rename, a mode change, deletion, and a newline/shell-character name.
    git(work, 'switch', '--quiet', 'feature');
    git(work, 'mv', 'old name [x].txt', 'new name $(x)\n.txt');
    git(work, 'mv', '--', '-\t-\told.txt', '-\t-\tnew.txt');
    git(work, 'rm', '--quiet', 'delete me.txt');
    await writeFile(join(work, 'verification scope.md'), 'Unit verification scope.\n');
    await writeFile(join(work, '\uFEFFunicodé.txt'), 'BOM in filename\n');
    await writeFile(join(work, '$(touch CANARY); x.txt'), 'not executable\n');
    await chmod(join(work, 'run me.sh'), 0o755);
    git(work, 'add', '--all');
    git(work, 'commit', '--quiet', '-m', 'special paths');
    const head = git(work, 'rev-parse', 'HEAD');
    git(work, 'switch', '--quiet', 'main');
    git(work, 'reset', '--hard', '--quiet', value.base);
    git(work, 'merge', '--quiet', '--no-ff', 'feature', '-m', 'tested merge 2');
    // Preserve both parents but introduce content that exists only in the tested
    // merge tree. Comparing to head instead would silently miss this file.
    await writeFile(join(work, 'merge-only.txt'), 'merge resolution\n');
    git(work, 'add', '--all');
    git(work, 'commit', '--quiet', '--amend', '--no-edit');
    const tested = git(work, 'rev-parse', 'HEAD');
    // Use the original fixture's remote as a local immutable object source.
    git(work, 'push', '--quiet', '--force', value.remote, 'HEAD:refs/heads/main', 'feature:refs/heads/feature');
    const adjusted = { ...value, head, tested };
    await withRepository(adjusted, async (repository) => {
      await repository.fetchCommit(adjusted.base);
      const changes = await repository.collect({ baseSha: adjusted.base, headSha: adjusted.head, testedSha: adjusted.tested, maxDiffBytes: 100_000 });
      assert.ok(changes.changedPaths.includes('new name $(x)\n.txt'));
      assert.ok(changes.changedPaths.includes('old name [x].txt'));
      assert.ok(changes.changedPaths.includes('delete me.txt'));
      assert.ok(changes.changedPaths.includes('run me.sh'));
      assert.ok(changes.changedPaths.includes('merge-only.txt'));
      assert.ok(changes.changedPaths.includes('\uFEFFunicodé.txt'));
      assert.ok(changes.changedPaths.includes('-\t-\told.txt'));
      assert.ok(changes.changedPaths.includes('-\t-\tnew.txt'));
      assert.match(changes.diff, /old mode 100644\nnew mode 100755/);
      await assert.rejects(access(join(work, 'CANARY')));
      assert.equal(changes.diffBytes, Buffer.byteLength(changes.diff));
      assert.equal(changes.diffHash.length, 64);
      assert.deepEqual(changes.changedPaths, [...changes.changedPaths].sort());
    });
  } catch (error) {
    await rm(value.root, { recursive: true, force: true });
    throw error;
  }
});

test('rejects binary, invalid UTF-8, submodule, and oversized changes with safe codes', async () => {
  const binary = await fixture(async (work) => {
    const isFeature = await access(join(work, 'feature marker.txt')).then(() => true).catch(() => false);
    if (!isFeature) await writeFile(join(work, 'base.txt'), 'base\n');
    if (isFeature) {
      await writeFile(join(work, 'binary.dat'), Buffer.from([0, 1, 2, 3]));
      await writeFile(join(work, '.gitattributes'), 'binary.dat diff\n');
    }
  });
  await withRepository(binary, async (repository) => {
    await repository.fetchCommit(binary.base);
    const error = await assert.rejects(
      repository.collect({ baseSha: binary.base, headSha: binary.head, testedSha: binary.tested, maxDiffBytes: 100_000 }),
      (value: unknown) => value instanceof ChangeError && value.code === 'binary-change',
    );
    assert.equal(error, undefined);
  });

  const invalid = await fixture(async (work) => {
    const isFeature = await access(join(work, 'feature marker.txt')).then(() => true).catch(() => false);
    if (!isFeature) await writeFile(join(work, 'base.txt'), 'base\n');
    if (isFeature) await writeFile(join(work, 'invalid.txt'), Buffer.from([0xff, 0xfe]));
  });
  await withRepository(invalid, async (repository) => {
    await repository.fetchCommit(invalid.base);
    await assert.rejects(
      repository.collect({ baseSha: invalid.base, headSha: invalid.head, testedSha: invalid.tested, maxDiffBytes: 100_000 }),
      (value: unknown) => value instanceof ChangeError && value.code === 'unrepresentable-change',
    );
  });

  const limited = await fixture(async (work) => {
    const isFeature = await access(join(work, 'feature marker.txt')).then(() => true).catch(() => false);
    if (!isFeature) await writeFile(join(work, 'base.txt'), 'base\n');
    if (isFeature) await writeFile(join(work, 'large.txt'), 'large patch content\n');
  });
  await withRepository(limited, async (repository) => {
    await repository.fetchCommit(limited.base);
    const complete = await repository.collect({ baseSha: limited.base, headSha: limited.head, testedSha: limited.tested, maxDiffBytes: 100_000 });
    const atLimit = await repository.collect({ baseSha: limited.base, headSha: limited.head, testedSha: limited.tested, maxDiffBytes: complete.diffBytes });
    assert.equal(atLimit.diff, complete.diff);
    await assert.rejects(
      repository.collect({ baseSha: limited.base, headSha: limited.head, testedSha: limited.tested, maxDiffBytes: complete.diffBytes - 1 }),
      (value: unknown) => value instanceof ChangeError && value.code === 'diff-too-large',
    );
  });

  const submodule = await fixture(async (work) => {
    const isFeature = await access(join(work, 'feature marker.txt')).then(() => true).catch(() => false);
    if (!isFeature) await writeFile(join(work, 'base.txt'), 'base\n');
    if (!isFeature) return;
    const nested = join(dirname(work), 'nested-source');
    await mkdir(nested);
    git(nested, 'init', '--quiet', '-b', 'main');
    await writeFile(join(nested, 'nested.txt'), 'nested\n');
    git(nested, 'add', '--all');
    git(nested, 'commit', '--quiet', '-m', 'nested');
    git(work, 'clone', '--quiet', nested, 'vendor');
  });
  await withRepository(submodule, async (repository) => {
    await repository.fetchCommit(submodule.base);
    await assert.rejects(
      repository.collect({ baseSha: submodule.base, headSha: submodule.head, testedSha: submodule.tested, maxDiffBytes: 100_000 }),
      (value: unknown) => value instanceof ChangeError && value.code === 'submodule-change',
    );
  });
});

test('requires the exact immutable SHAs and merge parent ordering', async () => {
  const value = await fixture(async (work) => {
    const isFeature = await access(join(work, 'feature marker.txt')).then(() => true).catch(() => false);
    if (!isFeature) await writeFile(join(work, 'base.txt'), 'base\n');
  });
  await withRepository(value, async (repository) => {
    await repository.fetchCommit(value.base);
    await assert.rejects(repository.fetchCommit('deadbeef'), (error: unknown) => error instanceof ChangeError && error.code === 'sha-incoherent');
    await assert.rejects(
      repository.collect({ baseSha: value.base, headSha: value.head, testedSha: value.head, maxDiffBytes: 100_000 }),
      (error: unknown) => error instanceof ChangeError && error.code === 'sha-incoherent',
    );
    await assert.rejects(
      repository.collect({ baseSha: value.head, headSha: value.base, testedSha: value.tested, maxDiffBytes: 100_000 }),
      (error: unknown) => error instanceof ChangeError && error.code === 'sha-incoherent',
    );
    await assert.rejects(repository.fetchCommit('f'.repeat(40)), (error: unknown) => error instanceof ChangeError && error.code === 'git-fetch-failed');
  });
});

test('push compares the exact before and after trees across multiple commits and rewritten history', async () => {
  const value = await fixture(async () => {});
  const work = join(value.root, 'work');
  git(work, 'switch', '--quiet', 'feature');
  await writeFile(join(work, 'second.txt'), 'second pushed commit\n');
  git(work, 'add', '.'); git(work, 'commit', '--quiet', '-m', 'second');
  const after = git(work, 'rev-parse', 'HEAD');
  git(work, 'push', '--quiet', value.remote, 'HEAD:refs/heads/feature');
  git(work, 'switch', '--quiet', '-c', 'rewritten', value.base);
  await writeFile(join(work, 'rewritten.txt'), 'replacement history\n');
  git(work, 'add', '.'); git(work, 'commit', '--quiet', '-m', 'rewrite');
  const rewritten = git(work, 'rev-parse', 'HEAD');
  git(work, 'push', '--quiet', value.remote, 'HEAD:refs/heads/rewritten');
  await withRepository(value, async repository => {
    for (const [before, head, expected] of [
      [value.base, after, ['feature marker.txt', 'second.txt']],
      [after, rewritten, ['feature marker.txt', 'rewritten.txt', 'second.txt']],
    ] as const) {
      await repository.fetchCommit(before);
      const comparison = await repository.verifyComparison({ baseSha: before, headSha: head, testedSha: head, testedRef: 'push' });
      assert.equal(comparison.diffBaseSha, before);
      assert.equal(comparison.testedSha, head);
      const manifest = await repository.collectManifest(comparison);
      assert.deepEqual(manifest.changedPaths, expected);
      assert.equal(manifest.complete, true);
      const patch = await repository.readPatch(comparison, manifest.entries, { maxUnitBytes: 100_000 });
      assert.equal(patch.issue, null);
      if (head === rewritten) assert.match(patch.diff, /-second pushed commit/);
      else assert.match(patch.diff, /\+second pushed commit/);
    }
    for (const range of [
      { baseSha: after, headSha: after, testedSha: after },
      { baseSha: '0'.repeat(40), headSha: after, testedSha: after },
      { baseSha: after, headSha: '0'.repeat(40), testedSha: '0'.repeat(40) },
      { baseSha: value.base, headSha: after, testedSha: rewritten },
    ]) {
      await assert.rejects(repository.verifyComparison({ ...range, testedRef: 'push' }),
        (error: unknown) => error instanceof ChangeError && error.code === 'sha-incoherent');
    }
  });
});

test('empty merge diff is complete, with an empty hashable patch and no paths', async () => {
  const value = await fixture(async () => {});
  const work = join(value.root, 'work');
  git(work, 'rm', '--quiet', 'feature marker.txt');
  git(work, 'commit', '--quiet', '--amend', '--no-edit');
  value.tested = git(work, 'rev-parse', 'HEAD');
  git(work, 'push', '--quiet', '--force', value.remote, 'HEAD:refs/heads/main');
  await withRepository(value, async repository => {
    await repository.fetchCommit(value.base);
    const result = await repository.collect({ baseSha: value.base, headSha: value.head, testedSha: value.tested, maxDiffBytes: 1 });
    assert.deepEqual(result.changedPaths, []); assert.equal(result.diff, ''); assert.equal(result.diffBytes, 0);
    assert.equal(result.diffHash, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

test('unrepresentable filename falls back instead of decoding replacement characters', async () => {
  const value = await fixture(async work => {
    if (await access(join(work, 'feature marker.txt')).then(() => true).catch(() => false)) {
      await writeFile(Buffer.concat([Buffer.from(`${work}/`), Buffer.from([0xff]), Buffer.from('.txt')]), 'bad path\n');
    }
  });
  await withRepository(value, async repository => {
    await repository.fetchCommit(value.base);
    await assert.rejects(repository.collect({ baseSha: value.base, headSha: value.head, testedSha: value.tested, maxDiffBytes: 100_000 }),
      (error: unknown) => error instanceof ChangeError && error.code === 'unrepresentable-change');
  });
});

test('external diff, textconv and inherited Git configuration cannot execute programs', async () => {
  const value = await fixture(async work => { await writeFile(join(work, '.gitattributes'), '*.txt diff=evil\n'); });
  const marker = join(value.root, 'EXECUTED');
  const driver = join(value.root, 'driver.sh');
  const config = join(value.root, 'global.gitconfig');
  await writeFile(driver, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  await writeFile(config, `[diff]\nexternal = ${driver}\n[diff "evil"]\ntextconv = ${driver}\ncommand = ${driver}\n`);
  const overrides = { GIT_CONFIG_GLOBAL: config, GIT_EXTERNAL_DIFF: driver, GIT_DIR: join(value.root, 'nonexistent') };
  const saved = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    const repository = await GitRepository.create({ remoteUrl: pathToFileURL(value.remote).href });
    try {
      await repository.fetchCommit(value.base);
      const result = await repository.collect({ baseSha: value.base, headSha: value.head, testedSha: value.tested, maxDiffBytes: 100_000 });
      assert.ok(result.changedPaths.includes('feature marker.txt'));
      await assert.rejects(access(marker));
    } finally { await repository.dispose(); }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(value.root, { recursive: true, force: true });
  }
});

test('bounds hanging Git commands and kills their process group', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-git-timeout-test-'));
  const pidFile = join(root, 'pids');
  const fakeGit = join(root, 'git');
  await writeFile(fakeGit, '#!/bin/sh\n(sleep 30) &\nchild=$!\nprintf "%s %s" "$$" "$child" > "$GIT_TEST_PID_FILE"\ntrap "" TERM\nwait "$child"\n', { mode: 0o755 });
  const runGitFrom = (GitRepository as unknown as {
    runGitFrom: (cwd: string, env: NodeJS.ProcessEnv, args: string[], maxStdoutBytes?: number, timeoutMs?: number) => Promise<Buffer>;
  }).runGitFrom;
  try {
    await assert.rejects(
      runGitFrom(root, { ...process.env, PATH: `${root}:${process.env.PATH ?? ''}`, GIT_TEST_PID_FILE: pidFile }, ['hang'], undefined, 50),
      /git timed out/,
    );
    const pids = (await readFile(pidFile, 'utf8')).split(/\s+/u).map(Number);
    await new Promise(resolve => setTimeout(resolve, 100));
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('temporary repository cleanup is best effort', async () => {
  const value = await fixture(async () => {});
  const repository = await GitRepository.create({ remoteUrl: pathToFileURL(value.remote).href });
  const cleanup = GitRepository as unknown as {
    removeTemporaryDirectory: (path: string) => Promise<void>;
  };
  const original = cleanup.removeTemporaryDirectory;
  cleanup.removeTemporaryDirectory = async path => {
    await original(path);
    throw new Error('simulated cleanup reporting failure');
  };
  try {
    await assert.doesNotReject(repository.dispose());
  } finally {
    cleanup.removeTemporaryDirectory = original;
    await rm(value.root, { recursive: true, force: true });
  }
});

test('head collection deepens shallow history and diffs from the verified unique merge-base', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-head-changes-test-'));
  const work = join(root, 'work');
  const remote = join(root, 'remote.git');
  await mkdir(work);
  try {
    git(work, 'init', '--quiet', '-b', 'main');
    await writeFile(join(work, 'common.txt'), 'common\n');
    git(work, 'add', '--all');
    git(work, 'commit', '--quiet', '-m', 'common');
    const common = git(work, 'rev-parse', 'HEAD');
    git(work, 'switch', '--quiet', '-c', 'feature');
    await writeFile(join(work, 'head-only.txt'), 'head\n');
    git(work, 'add', '--all');
    git(work, 'commit', '--quiet', '-m', 'head');
    const head = git(work, 'rev-parse', 'HEAD');
    git(work, 'switch', '--quiet', 'main');
    await writeFile(join(work, 'base-only.txt'), 'base\n');
    git(work, 'add', '--all');
    git(work, 'commit', '--quiet', '-m', 'base');
    const base = git(work, 'rev-parse', 'HEAD');
    assert.equal(git(work, 'merge-base', base, head), common);
    git(root, 'init', '--bare', '--quiet', remote);
    git(work, 'push', '--quiet', remote, 'HEAD:refs/heads/main', `${head}:refs/heads/feature`);

    const repository = await GitRepository.create({ remoteUrl: pathToFileURL(remote).href });
    try {
      await repository.fetchCommit(base);
      const changes = await repository.collect({
        baseSha: base,
        headSha: head,
        // The announced tested SHA must exactly identify the head.
        testedSha: head,
        testedRef: 'head',
        maxDiffBytes: 100_000,
      });
      await assert.rejects(repository.collect({ baseSha: base, headSha: head, testedSha: base, testedRef: 'head', maxDiffBytes: 100_000 }),
        (error: unknown) => error instanceof ChangeError && error.code === 'sha-incoherent');
      assert.equal(changes.diffBaseSha, common);
      assert.ok(changes.changedPaths.includes('head-only.txt'));
      assert.ok(!changes.changedPaths.includes('base-only.txt'));
      assert.match(changes.diff, /head-only\.txt/);
      assert.doesNotMatch(changes.diff, /base-only\.txt/);
    } finally {
      await repository.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the manifest inventories names and object ids without reading any content', async () => {
  const value = await fixture(async (work) => {
    const isFeature = await access(join(work, 'feature marker.txt')).then(() => true).catch(() => false);
    if (!isFeature) {
      await writeFile(join(work, 'kept.txt'), 'kept\n');
      await writeFile(join(work, 'renamed-from.txt'), 'identical rename body\n');
      await writeFile(join(work, 'removed.txt'), 'gone\n');
    }
  });
  const work = join(value.root, 'work');
  git(work, 'switch', '--quiet', 'feature');
  git(work, 'mv', 'renamed-from.txt', 'renamed-to.txt');
  git(work, 'rm', '--quiet', 'removed.txt');
  await writeFile(join(work, 'kept.txt'), 'kept and edited\n');
  git(work, 'add', '--all');
  git(work, 'commit', '--quiet', '-m', 'inventory');
  const head = git(work, 'rev-parse', 'HEAD');
  git(work, 'switch', '--quiet', 'main');
  git(work, 'reset', '--hard', '--quiet', value.base);
  git(work, 'merge', '--quiet', '--no-ff', 'feature', '-m', 'inventory merge');
  const tested = git(work, 'rev-parse', 'HEAD');
  git(work, 'push', '--quiet', '--force', value.remote, 'HEAD:refs/heads/main', 'feature:refs/heads/feature');
  const adjusted = { ...value, head, tested };
  await withRepository(adjusted, async repository => {
    await repository.fetchCommit(adjusted.base);
    const comparison = await repository.verifyComparison({ baseSha: adjusted.base, headSha: adjusted.head, testedSha: adjusted.tested });
    const manifest = await repository.collectManifest(comparison);
    assert.equal(manifest.complete, true);
    assert.equal(manifest.manifestHash!.length, 64);
    // Rename detection is off, so a rename is a deletion plus an addition and
    // both paths stay visible to the path-based safety rules.
    assert.ok(manifest.changedPaths.includes('renamed-from.txt'));
    assert.ok(manifest.changedPaths.includes('renamed-to.txt'));
    assert.ok(manifest.changedPaths.includes('removed.txt'));
    const removed = manifest.entries.find(entry => entry.oldPath === 'removed.txt')!;
    assert.equal(removed.status[0], 'D');
    assert.equal(removed.newPath, null);
    assert.equal(removed.newOid, null);
    assert.match(removed.oldOid!, /^[0-9a-f]{40}$/);
    const added = manifest.entries.find(entry => entry.newPath === 'renamed-to.txt')!;
    assert.equal(added.status[0], 'A');
    assert.equal(added.oldPath, null);
    assert.equal(added.issue, null);
    assert.deepEqual([...manifest.changedPaths], [...manifest.changedPaths].sort());
    // The same inventory hashes identically; the ids are stable within it.
    const again = await repository.collectManifest(comparison);
    assert.equal(again.manifestHash, manifest.manifestHash);
    assert.deepEqual(again.entries.map(entry => entry.id), manifest.entries.map(entry => entry.id));
  });
});

test('patch units are bounded, refuse partial output and report per-entry issues', async () => {
  const value = await fixture(async (work) => {
    const isFeature = await access(join(work, 'feature marker.txt')).then(() => true).catch(() => false);
    if (!isFeature) await writeFile(join(work, 'base.txt'), 'base\n');
    if (isFeature) {
      await writeFile(join(work, 'small.txt'), 'small change\n');
      await writeFile(join(work, 'big.txt'), 'padding line\n'.repeat(400));
      await writeFile(join(work, 'blob.dat'), Buffer.from([0, 1, 2, 3, 0, 5]));
      await writeFile(join(work, '.gitattributes'), 'blob.dat diff\n');
    }
  });
  await withRepository(value, async repository => {
    await repository.fetchCommit(value.base);
    const comparison = await repository.verifyComparison({ baseSha: value.base, headSha: value.head, testedSha: value.tested });
    const manifest = await repository.collectManifest(comparison);
    const entryFor = (path: string) => manifest.entries.filter(entry => entry.newPath === path);

    const small = await repository.readPatch(comparison, entryFor('small.txt'), { maxUnitBytes: 64 * 1024 });
    assert.equal(small.issue, null);
    assert.match(small.diff, /\+small change/);
    assert.equal(small.bytes, Buffer.byteLength(small.diff));
    assert.deepEqual(small.paths, ['small.txt']);

    // Git's own binary marker is detected structurally, not by pattern matching
    // inside hunk bodies.
    const binary = await repository.readPatch(comparison, entryFor('blob.dat'), { maxUnitBytes: 64 * 1024 });
    assert.equal(binary.issue, 'binary');
    assert.equal(binary.diff, '');

    // An oversized unit yields an issue; it never delivers a truncated prefix.
    const capped = await repository.readPatch(comparison, entryFor('big.txt'), { maxUnitBytes: 128 });
    assert.equal(capped.issue, 'too-large');
    assert.equal(capped.diff, '');
    assert.equal(capped.bytes, 0);

    // The object-size pre-check refuses the work before Git renders anything.
    const preChecked = await repository.readPatch(comparison, entryFor('big.txt'), { maxUnitBytes: 1024 * 1024, maxBlobBytes: 16 });
    assert.equal(preChecked.issue, 'too-large');

    const none = await repository.readPatch(comparison, [], { maxUnitBytes: 1024 });
    assert.equal(none.issue, null);
    assert.equal(none.diff, '');
    assert.deepEqual(none.changeIds, []);

    const invalidLimit = await repository.readPatch(comparison, entryFor('small.txt'), { maxUnitBytes: 0 });
    assert.equal(invalidLimit.issue, 'too-large');
  });
});

test('a submodule entry is an issue on its own entry, not a verdict on the inventory', async () => {
  const value = await fixture(async (work) => {
    const isFeature = await access(join(work, 'feature marker.txt')).then(() => true).catch(() => false);
    if (!isFeature) await writeFile(join(work, 'base.txt'), 'base\n');
    if (!isFeature) return;
    await writeFile(join(work, 'plain.txt'), 'unrelated text\n');
    const nested = join(dirname(work), 'nested-entry-source');
    await mkdir(nested);
    git(nested, 'init', '--quiet', '-b', 'main');
    await writeFile(join(nested, 'nested.txt'), 'nested\n');
    git(nested, 'add', '--all');
    git(nested, 'commit', '--quiet', '-m', 'nested');
    git(work, 'clone', '--quiet', nested, 'vendor');
  });
  await withRepository(value, async repository => {
    await repository.fetchCommit(value.base);
    const comparison = await repository.verifyComparison({ baseSha: value.base, headSha: value.head, testedSha: value.tested });
    const manifest = await repository.collectManifest(comparison);
    assert.equal(manifest.complete, true);
    const submodule = manifest.entries.find(entry => entry.newMode === '160000' || entry.oldMode === '160000')!;
    assert.equal(submodule.issue, 'submodule');
    // The unrelated entry stays readable: one unsupported entry does not make
    // the whole comparison unusable.
    const plain = manifest.entries.filter(entry => entry.newPath === 'plain.txt');
    assert.equal(plain.length, 1);
    const unit = await repository.readPatch(comparison, plain, { maxUnitBytes: 64 * 1024 });
    assert.equal(unit.issue, null);
    assert.match(unit.diff, /\+unrelated text/);
    assert.equal((await repository.readPatch(comparison, [submodule], { maxUnitBytes: 64 * 1024 })).issue, 'submodule');
  });
});

test('symlinks and type changes are represented from the object database, never followed', async () => {
  const value = await fixture(async (work) => {
    const isFeature = await access(join(work, 'feature marker.txt')).then(() => true).catch(() => false);
    if (!isFeature) {
      await writeFile(join(work, 'secret.txt'), 'BASE-ONLY-SENTINEL\n');
      await writeFile(join(work, 'becomes-link.txt'), 'plain file\n');
    }
  });
  const work = join(value.root, 'work');
  git(work, 'switch', '--quiet', 'feature');
  await rm(join(work, 'becomes-link.txt'));
  await symlink('secret.txt', join(work, 'becomes-link.txt'));
  await symlink('/etc/passwd', join(work, 'absolute-link'));
  git(work, 'add', '--all');
  git(work, 'commit', '--quiet', '-m', 'symlinks');
  const head = git(work, 'rev-parse', 'HEAD');
  git(work, 'switch', '--quiet', 'main');
  git(work, 'reset', '--hard', '--quiet', value.base);
  git(work, 'merge', '--quiet', '--no-ff', 'feature', '-m', 'symlink merge');
  const tested = git(work, 'rev-parse', 'HEAD');
  git(work, 'push', '--quiet', '--force', value.remote, 'HEAD:refs/heads/main', 'feature:refs/heads/feature');
  const adjusted = { ...value, head, tested };
  await withRepository(adjusted, async repository => {
    await repository.fetchCommit(adjusted.base);
    const comparison = await repository.verifyComparison({ baseSha: adjusted.base, headSha: adjusted.head, testedSha: adjusted.tested });
    const manifest = await repository.collectManifest(comparison);
    const link = manifest.entries.find(entry => entry.newPath === 'absolute-link')!;
    assert.equal(link.newMode, '120000');
    assert.equal(link.issue, null);
    const unit = await repository.readPatch(comparison, manifest.entries, { maxUnitBytes: 64 * 1024 });
    assert.equal(unit.issue, null);
    // The link target is recorded as text; the target file is never read.
    assert.match(unit.diff, /\+\/etc\/passwd/);
    assert.doesNotMatch(unit.diff, /root:/);
    assert.doesNotMatch(unit.diff, /BASE-ONLY-SENTINEL/);
    // A type change keeps both sides visible.
    assert.match(unit.diff, /becomes-link\.txt/);
  });
});

test('interrupted reads report the bytes stdout actually carried', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-git-bytes-test-'));
  const fakeGit = join(root, 'git');
  // Emit a known prefix, then hang. A timeout must not erase what was received.
  await writeFile(fakeGit, '#!/bin/sh\nprintf "0123456789"\nsleep 30\n', { mode: 0o755 });
  const runGitFrom = (GitRepository as unknown as {
    runGitFrom: (cwd: string, env: NodeJS.ProcessEnv, args: string[], maxStdoutBytes?: number, timeoutMs?: number) => Promise<Buffer>;
  }).runGitFrom;
  const env = { ...process.env, PATH: `${root}:${process.env.PATH ?? ''}` };
  try {
    const timedOut = await runGitFrom(root, env, ['hang'], undefined, 150).then(() => undefined, (error: unknown) => error);
    assert.match((timedOut as Error).message, /git timed out/);
    assert.equal((timedOut as { stdoutBytes: number }).stdoutBytes, 10,
      'a timeout after partial output still reports those bytes');

    // The chunk that crosses the cap is reported as received, not clamped down
    // to the cap: the report shows the overshoot instead of hiding it.
    const overshot = await runGitFrom(root, env, ['hang'], 4, 150).then(() => undefined, (error: unknown) => error);
    assert.match((overshot as Error).message, /output limit/);
    assert.equal((overshot as { stdoutBytes: number }).stdoutBytes, 10);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a read interrupted after partial output charges what it delivered', async () => {
  const value = await fixture(async (work) => {
    const isFeature = await access(join(work, 'feature marker.txt')).then(() => true).catch(() => false);
    if (!isFeature) await writeFile(join(work, 'base.txt'), 'base\n');
    if (isFeature) await writeFile(join(work, 'wide.txt'), 'padding line\n'.repeat(400));
  });
  await withRepository(value, async repository => {
    await repository.fetchCommit(value.base);
    const comparison = await repository.verifyComparison({ baseSha: value.base, headSha: value.head, testedSha: value.tested });
    const manifest = await repository.collectManifest(comparison);
    const wide = manifest.entries.filter(entry => entry.newPath === 'wide.txt');
    const capped = await repository.readPatch(comparison, wide, { maxUnitBytes: 256 });
    assert.equal(capped.issue, 'too-large');
    assert.equal(capped.diff, '', 'no truncated prefix is delivered');
    assert.equal(capped.bytes, 0, 'nothing was delivered');
    assert.ok(capped.bytesRead > 256, 'the bytes received are reported, overshoot included');
  });
});

test('the compatibility adapter still reads comparisons with many changed paths', async () => {
  // `collect()` promises the complete diff, so it must not inherit the
  // per-unit pathspec limits that bound a lazily collected unit.
  const value = await fixture(async (work) => {
    const isFeature = await access(join(work, 'feature marker.txt')).then(() => true).catch(() => false);
    if (!isFeature) await writeFile(join(work, 'base.txt'), 'base\n');
    if (!isFeature) return;
    await mkdir(join(work, 'many'), { recursive: true });
    for (let index = 0; index < 300; index++) {
      await writeFile(join(work, 'many', `file-${index}.txt`), `content ${index}\n`);
    }
  });
  await withRepository(value, async repository => {
    await repository.fetchCommit(value.base);
    const changes = await repository.collect({ baseSha: value.base, headSha: value.head,
      testedSha: value.tested, maxDiffBytes: 1_000_000 });
    assert.ok(changes.changedPaths.length > 256, 'more paths than one unit may carry');
    assert.match(changes.diff, /many\/file-299\.txt/);
    assert.equal(changes.diffBytes, Buffer.byteLength(changes.diff));
  });
});

test('an unbounded deadline still lets Git commands run to completion', async () => {
  // Node turns any delay past 2^31-1 into 1ms, so an unclamped "no timeout"
  // would kill every command instantly instead of letting it finish.
  const value = await fixture(async (work) => {
    const isFeature = await access(join(work, 'feature marker.txt')).then(() => true).catch(() => false);
    if (!isFeature) await writeFile(join(work, 'base.txt'), 'base\n');
    if (isFeature) await writeFile(join(work, 'added.txt'), 'added line\n'.repeat(50));
  });
  await withRepository(value, async repository => {
    await repository.fetchCommit(value.base);
    const comparison = await repository.verifyComparison({ baseSha: value.base, headSha: value.head, testedSha: value.tested });
    const manifest = await repository.collectManifest(comparison);
    const entries = manifest.entries.filter(entry => entry.newPath === 'added.txt');
    for (const timeoutMs of [Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER, 2_147_483_648]) {
      const unit = await repository.readPatch(comparison, entries, { maxUnitBytes: 64 * 1024, timeoutMs });
      assert.equal(unit.issue, null, `timeout ${timeoutMs} must not abort the read`);
      assert.match(unit.diff, /\+added line/);
    }
  });
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

test('collects a tested merge tree, reads base metadata, and preserves special paths', async () => {
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
      assert.equal((await repository.readFile(adjusted.base, 'verification scope.md')).toString(), 'Unit verification scope.\n');
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
      assert.equal((await repository.readFile(adjusted.tested, 'verification scope.md')).toString(), 'Unit verification scope.\n');
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

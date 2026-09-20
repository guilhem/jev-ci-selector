import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

export type ChangeErrorCode =
  | 'git-fetch-failed'
  | 'git-read-failed'
  | 'sha-incoherent'
  | 'diff-too-large'
  | 'binary-change'
  | 'submodule-change'
  | 'unrepresentable-change';

const ERROR_MESSAGES: Record<ChangeErrorCode, string> = {
  'git-fetch-failed': 'Unable to fetch the requested commit.',
  'git-read-failed': 'Unable to read the requested Git object.',
  'sha-incoherent': 'The supplied commit relationship is incoherent.',
  'diff-too-large': 'The change set exceeds the configured size limit.',
  'binary-change': 'Binary changes are not supported.',
  'submodule-change': 'Submodule changes are not supported.',
  'unrepresentable-change': 'The change set cannot be represented safely.',
};

export class ChangeError extends Error {
  readonly code: ChangeErrorCode;
  readonly changedPaths?: string[];

  constructor(code: ChangeErrorCode, changedPaths?: string[]) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ChangeError';
    this.code = code;
    if (changedPaths !== undefined) this.changedPaths = [...changedPaths];
  }
}

export interface ChangeSet {
  changedPaths: string[];
  diff: string;
  diffHash: string;
  diffBytes: number;
  diffBaseSha?: string;
}

export type TestedRef = 'head' | 'merge';

export interface GitRepositoryOptions {
  remoteUrl: string;
  token?: string;
  tempRoot?: string;
}

export interface CollectOptions {
  baseSha: string;
  headSha: string;
  testedSha: string;
  maxDiffBytes: number;
  testedRef?: TestedRef;
}

class GitCommandError extends Error {}
class OutputLimitError extends Error {}

const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const ZERO_SHA_PATTERN = /^(?:0{40}|0{64})$/;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_BLOB_BYTES = 16 * 1024 * 1024;
const HISTORY_DEEPEN_STEPS = [32, 128, 512, 2048];
const GIT_TIMEOUT_MS = 120_000;
const COMPLETE_HISTORY_TIMEOUT_MS = 300_000;
const TERMINATION_GRACE_MS = 1_000;

function safeRemoteUrl(remoteUrl: string): boolean {
  try {
    const parsed = new URL(remoteUrl);
    if (parsed.username || parsed.password) return false;
    if (parsed.protocol === 'https:') return true;
    // file:// is intentionally supported for network-free library tests. The
    // production caller validates its trusted GitHub URL before construction.
    return parsed.protocol === 'file:' && (!parsed.hostname || parsed.hostname === 'localhost');
  } catch {
    return false;
  }
}

function validSha(sha: string): boolean {
  return SHA_PATTERN.test(sha);
}

function validLiteralPath(path: string): boolean {
  if (path.length === 0 || path.includes('\0') || path.startsWith('/')) return false;
  const components = path.split('/');
  return components.every((component) => component.length > 0 && component !== '.' && component !== '..');
}

function decodeUtf8(value: Buffer): string | undefined {
  try {
    return utf8Decoder.decode(value);
  } catch {
    return undefined;
  }
}

function isZeroObjectId(value: string): boolean {
  return ZERO_SHA_PATTERN.test(value);
}

function shaForObjectId(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
}

function parseRawDiff(raw: Buffer): Array<{
  oldMode: string;
  newMode: string;
  oldSha: string;
  newSha: string;
  status: string;
  paths: Buffer[];
}> {
  const parts: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] === 0) {
      parts.push(raw.subarray(start, index));
      start = index + 1;
    }
  }
  if (start !== raw.length) throw new ChangeError('unrepresentable-change');

  const entries: Array<{
    oldMode: string;
    newMode: string;
    oldSha: string;
    newSha: string;
    status: string;
    paths: Buffer[];
  }> = [];
  let index = 0;
  while (index < parts.length) {
    const headerPart = parts[index++];
    if (headerPart === undefined) throw new ChangeError('unrepresentable-change');
    const header = headerPart.toString('ascii');
    if (!header.startsWith(':')) throw new ChangeError('unrepresentable-change');
    const fields = header.slice(1).trim().split(/\s+/u);
    if (fields.length !== 5) throw new ChangeError('unrepresentable-change');
    const oldMode = fields[0];
    const newMode = fields[1];
    const oldSha = fields[2];
    const newSha = fields[3];
    const status = fields[4];
    if (
      oldMode === undefined ||
      newMode === undefined ||
      oldSha === undefined ||
      newSha === undefined ||
      status === undefined ||
      !/^\d{6}$/.test(oldMode) ||
      !/^\d{6}$/.test(newMode)
    ) {
      throw new ChangeError('unrepresentable-change');
    }
    if (!shaForObjectId(oldSha) || !shaForObjectId(newSha) || !/^[A-Z][0-9]*$/.test(status)) {
      throw new ChangeError('unrepresentable-change');
    }
    const statusKind = status[0];
    if (statusKind === undefined) throw new ChangeError('unrepresentable-change');
    const pathCount = statusKind === 'R' || statusKind === 'C' ? 2 : 1;
    if (index + pathCount > parts.length) throw new ChangeError('unrepresentable-change');
    const paths = parts.slice(index, index + pathCount);
    index += pathCount;
    entries.push({ oldMode, newMode, oldSha, newSha, status, paths });
  }
  return entries;
}

function rejectBinaryNumstat(numstat: Buffer): void {
  if (numstat.length === 0) return;
  if (numstat[numstat.length - 1] !== 0) throw new ChangeError('unrepresentable-change');
  const tokens = numstat.toString('utf8').slice(0, -1).split('\0');
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    const firstTab = token.indexOf('\t');
    const secondTab = firstTab < 0 ? -1 : token.indexOf('\t', firstTab + 1);
    if (firstTab < 0 || secondTab < 0) throw new ChangeError('unrepresentable-change');
    const added = token.slice(0, firstTab);
    const deleted = token.slice(firstTab + 1, secondTab);
    if (added === '-' || deleted === '-') throw new ChangeError('binary-change');
    if (!/^\d+$/.test(added) || !/^\d+$/.test(deleted)) throw new ChangeError('unrepresentable-change');
    // With -z, a rename has an empty name here followed by two literal paths.
    // A filename beginning "-\t-\t" is a path, never a second stat record.
    if (token.length === secondTab + 1) {
      if (!tokens[index + 1] || !tokens[index + 2]) throw new ChangeError('unrepresentable-change');
      index += 2;
    }
  }
}

function parseCommitParents(commit: Buffer): string[] | undefined {
  const headerEnd = commit.indexOf(Buffer.from('\n\n'));
  if (headerEnd < 0) return undefined;
  const header = commit.subarray(0, headerEnd).toString('ascii');
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (!line.startsWith('parent ')) continue;
    const parent = line.slice('parent '.length);
    if (!validSha(parent)) return undefined;
    parents.push(parent.toLowerCase());
  }
  return parents;
}

export class GitRepository {
  private readonly repoPath: string;
  private readonly workRoot: string;
  private readonly remoteUrl: string;
  private readonly env: NodeJS.ProcessEnv;
  private disposed = false;

  private constructor(workRoot: string, repoPath: string, remoteUrl: string, token?: string) {
    this.workRoot = workRoot;
    this.repoPath = repoPath;
    this.remoteUrl = remoteUrl;
    this.env = GitRepository.gitEnvironment(token, remoteUrl);
  }

  static async create({ remoteUrl, token, tempRoot }: GitRepositoryOptions): Promise<GitRepository> {
    if (!safeRemoteUrl(remoteUrl) || (token !== undefined && /[\r\n]/u.test(token))) {
      throw new ChangeError('git-fetch-failed');
    }

    let workRoot: string | undefined;
    try {
      workRoot = await mkdtemp(join(tempRoot ?? tmpdir(), 'jev-ci-git-'));
      const repoPath = join(workRoot, 'repo.git');
      await GitRepository.runGitFrom(workRoot, GitRepository.gitEnvironment(token, remoteUrl), [
        'init',
        '--bare',
        '--quiet',
        repoPath,
      ]);
      return new GitRepository(workRoot, repoPath, remoteUrl, token);
    } catch {
      if (workRoot) await rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
      throw new ChangeError('git-fetch-failed');
    }
  }

  async fetchCommit(sha: string): Promise<void> {
    this.ensureOpen();
    if (!validSha(sha)) throw new ChangeError('sha-incoherent');
    try {
      await GitRepository.runGitFrom(this.repoPath, this.env, [
        'fetch',
        '--no-tags',
        '--no-write-fetch-head',
        '--force',
        '--depth=1',
        this.remoteUrl,
        sha,
      ]);
      if (!(await this.hasCommit(sha))) throw new GitCommandError('missing commit');
    } catch {
      throw new ChangeError('git-fetch-failed');
    }
  }

  async readFile(sha: string, path: string): Promise<Buffer> {
    this.ensureOpen();
    if (!validSha(sha) || !validLiteralPath(path)) throw new ChangeError('git-read-failed');
    try {
      if (!(await this.hasCommit(sha))) throw new GitCommandError('missing commit');
      return await GitRepository.runGitFrom(
        this.repoPath,
        this.env,
        ['cat-file', 'blob', `${sha}:${path}`],
        MAX_FILE_BYTES,
      );
    } catch {
      throw new ChangeError('git-read-failed');
    }
  }

  async collect({ baseSha, headSha, testedSha, maxDiffBytes, testedRef = 'merge' }: CollectOptions): Promise<ChangeSet> {
    this.ensureOpen();
    if (
      !validSha(baseSha) ||
      !validSha(headSha) ||
      !validSha(testedSha) ||
      (testedRef !== 'head' && testedRef !== 'merge') ||
      (testedRef === 'head' && testedSha !== headSha) ||
      !Number.isSafeInteger(maxDiffBytes) ||
      maxDiffBytes < 0
    ) {
      throw new ChangeError('sha-incoherent');
    }

    // The caller fetches the immutable base before this point. Keeping the
    // base fetch separate means a missing base cannot silently turn into a
    // different remote branch during collection.
    if (!(await this.hasCommit(baseSha))) throw new ChangeError('sha-incoherent');
    if (!(await this.hasCommit(headSha))) await this.fetchCommit(headSha);

    const effectiveTestedSha = testedRef === 'head' ? headSha : testedSha;
    const diffBaseSha = testedRef === 'head' ? await this.findUniqueMergeBase(baseSha, headSha) : baseSha;
    if (testedRef === 'merge') {
      if (!(await this.hasCommit(testedSha))) await this.fetchCommit(testedSha);

      let testedCommit: Buffer;
      try {
        testedCommit = await GitRepository.runGitFrom(
          this.repoPath,
          this.env,
          ['cat-file', 'commit', testedSha],
          MAX_METADATA_BYTES,
        );
      } catch {
        throw new ChangeError('sha-incoherent');
      }
      const parents = parseCommitParents(testedCommit);
      if (!parents || parents.length !== 2 || parents[0] !== baseSha.toLowerCase() || parents[1] !== headSha.toLowerCase()) {
        throw new ChangeError('sha-incoherent');
      }
    }

    let raw: Buffer;
    let numstat: Buffer;
    try {
      [raw, numstat] = await Promise.all([
        GitRepository.runGitFrom(this.repoPath, this.env, [
          'diff',
          '--raw',
          '-z',
          '--full-index',
          '--no-abbrev',
          '-M',
          '--no-ext-diff',
          '--no-textconv',
          diffBaseSha,
          effectiveTestedSha,
          '--',
        ], MAX_METADATA_BYTES),
        GitRepository.runGitFrom(this.repoPath, this.env, [
          'diff',
          '--numstat',
          '-z',
          '-M',
          '--no-ext-diff',
          '--no-textconv',
          diffBaseSha,
          effectiveTestedSha,
          '--',
        ], MAX_METADATA_BYTES),
      ]);
    } catch (error) {
      if (error instanceof OutputLimitError) throw new ChangeError('diff-too-large');
      throw new ChangeError('git-read-failed');
    }

    const entries = parseRawDiff(raw);
    const changedPaths: string[] = [];
    const seenPaths = new Set<string>();
    const blobsToCheck = new Set<string>();
    let hasSubmodule = false;
    for (const entry of entries) {
      if (entry.oldMode === '160000' || entry.newMode === '160000') hasSubmodule = true;
      for (const pathBuffer of entry.paths) {
        const path = decodeUtf8(pathBuffer);
        if (path === undefined || !validLiteralPath(path)) throw new ChangeError('unrepresentable-change');
        if (!seenPaths.has(path)) {
          seenPaths.add(path);
          changedPaths.push(path);
        }
      }
      if (!isZeroObjectId(entry.oldSha)) blobsToCheck.add(entry.oldSha);
      if (!isZeroObjectId(entry.newSha)) blobsToCheck.add(entry.newSha);
    }

    if (hasSubmodule) throw new ChangeError('submodule-change', changedPaths);
    try {
      rejectBinaryNumstat(numstat);
    } catch (error) {
      if (error instanceof ChangeError) throw new ChangeError(error.code, changedPaths);
      throw error;
    }

    for (const blobSha of blobsToCheck) {
      let blob: Buffer;
      try {
        blob = await GitRepository.runGitFrom(
          this.repoPath,
          this.env,
          ['cat-file', 'blob', blobSha],
          MAX_BLOB_BYTES,
        );
      } catch (error) {
        throw new ChangeError(error instanceof OutputLimitError ? 'diff-too-large' : 'git-read-failed', changedPaths);
      }
      if (blob.includes(0)) throw new ChangeError('binary-change', changedPaths);
      if (decodeUtf8(blob) === undefined) throw new ChangeError('unrepresentable-change', changedPaths);
    }

    let patch: Buffer;
    try {
      patch = await GitRepository.runGitFrom(
        this.repoPath,
        this.env,
        [
          'diff',
          '--patch',
          '--full-index',
          '-M',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          diffBaseSha,
          effectiveTestedSha,
          '--',
        ],
        maxDiffBytes,
      );
    } catch (error) {
      if (error instanceof OutputLimitError) throw new ChangeError('diff-too-large', changedPaths);
      throw new ChangeError('git-read-failed');
    }
    if (patch.length > maxDiffBytes) throw new ChangeError('diff-too-large', changedPaths);
    const diff = decodeUtf8(patch);
    if (diff === undefined) throw new ChangeError('unrepresentable-change', changedPaths);
    const diffHash = createHash('sha256').update(patch).digest('hex');
    return {
      changedPaths: changedPaths.sort(),
      diff,
      diffHash,
      diffBytes: patch.length,
      ...(testedRef === 'head' ? { diffBaseSha } : {}),
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await GitRepository.removeTemporaryDirectory(this.workRoot).catch(() => undefined);
  }

  private ensureOpen(): void {
    if (this.disposed) throw new ChangeError('git-read-failed');
  }

  private async hasCommit(sha: string): Promise<boolean> {
    try {
      await GitRepository.runGitFrom(this.repoPath, this.env, ['cat-file', '-e', `${sha}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }

  private async findUniqueMergeBase(baseSha: string, headSha: string): Promise<string> {
    for (const deepenBy of HISTORY_DEEPEN_STEPS) {
      await this.deepenHistory(deepenBy, baseSha, headSha);
      if (!(await this.isShallowRepository())) return this.readUniqueMergeBase(baseSha, headSha);
    }

    await this.fetchCompleteHistory(baseSha, headSha);
    if (await this.isShallowRepository()) throw new ChangeError('git-fetch-failed');
    return this.readUniqueMergeBase(baseSha, headSha);
  }

  private async deepenHistory(deepenBy: number, baseSha: string, headSha: string): Promise<void> {
    try {
      await GitRepository.runGitFrom(this.repoPath, this.env, [
        'fetch',
        '--no-tags',
        '--no-write-fetch-head',
        '--force',
        `--deepen=${deepenBy}`,
        this.remoteUrl,
        baseSha,
        headSha,
      ]);
    } catch {
      throw new ChangeError('git-fetch-failed');
    }
  }

  private async fetchCompleteHistory(baseSha: string, headSha: string): Promise<void> {
    try {
      await GitRepository.runGitFrom(this.repoPath, this.env, [
        'fetch',
        '--no-tags',
        '--no-write-fetch-head',
        '--force',
        '--unshallow',
        this.remoteUrl,
        baseSha,
        headSha,
      ], undefined, COMPLETE_HISTORY_TIMEOUT_MS);
    } catch { /* Try the exact object IDs with a complete depth below. */ }
    if (!(await this.isShallowRepository())) return;
    try {
      await GitRepository.runGitFrom(this.repoPath, this.env, [
        'fetch',
        '--no-tags',
        '--no-write-fetch-head',
        '--force',
        '--depth=2147483647',
        this.remoteUrl,
        baseSha,
        headSha,
      ], undefined, COMPLETE_HISTORY_TIMEOUT_MS);
    } catch {
      throw new ChangeError('git-fetch-failed');
    }
  }

  private async isShallowRepository(): Promise<boolean> {
    try {
      const output = await GitRepository.runGitFrom(this.repoPath, this.env, ['rev-parse', '--is-shallow-repository']);
      const value = output.toString('ascii').trim();
      if (value !== 'true' && value !== 'false') throw new GitCommandError('invalid shallow state');
      return value === 'true';
    } catch {
      throw new ChangeError('git-read-failed');
    }
  }

  private async readUniqueMergeBase(baseSha: string, headSha: string): Promise<string> {
    let output: Buffer;
    try {
      output = await GitRepository.runGitFrom(this.repoPath, this.env, ['merge-base', '--all', baseSha, headSha], MAX_METADATA_BYTES);
    } catch {
      throw new ChangeError('sha-incoherent');
    }
    const mergeBases = output.toString('ascii').trim().split(/\s+/u).filter(Boolean);
    if (mergeBases.length !== 1 || !validSha(mergeBases[0]!)) throw new ChangeError('sha-incoherent');
    return mergeBases[0]!.toLowerCase();
  }

  private static gitEnvironment(token: string | undefined, remoteUrl: string): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!/^GIT_/u.test(key)) environment[key] = value;
    }
    const config: Array<[string, string]> = [
      ['core.attributesFile', '/dev/null'],
      ['core.hooksPath', '/dev/null'],
      ['init.templateDir', '/dev/null'],
      ['diff.external', ''],
      ['http.followRedirects', 'false'],
    ];
    if (token !== undefined && token.length > 0 && remoteUrl.startsWith('https:')) {
      const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
      config.unshift(['http.extraheader', `Authorization: Basic ${basic}`]);
    }
    environment.GIT_CONFIG_NOSYSTEM = '1';
    environment.GIT_CONFIG_SYSTEM = '/dev/null';
    environment.GIT_CONFIG_GLOBAL = '/dev/null';
    environment.GIT_ATTR_NOSYSTEM = '1';
    environment.GIT_TERMINAL_PROMPT = '0';
    environment.GIT_PAGER = 'cat';
    environment.GIT_OPTIONAL_LOCKS = '0';
    environment.LC_ALL = 'C';
    environment.LANG = 'C';
    environment.TZ = 'UTC';
    environment.GIT_CONFIG_COUNT = String(config.length);
    config.forEach(([key, value], index) => {
      environment[`GIT_CONFIG_KEY_${index}`] = key;
      environment[`GIT_CONFIG_VALUE_${index}`] = value;
    });
    return environment;
  }

  private static runGitFrom(
    cwd: string,
    env: NodeJS.ProcessEnv,
    args: string[],
    maxStdoutBytes?: number,
    timeoutMs = GIT_TIMEOUT_MS,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn('git', args, {
          cwd,
          env,
          stdio: ['ignore', 'pipe', 'ignore'],
          detached: process.platform !== 'win32',
        });
      } catch {
        reject(new GitCommandError('spawn failed'));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      let termination: 'output-limit' | 'timeout' | undefined;
      let settled = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
      let killHandle: NodeJS.Timeout | undefined;

      const clearTimers = () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (killHandle) clearTimeout(killHandle);
      };
      const sendSignal = (signal: NodeJS.Signals) => {
        if (child.pid === undefined) return;
        if (process.platform !== 'win32') {
          try {
            process.kill(-child.pid, signal);
            return;
          } catch { /* Fall through to the direct child on races or unsupported process groups. */ }
        }
        try { child.kill(signal); } catch { /* The child may have exited already. */ }
      };
      const terminate = (reason: 'output-limit' | 'timeout') => {
        if (termination || settled) return;
        termination = reason;
        sendSignal('SIGTERM');
        killHandle = setTimeout(() => {
          if (!settled) sendSignal('SIGKILL');
        }, TERMINATION_GRACE_MS);
      };
      const finish = (error?: Error, value?: Buffer) => {
        if (settled) return;
        settled = true;
        clearTimers();
        if (error) reject(error);
        else resolve(value ?? Buffer.alloc(0));
      };

      timeoutHandle = setTimeout(() => terminate('timeout'), Math.max(1, timeoutMs));
      child.stdout.on('data', (chunk: Buffer) => {
        if (termination) return;
        bytes += chunk.length;
        if (maxStdoutBytes !== undefined && bytes > maxStdoutBytes) {
          terminate('output-limit');
          return;
        }
        chunks.push(chunk);
      });
      child.once('error', () => {
        if (!settled) {
          finish(termination === 'timeout'
            ? new GitCommandError('git timed out')
            : termination === 'output-limit'
              ? new OutputLimitError('output limit')
              : new GitCommandError('git failed'));
        }
      });
      child.once('close', (code) => {
        if (settled) return;
        if (termination === 'timeout') finish(new GitCommandError('git timed out'));
        else if (termination === 'output-limit') finish(new OutputLimitError('output limit'));
        else if (code !== 0) finish(new GitCommandError('git failed'));
        else finish(undefined, Buffer.concat(chunks));
      });
    });
  }

  private static readonly removeTemporaryDirectory = async (path: string): Promise<void> => {
    await rm(path, { recursive: true, force: true });
  };
}

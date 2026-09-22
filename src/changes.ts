import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { MANIFEST_BYTES } from './budget.js';

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

/**
 * A comparison whose SHAs, merge relationship and immutability have been
 * checked. Every later read is expressed against this value, so no step can
 * silently drift onto a different remote state.
 */
export interface VerifiedComparison {
  baseSha: string;
  headSha: string;
  /** Left side of the diff: the base, or the unique merge base for `head`. */
  diffBaseSha: string;
  /** Right side of the diff: the tested merge, or the head commit. */
  testedSha: string;
  testedRef: TestedRef;
}

export type EntryIssueCode = 'submodule' | 'binary' | 'too-large' | 'unrepresentable' | 'git-read-failed';

/** One inventoried change. Names and object ids only; never file content. */
export interface ChangeEntry {
  id: string;
  oldPath: string | null;
  newPath: string | null;
  oldOid: string | null;
  newOid: string | null;
  oldMode: string | null;
  newMode: string | null;
  status: string;
  /** Set when the entry cannot be turned into reviewable text at all. */
  issue: EntryIssueCode | null;
}

/**
 * The complete inventory of a comparison. `complete` is false whenever the
 * inventory itself hit a limit: a partial inventory can never justify a new
 * exclusion, and `manifestHash` stays null so nothing downstream can pretend
 * the change set was fully enumerated.
 */
export interface ChangeManifest {
  comparison: VerifiedComparison;
  entries: readonly ChangeEntry[];
  changedPaths: readonly string[];
  complete: boolean;
  manifestHash: string | null;
}

/** A bounded slice of patch text, collected on demand for named entries. */
export interface PatchUnit {
  changeIds: string[];
  paths: string[];
  diff: string;
  /** Bytes of the complete patch delivered; 0 whenever `issue` is set. */
  bytes: number;
  /**
   * Bytes Git really produced for this attempt, including one that was then
   * rejected. For an interrupted read this is a lower bound, never exact.
   */
  bytesRead: number;
  issue: EntryIssueCode | null;
}

export interface ReadPatchLimits {
  /** Hard ceiling for this unit's stdout, enforced before any allocation. */
  maxUnitBytes: number;
  /** Ceiling for either side's blob, checked from object metadata first. */
  maxBlobBytes?: number;
  renames?: boolean;
  timeoutMs?: number;
}

export type TestedRef = 'head' | 'merge';

export interface GitRepositoryOptions {
  remoteUrl: string;
  token?: string;
  tempRoot?: string;
}

export interface VerifyComparisonOptions {
  baseSha: string;
  headSha: string;
  testedSha: string;
  testedRef?: TestedRef;
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
const MAX_MANIFEST_ENTRIES = 50_000;
const MAX_UNIT_PATHS = 256;
const MAX_UNIT_PATHSPEC_BYTES = 64 * 1024;
const LEGACY_ISSUE_CODES: Record<EntryIssueCode, ChangeErrorCode> = {
  submodule: 'submodule-change',
  binary: 'binary-change',
  'too-large': 'diff-too-large',
  unrepresentable: 'unrepresentable-change',
  'git-read-failed': 'git-read-failed',
};
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


/**
 * Structural binary detection on collected patch text.
 *
 * Only lines outside a hunk body are inspected. Inside a hunk every content
 * line carries a ' ', '+' or '-' prefix, so hostile file content can never be
 * mistaken for Git's own top-level binary marker.
 */
function patchIsBinary(diff: string): boolean {
  let inHunk = false;
  for (const raw of diff.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.startsWith('diff --git ')) { inHunk = false; continue; }
    if (line.startsWith('@@ ')) { inHunk = true; continue; }
    if (inHunk) continue;
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') return true;
  }
  return false;
}

function entriesFrom(raw: ReturnType<typeof parseRawDiff>): ChangeEntry[] {
  return raw.map((entry, index) => {
    const paths = entry.paths.map(buffer => {
      const path = decodeUtf8(buffer);
      if (path === undefined || !validLiteralPath(path)) throw new ChangeError('unrepresentable-change');
      return path;
    });
    const kind = entry.status[0]!;
    const twoPaths = paths.length === 2;
    const oldPath = kind === 'A' ? null : paths[0]!;
    const newPath = kind === 'D' ? null : twoPaths ? paths[1]! : paths[0]!;
    const submodule = entry.oldMode === '160000' || entry.newMode === '160000';
    return {
      id: `c${index}`,
      oldPath,
      newPath,
      oldOid: isZeroObjectId(entry.oldSha) ? null : entry.oldSha.toLowerCase(),
      newOid: isZeroObjectId(entry.newSha) ? null : entry.newSha.toLowerCase(),
      oldMode: entry.oldMode === '000000' ? null : entry.oldMode,
      newMode: entry.newMode === '000000' ? null : entry.newMode,
      status: entry.status,
      issue: submodule ? 'submodule' as const : null,
    };
  });
}

/** Deterministic identity of an inventory: names, modes and object ids only. */
function manifestDigest(comparison: VerifiedComparison, entries: readonly ChangeEntry[]): string {
  const canonical = JSON.stringify({
    diff_base_sha: comparison.diffBaseSha,
    tested_sha: comparison.testedSha,
    entries: entries.map(entry => [entry.status, entry.oldPath, entry.newPath, entry.oldMode, entry.newMode, entry.oldOid, entry.newOid]),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function changedPathsOf(entries: readonly ChangeEntry[]): string[] {
  const paths = new Set<string>();
  for (const entry of entries) {
    if (entry.oldPath !== null) paths.add(entry.oldPath);
    if (entry.newPath !== null) paths.add(entry.newPath);
  }
  return [...paths].sort();
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

  async listFiles(sha: string): Promise<string[]> {
    this.ensureOpen();
    if (!validSha(sha)) throw new ChangeError('git-read-failed');
    try {
      const output = await GitRepository.runGitFrom(this.repoPath, this.env,
        ['ls-tree', '-r', '--name-only', '-z', sha], MAX_METADATA_BYTES);
      const paths = utf8Decoder.decode(output).split('\0');
      if (paths.pop() !== '' || paths.some(path => !validLiteralPath(path))) throw new Error('invalid-tree');
      return paths.sort();
    } catch { throw new ChangeError('git-read-failed'); }
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

  /**
   * Check the supplied commit relationship before anything is read.
   *
   * Keeps the existing merge-base, merge-parent and immutable-reference rules:
   * a comparison that cannot be verified never becomes a usable manifest.
   */
  async verifyComparison({ baseSha, headSha, testedSha, testedRef = 'merge' }: VerifyComparisonOptions): Promise<VerifiedComparison> {
    this.ensureOpen();
    if (
      !validSha(baseSha) ||
      !validSha(headSha) ||
      !validSha(testedSha) ||
      (testedRef !== 'head' && testedRef !== 'merge') ||
      (testedRef === 'head' && testedSha !== headSha)
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
    return { baseSha, headSha, diffBaseSha, testedSha: effectiveTestedSha, testedRef };
  }

  /**
   * Inventory the comparison without reading a single byte of file content.
   *
   * This is names, modes and object ids from `diff --raw`; no `numstat`, no
   * similarity search, no blob read and no patch. Rename detection is off by
   * default: a rename then appears as a deletion plus an addition, which keeps
   * both paths visible to the path-based safety rules. Renames can be enriched
   * later, at a bounded cost, only where they help an actual observation.
   */
  async collectManifest(comparison: VerifiedComparison, options: { renames?: boolean } = {}): Promise<ChangeManifest> {
    this.ensureOpen();
    let raw: Buffer;
    let complete = true;
    try {
      raw = await GitRepository.runGitFrom(this.repoPath, this.env, [
        '--literal-pathspecs',
        'diff',
        '--raw',
        '-z',
        '--full-index',
        '--no-abbrev',
        options.renames === true ? '-M' : '--no-renames',
        '--no-ext-diff',
        '--no-textconv',
        comparison.diffBaseSha,
        comparison.testedSha,
        '--',
      ], MANIFEST_BYTES);
    } catch (error) {
      if (!(error instanceof OutputLimitError)) throw new ChangeError('git-read-failed');
      // A truncated inventory is reported as incomplete rather than guessed at.
      complete = false;
      raw = Buffer.alloc(0);
    }

    const entries = complete ? entriesFrom(parseRawDiff(raw)) : [];
    if (entries.length > MAX_MANIFEST_ENTRIES) complete = false;
    return {
      comparison,
      entries,
      changedPaths: changedPathsOf(entries),
      complete,
      manifestHash: complete ? manifestDigest(comparison, entries) : null,
    };
  }

  /**
   * Collect the patch text for one bounded unit of entries.
   *
   * Object sizes are pre-checked from metadata, so an oversized blob is refused
   * before Git is asked to render it. Output is capped before allocation, and a
   * unit that exceeds its cap yields an issue rather than a truncated prefix:
   * a partial patch is never passed on as if it were a complete one.
   */
  async readPatch(comparison: VerifiedComparison, entries: readonly ChangeEntry[], limits: ReadPatchLimits): Promise<PatchUnit> {
    this.ensureOpen();
    const paths = changedPathsOf(entries);
    const unit: PatchUnit = { changeIds: entries.map(entry => entry.id), paths, diff: '', bytes: 0, bytesRead: 0, issue: null };
    if (!Number.isSafeInteger(limits.maxUnitBytes) || limits.maxUnitBytes <= 0) return { ...unit, issue: 'too-large' };
    const blocked = entries.find(entry => entry.issue !== null);
    if (blocked) return { ...unit, issue: blocked.issue };
    if (!paths.length) return unit;
    if (paths.length > MAX_UNIT_PATHS || paths.reduce((total, path) => total + Buffer.byteLength(path) + 1, 0) > MAX_UNIT_PATHSPEC_BYTES) {
      return { ...unit, issue: 'too-large' };
    }

    const maxBlobBytes = limits.maxBlobBytes ?? MAX_BLOB_BYTES;
    const oids = [...new Set(entries.flatMap(entry => [entry.oldOid, entry.newOid]).filter((oid): oid is string => oid !== null))];
    if (oids.length) {
      let sizes: Map<string, number>;
      try {
        sizes = await this.objectSizes(oids);
      } catch {
        return { ...unit, issue: 'git-read-failed' };
      }
      // An object size bounds the input, never the rendered patch. It is used
      // only to refuse work that certainly cannot fit.
      for (const oid of oids) {
        const size = sizes.get(oid);
        if (size === undefined) return { ...unit, issue: 'git-read-failed' };
        if (size > maxBlobBytes) return { ...unit, issue: 'too-large' };
      }
    }

    let patch: Buffer;
    try {
      patch = await GitRepository.runGitFrom(this.repoPath, this.env, [
        '--literal-pathspecs',
        'diff',
        '--patch',
        '--full-index',
        limits.renames === true ? '-M' : '--no-renames',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        comparison.diffBaseSha,
        comparison.testedSha,
        '--',
        ...paths,
      ], limits.maxUnitBytes, limits.timeoutMs);
    } catch (error) {
      // An interrupted read still cost the bytes Git emitted before the kill.
      // The cap is the only lower bound available for it.
      if (error instanceof OutputLimitError) return { ...unit, issue: 'too-large', bytesRead: limits.maxUnitBytes };
      return { ...unit, issue: 'git-read-failed' };
    }
    if (patch.length > limits.maxUnitBytes) return { ...unit, issue: 'too-large', bytesRead: limits.maxUnitBytes };
    // Everything below was produced in full, so it is charged in full even when
    // the result is rejected.
    const read = { ...unit, bytesRead: patch.length };
    if (patch.includes(0)) return { ...read, issue: 'binary' };
    const diff = decodeUtf8(patch);
    if (diff === undefined) return { ...read, issue: 'unrepresentable' };
    if (patchIsBinary(diff)) return { ...read, issue: 'binary' };
    return { ...read, diff, bytes: patch.length };
  }

  /** Object sizes from metadata alone: no content is streamed. */
  private async objectSizes(oids: readonly string[]): Promise<Map<string, number>> {
    for (const oid of oids) if (!shaForObjectId(oid)) throw new ChangeError('git-read-failed');
    const output = await GitRepository.runGitFrom(
      this.repoPath,
      this.env,
      ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
      MAX_METADATA_BYTES,
      undefined,
      `${oids.join('\n')}\n`,
    );
    const sizes = new Map<string, number>();
    for (const line of output.toString('ascii').split('\n')) {
      if (!line) continue;
      const [name, type, size] = line.split(' ');
      if (name === undefined || type !== 'blob' || size === undefined || !/^\d+$/.test(size)) continue;
      sizes.set(name.toLowerCase(), Number(size));
    }
    return sizes;
  }

  /**
   * Compatibility adapter over the operations above.
   *
   * It still returns one whole-diff `ChangeSet` for historical callers and
   * tests. New code uses `verifyComparison` + `collectManifest` + `readPatch`
   * so that a decision can be reached without ever building a global diff.
   */
  async collect({ baseSha, headSha, testedSha, maxDiffBytes, testedRef = 'merge' }: CollectOptions): Promise<ChangeSet> {
    if (!Number.isSafeInteger(maxDiffBytes) || maxDiffBytes < 0) throw new ChangeError('sha-incoherent');
    const comparison = await this.verifyComparison({ baseSha, headSha, testedSha, testedRef });
    const manifest = await this.collectManifest(comparison, { renames: true });
    if (!manifest.complete) throw new ChangeError('diff-too-large');
    const changedPaths = [...manifest.changedPaths];
    const submodule = manifest.entries.find(entry => entry.issue === 'submodule');
    if (submodule) throw new ChangeError('submodule-change', changedPaths);

    const unit = await this.readPatch(comparison, manifest.entries, {
      maxUnitBytes: Math.max(1, maxDiffBytes),
      renames: true,
    });
    if (unit.issue !== null) throw new ChangeError(LEGACY_ISSUE_CODES[unit.issue], changedPaths);
    return {
      changedPaths,
      diff: unit.diff,
      diffHash: createHash('sha256').update(unit.diff, 'utf8').digest('hex'),
      diffBytes: unit.bytes,
      ...(testedRef === 'head' ? { diffBaseSha: comparison.diffBaseSha } : {}),
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
    input?: string,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn('git', args, {
          cwd,
          env,
          stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
          detached: process.platform !== 'win32',
        });
      } catch {
        reject(new GitCommandError('spawn failed'));
        return;
      }
      if (input !== undefined) {
        child.stdin?.on('error', () => { /* The child may exit before the batch is written. */ });
        child.stdin?.end(input);
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
      child.stdout!.on('data', (chunk: Buffer) => {
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

import { TextDecoder } from 'node:util';

export interface DiffChunk {
  diff: string;
  context: string;
  startByte: number;
  endByte: number;
  paths: string[];
}

export type ChunkErrorCode =
  | 'invalid-budget'
  | 'context-too-large'
  | 'line-too-large'
  | 'unparseable-diff';

export class ChunkError extends Error {
  readonly code: ChunkErrorCode;

  constructor(code: ChunkErrorCode, message: string) {
    super(message);
    this.name = 'ChunkError';
    this.code = code;
  }
}

interface DiffLine {
  startChar: number;
  endChar: number;
  startByte: number;
  endByte: number;
  text: string;
}

interface Hunk {
  header: number;
  bodyStart: number;
  bodyEnd: number;
}

interface DiffFile {
  startLine: number;
  endLine: number;
  startChar: number;
  endChar: number;
  startByte: number;
  endByte: number;
  paths: string[];
  hunkHeaders: Set<number>;
  hunks: Hunk[];
  groupKey: string;
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/u;
const NO_NEWLINE_MARKER = '\\ No newline at end of file';

function unparseable(message: string): never {
  throw new ChunkError('unparseable-diff', message);
}

function byteOffsets(value: string): number[] {
  const offsets = new Array<number>(value.length + 1).fill(0);
  let byteCount = 0;
  let index = 0;
  while (index < value.length) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) unparseable('Diff contains an invalid Unicode code point.');
    const width = codePoint > 0xffff ? 2 : 1;
    if (width === 1 && codePoint >= 0xd800 && codePoint <= 0xdfff) {
      unparseable('Diff contains an unpaired UTF-16 surrogate.');
    }
    const text = value.slice(index, index + width);
    offsets[index] = byteCount;
    if (width === 2) offsets[index + 1] = byteCount;
    byteCount += Buffer.byteLength(text, 'utf8');
    offsets[index + width] = byteCount;
    index += width;
  }
  return offsets;
}

function linesOf(value: string, offsets: number[]): DiffLine[] {
  const lines: DiffLine[] = [];
  let startChar = 0;
  while (startChar < value.length) {
    const newline = value.indexOf('\n', startChar);
    const endChar = newline < 0 ? value.length : newline + 1;
    lines.push({
      startChar,
      endChar,
      startByte: offsets[startChar]!,
      endByte: offsets[endChar]!,
      text: value.slice(startChar, endChar),
    });
    startChar = endChar;
  }
  return lines;
}

function lineContent(line: DiffLine): string {
  return line.text.endsWith('\n') ? line.text.slice(0, -1) : line.text;
}

function isFileHeader(line: DiffLine): boolean {
  return lineContent(line).startsWith('diff --git ');
}

function isWhitespace(value: string): boolean {
  return value === ' ' || value === '\t';
}

function utf8FromBytes(bytes: number[]): string {
  try {
    return utf8Decoder.decode(Buffer.from(bytes));
  } catch {
    return unparseable('Git path contains invalid UTF-8.');
  }
}

function appendUtf8(bytes: number[], value: string): void {
  for (const byte of Buffer.from(value, 'utf8')) bytes.push(byte);
}

function parseGitToken(value: string, start: number): { value: string; end: number } {
  if (start >= value.length) unparseable('Missing Git path token.');
  if (value[start] !== '"') {
    let end = start;
    while (end < value.length && !isWhitespace(value[end]!)) end += 1;
    if (end === start) unparseable('Empty Git path token.');
    return { value: value.slice(start, end), end };
  }

  const bytes: number[] = [];
  let index = start + 1;
  while (index < value.length) {
    const character = value[index]!;
    if (character === '"') return { value: utf8FromBytes(bytes), end: index + 1 };
    if (character !== '\\') {
      const codePoint = value.codePointAt(index);
      if (codePoint === undefined) unparseable('Malformed quoted Git path.');
      const width = codePoint > 0xffff ? 2 : 1;
      appendUtf8(bytes, value.slice(index, index + width));
      index += width;
      continue;
    }

    index += 1;
    if (index >= value.length) unparseable('Unterminated Git path escape.');
    const escaped = value[index]!;
    const simpleEscapes: Record<string, number> = {
      a: 0x07,
      b: 0x08,
      t: 0x09,
      n: 0x0a,
      v: 0x0b,
      f: 0x0c,
      r: 0x0d,
      '\\': 0x5c,
      '"': 0x22,
    };
    const simple = simpleEscapes[escaped];
    if (simple !== undefined) {
      bytes.push(simple);
      index += 1;
      continue;
    }
    if (!/[0-7]/u.test(escaped)) unparseable('Unknown Git path escape.');
    let octal = escaped;
    index += 1;
    for (let count = 1; count < 3 && index < value.length && /[0-7]/u.test(value[index]!); count += 1) {
      octal += value[index]!;
      index += 1;
    }
    bytes.push(Number.parseInt(octal, 8));
  }
  unparseable('Unterminated quoted Git path.');
}

function parseDiffHeader(line: DiffLine): string[][] {
  const content = lineContent(line);
  if (!content.startsWith('diff --git ')) unparseable('Expected a Git diff file header.');
  const rest = content.slice('diff --git '.length);
  let candidates: string[][];
  if (rest.startsWith('"')) {
    const first = parseGitToken(rest, 0);
    let separator = first.end;
    while (separator < rest.length && isWhitespace(rest[separator]!)) separator += 1;
    const second = parseGitToken(rest, separator);
    let trailing = second.end;
    while (trailing < rest.length && isWhitespace(rest[trailing]!)) trailing += 1;
    if (trailing !== rest.length) unparseable('Git diff file header has trailing path data.');
    candidates = [[first.value, second.value]];
  } else {
    // Git leaves ordinary spaces unquoted. The b/ prefix is therefore the
    // delimiter between the two header paths rather than whitespace alone. A
    // path can itself contain " b/", so retain every possible split until the
    // ---/+++ or rename metadata disambiguates it.
    candidates = [];
    for (let separator = rest.indexOf(' b/'); separator >= 0; separator = rest.indexOf(' b/', separator + 1)) {
      if (separator > 0) candidates.push([rest.slice(0, separator), rest.slice(separator + 1)]);
    }
    if (candidates.length === 0) unparseable('Git diff file header must contain two paths.');
  }
  for (const candidate of candidates) {
    if (!candidate[0]!.startsWith('a/') || !candidate[1]!.startsWith('b/')) {
      unparseable('Git diff file header has invalid path prefixes.');
    }
  }
  return candidates;
}

function parsePathMetadata(line: DiffLine, prefix: string, expectedPrefix: string): string {
  const content = lineContent(line).slice(prefix.length);
  const unquoted = content.endsWith('\t') ? content.slice(0, -1) : content;
  const token = unquoted.startsWith('"') ? parseGitToken(unquoted, 0) : { value: unquoted, end: unquoted.length };
  if (token.end !== unquoted.length || token.value.length === 0 || token.value.includes('\0')) {
    unparseable('Git path metadata has invalid path data.');
  }
  if (token.value !== '/dev/null' && !token.value.startsWith(expectedPrefix)) {
    unparseable('Git path metadata has an invalid path prefix.');
  }
  return token.value;
}

function parseRenameMetadata(line: DiffLine, prefix: string): string {
  const content = lineContent(line).slice(prefix.length);
  const token = content.startsWith('"') ? parseGitToken(content, 0) : { value: content, end: content.length };
  if (token.end !== content.length || token.value.length === 0 || token.value.includes('\0')) {
    unparseable('Git rename metadata has invalid path data.');
  }
  return token.value;
}

function parseHunkHeader(line: DiffLine): { oldCount: number; newCount: number } {
  const match = HUNK_HEADER.exec(lineContent(line));
  if (!match) unparseable('Malformed Git hunk header.');
  const oldCount = match[2] === undefined ? 1 : Number(match[2]);
  const newCount = match[4] === undefined ? 1 : Number(match[4]);
  if (!Number.isSafeInteger(oldCount) || !Number.isSafeInteger(newCount)) {
    unparseable('Git hunk line counts are too large.');
  }
  return { oldCount, newCount };
}

function parseFile(lines: DiffLine[], startLine: number, endLine: number, candidates: string[][]): DiffFile {
  const hunkHeaders = new Set<number>();
  const hunks: Hunk[] = [];
  let index = startLine + 1;
  let sawPatchPath = false;
  let oldPatchPath: string | undefined;
  let newPatchPath: string | undefined;
  let renameFrom: string | undefined;
  let renameTo: string | undefined;
  while (index < endLine) {
    const content = lineContent(lines[index]!);
    if (content.startsWith('@@ ')) {
      const counts = parseHunkHeader(lines[index]!);
      const bodyStart = index + 1;
      let oldLines = 0;
      let newLines = 0;
      index = bodyStart;
      while (index < endLine) {
        const body = lineContent(lines[index]!);
        if (body.startsWith('@@ ') || isFileHeader(lines[index]!)) break;
        if (body === NO_NEWLINE_MARKER) {
          index += 1;
          continue;
        }
        const marker = body[0];
        if (marker !== ' ' && marker !== '+' && marker !== '-') {
          unparseable('Git hunk contains a line without a valid prefix.');
        }
        if (marker === ' ' || marker === '-') oldLines += 1;
        if (marker === ' ' || marker === '+') newLines += 1;
        index += 1;
      }
      if (oldLines !== counts.oldCount || newLines !== counts.newCount) {
        unparseable('Git hunk line counts do not match its body.');
      }
      const header = bodyStart - 1;
      hunkHeaders.add(header);
      hunks.push({ header, bodyStart, bodyEnd: index });
      continue;
    }
    if (content.startsWith('--- ')) {
      oldPatchPath = parsePathMetadata(lines[index]!, '--- ', 'a/');
      sawPatchPath = true;
    } else if (content.startsWith('+++ ')) {
      newPatchPath = parsePathMetadata(lines[index]!, '+++ ', 'b/');
      sawPatchPath = true;
    } else if (content.startsWith('rename from ')) {
      renameFrom = parseRenameMetadata(lines[index]!, 'rename from ');
    } else if (content.startsWith('rename to ')) {
      renameTo = parseRenameMetadata(lines[index]!, 'rename to ');
    } else if (content.startsWith('copy from ')) {
      parseRenameMetadata(lines[index]!, 'copy from ');
    } else if (content.startsWith('copy to ')) {
      parseRenameMetadata(lines[index]!, 'copy to ');
    } else if (content === NO_NEWLINE_MARKER || content.startsWith('diff --git ')) {
      unparseable('Unexpected Git diff structure.');
    } else if (
      content.startsWith('old mode ') || content.startsWith('new mode ') ||
      content.startsWith('new file mode ') || content.startsWith('deleted file mode ') ||
      content.startsWith('similarity index ') || content.startsWith('dissimilarity index ') ||
      content.startsWith('index ') || content === 'GIT binary patch' ||
      content.startsWith('literal ') || content.startsWith('delta ') ||
      content.startsWith('Binary files ')
    ) {
      // Git metadata and binary patch payloads are kept as source lines. The
      // repository collector rejects binary changes before this function is used
      // for provider evaluation, but mode-only and rename patches are valid here.
    } else {
      unparseable('Unexpected line in Git diff file.');
    }
    index += 1;
  }
  if (hunks.length > 0 && !sawPatchPath) {
    // Git always emits ---/+++ before a textual hunk. Requiring them prevents a
    // syntactically plausible arbitrary text blob from being treated as a patch.
    unparseable('Git textual hunk is missing ---/+++ paths.');
  }
  const expectedOld = renameFrom ?? (oldPatchPath?.startsWith('a/') ? oldPatchPath.slice(2) : undefined);
  const expectedNew = renameTo ?? (newPatchPath?.startsWith('b/') ? newPatchPath.slice(2) : undefined);
  const selected = candidates.find(candidate => {
    const oldPath = candidate[0]!.slice(2);
    const newPath = candidate[1]!.slice(2);
    return (expectedOld === undefined || expectedOld === oldPath) && (expectedNew === undefined || expectedNew === newPath);
  });
  if (selected === undefined) unparseable('Git diff file header paths disagree with its metadata.');
  const paths = [selected[0]!.slice(2), selected[1]!.slice(2)]
    .filter((path, pathIndex, all) => path.length > 0 && all.indexOf(path) === pathIndex);
  if (paths.length === 0 || paths.some(path => path.includes('\0'))) unparseable('Git diff file header has an invalid path.');
  return {
    startLine,
    endLine,
    startChar: lines[startLine]!.startChar,
    endChar: lines[endLine - 1]!.endChar,
    startByte: lines[startLine]!.startByte,
    endByte: lines[endLine - 1]!.endByte,
    paths,
    hunkHeaders,
    hunks,
    groupKey: '',
  };
}

function parseDiff(value: string, lines: DiffLine[]): DiffFile[] {
  if (lines.length === 0) return [];
  if (!isFileHeader(lines[0]!)) unparseable('Git diff must start with a diff --git header.');
  const starts: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (isFileHeader(lines[index]!)) starts.push(index);
  }
  const files: DiffFile[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const startLine = starts[index]!;
    const endLine = starts[index + 1] ?? lines.length;
    const candidates = parseDiffHeader(lines[startLine]!);
    files.push(parseFile(lines, startLine, endLine, candidates));
  }
  if (files[files.length - 1]?.endChar !== value.length) {
    unparseable('Git diff contains bytes outside its file sections.');
  }
  return files;
}

function normalizeDirectory(value: string): string | undefined {
  const normalized = value.replace(/^\.\//u, '').replace(/\/+$/u, '');
  if (normalized === '') return '.';
  if (normalized === '.' || normalized.includes('\0')) return normalized === '.' ? '.' : undefined;
  if (normalized.split('/').some(part => part === '' || part === '..')) return undefined;
  return normalized;
}

function isUnder(path: string, directory: string): boolean {
  return directory === '.' || path === directory || path.startsWith(`${directory}/`);
}

function treeDirectory(path: string): string {
  const slash = path.lastIndexOf('/');
  const directory = slash < 0 ? '.' : path.slice(0, slash);
  const first = directory.indexOf('/');
  return first < 0 ? directory : directory.slice(0, first);
}

function assignGroupKeys(files: DiffFile[], workingDirectories: string[] | undefined): void {
  const hints = [...new Set((workingDirectories ?? []).map(normalizeDirectory).filter((value): value is string => value !== undefined))]
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
  for (const file of files) {
    const hint = hints.find(directory => file.paths.some(path => isUnder(path, directory)));
    file.groupKey = hint === undefined ? `tree:${treeDirectory(file.paths[0]!)}` : `workdir:${hint}`;
  }
}

function continuationContext(lines: DiffLine[], file: DiffFile, startLine: number): string {
  if (startLine === file.startLine) return '';
  const header = lines[file.startLine]!.text;
  let hunkHeader: DiffLine | undefined;
  for (const hunk of file.hunks) {
    if (hunk.header < startLine) hunkHeader = lines[hunk.header];
    else break;
  }
  return `${header}${hunkHeader?.text ?? ''}`;
}

function splitLargeFile(value: string, lines: DiffLine[], file: DiffFile, maxBytes: number): DiffChunk[] {
  const result: DiffChunk[] = [];
  let startLine = file.startLine;
  while (startLine < file.endLine) {
    const context = continuationContext(lines, file, startLine);
    const contextBytes = Buffer.byteLength(context, 'utf8');
    if (contextBytes >= maxBytes) throw new ChunkError('context-too-large', 'Continuation context leaves no room for diff bytes.');
    const availableBytes = maxBytes - contextBytes;
    let endLine = startLine;
    let preferredEndLine: number | undefined;
    while (endLine < file.endLine) {
      const line = lines[endLine]!;
      if (line.endByte - line.startByte > availableBytes && endLine === startLine) {
        throw new ChunkError('line-too-large', 'A complete Git diff line does not fit the chunk budget.');
      }
      if (line.endByte - lines[startLine]!.startByte > availableBytes) break;
      endLine += 1;
      if (endLine < file.endLine && file.hunkHeaders.has(endLine)) preferredEndLine = endLine;
    }
    if (endLine === startLine) throw new ChunkError('line-too-large', 'Unable to advance without cutting a Git diff line.');
    if (endLine < file.endLine && preferredEndLine !== undefined && preferredEndLine > startLine) endLine = preferredEndLine;
    const startByte = lines[startLine]!.startByte;
    const endByte = lines[endLine - 1]!.endByte;
    const diff = value.slice(lines[startLine]!.startChar, lines[endLine - 1]!.endChar);
    if (Buffer.byteLength(diff, 'utf8') + contextBytes > maxBytes) {
      throw new ChunkError('line-too-large', 'Git diff chunk exceeds its byte budget.');
    }
    result.push({ diff, context, startByte, endByte, paths: [...file.paths] });
    startLine = endLine;
  }
  return result;
}

function chunkPaths(files: DiffFile[], first: number, last: number): string[] {
  const paths: string[] = [];
  for (let index = first; index < last; index += 1) {
    for (const path of files[index]!.paths) if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

/**
 * Partition a valid Git patch into deterministic, contiguous source ranges.
 * Complete files are grouped when they share a nearby tree or working-directory
 * hint. A file larger than the budget is split only at complete line boundaries,
 * preferring hunk boundaries and repeating identifying headers as context.
 */
export function splitDiff(diff: string, maxBytes: number, workingDirectories?: string[]): DiffChunk[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new ChunkError('invalid-budget', 'maxBytes must be a positive safe integer.');
  }
  const offsets = byteOffsets(diff);
  if (diff.length === 0) return [{ diff: '', context: '', startByte: 0, endByte: 0, paths: [] }];
  const lines = linesOf(diff, offsets);
  const files = parseDiff(diff, lines);
  assignGroupKeys(files, workingDirectories);

  const chunks: DiffChunk[] = [];
  let fileIndex = 0;
  while (fileIndex < files.length) {
    const file = files[fileIndex]!;
    const fileBytes = file.endByte - file.startByte;
    if (fileBytes > maxBytes) {
      chunks.push(...splitLargeFile(diff, lines, file, maxBytes));
      fileIndex += 1;
      continue;
    }

    let maxEndFile = fileIndex + 1;
    while (maxEndFile < files.length) {
      const next = files[maxEndFile]!;
      if (next.endByte - file.startByte > maxBytes || next.endByte - next.startByte > maxBytes) break;
      maxEndFile += 1;
    }
    // If the complete remaining diff fits, keep it as one whole-file request.
    // Otherwise stop at a tree or working-directory boundary when that still
    // leaves a useful group; the source order remains unchanged either way.
    let endFile = maxEndFile;
    if (maxEndFile < files.length) {
      if (files[fileIndex + 1]?.groupKey !== file.groupKey) endFile = fileIndex + 1;
      for (let candidate = fileIndex + 1; candidate < maxEndFile; candidate += 1) {
        if (files[candidate]!.groupKey !== file.groupKey) {
          endFile = candidate;
          break;
        }
      }
    }
    const startByte = file.startByte;
    const endByte = files[endFile - 1]!.endByte;
    chunks.push({
      diff: diff.slice(file.startChar, files[endFile - 1]!.endChar),
      context: '',
      startByte,
      endByte,
      paths: chunkPaths(files, fileIndex, endFile),
    });
    fileIndex = endFile;
  }

  const totalBytes = offsets[diff.length]!;
  if (chunks.length === 0 || chunks[0]!.startByte !== 0 || chunks[chunks.length - 1]!.endByte !== totalBytes) {
    throw new ChunkError('unparseable-diff', 'Diff partition did not cover the complete source.');
  }
  for (let index = 1; index < chunks.length; index += 1) {
    if (chunks[index]!.startByte !== chunks[index - 1]!.endByte) {
      throw new ChunkError('unparseable-diff', 'Diff partition contains a gap or overlap.');
    }
  }
  return chunks;
}

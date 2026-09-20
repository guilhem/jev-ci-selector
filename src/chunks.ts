export interface DiffChunk {
  diff: string;
  context: string;
  startByte: number;
  endByte: number;
}

export type ChunkErrorCode = 'invalid-budget' | 'context-too-large' | 'line-too-large';

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

interface Header extends DiffLine {}

function byteOffsets(value: string): number[] {
  const offsets = new Array<number>(value.length + 1).fill(0);
  let byteCount = 0;
  let index = 0;
  while (index < value.length) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    const width = codePoint > 0xffff ? 2 : 1;
    const encodedBytes = Buffer.byteLength(value.slice(index, index + width), 'utf8');
    offsets[index] = byteCount;
    if (width === 2) offsets[index + 1] = byteCount;
    byteCount += encodedBytes;
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

function isFileHeader(line: DiffLine): boolean {
  return line.text.startsWith('diff --git ');
}

function isHunkHeader(line: DiffLine): boolean {
  return /^@@+ /.test(line.text);
}

function continuationContext(lines: DiffLine[], startChar: number): string {
  let fileHeader: Header | undefined;
  let hunkHeader: Header | undefined;
  for (const line of lines) {
    if (line.endChar > startChar) {
      // A chunk beginning at (or inside) a new header must not inherit the
      // preceding file or hunk identity while that header is in its diff.
      if (isFileHeader(line)) return '';
      if (isHunkHeader(line)) hunkHeader = undefined;
      break;
    }
    if (isFileHeader(line)) {
      fileHeader = line;
      hunkHeader = undefined;
    } else if (isHunkHeader(line)) {
      hunkHeader = line;
    }
  }
  return `${fileHeader?.text ?? ''}${hunkHeader?.text ?? ''}`;
}

function nextBoundaryPriority(lines: DiffLine[], index: number): number {
  const next = lines[index + 1];
  if (!next) return 1;
  if (isFileHeader(next)) return 3;
  if (isHunkHeader(next)) return 2;
  return 1;
}

/**
 * Split a unified diff without changing its source bytes. Context is only
 * repeated file and hunk headers needed to identify a continuation chunk.
 */
export function splitDiff(diff: string, maxBytes: number): DiffChunk[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new ChunkError('invalid-budget', 'maxBytes must be a positive safe integer.');
  }
  const offsets = byteOffsets(diff);
  const totalBytes = offsets[diff.length]!;
  if (diff.length === 0) return [{ diff: '', context: '', startByte: 0, endByte: 0 }];

  const lines = linesOf(diff, offsets);
  const chunks: DiffChunk[] = [];
  let startChar = 0;

  while (startChar < diff.length) {
    const context = continuationContext(lines, startChar);
    const contextBytes = Buffer.byteLength(context, 'utf8');
    if (contextBytes >= maxBytes) {
      throw new ChunkError('context-too-large', 'Continuation context leaves no room for diff bytes.');
    }
    const availableBytes = maxBytes - contextBytes;
    const startByte = offsets[startChar]!;
    const byteLimit = startByte + availableBytes;
    const lineIndex = lines.findIndex((line) => startChar >= line.startChar && startChar < line.endChar);
    if (lineIndex < 0) throw new ChunkError('line-too-large', 'Unable to locate the current diff line.');

    let scanChar = startChar;
    let bestEndChar = startChar;
    let bestPriority = 0;
    for (let index = lineIndex; index < lines.length; index += 1) {
      const line = lines[index]!;
      const lineEndByte = offsets[line.endChar]!;
      if (lineEndByte > byteLimit) break;
      scanChar = line.endChar;
      const priority = nextBoundaryPriority(lines, index);
      if (priority >= bestPriority) {
        bestEndChar = scanChar;
        bestPriority = priority;
      }
    }

    if (bestEndChar === startChar) {
      // A single line can exceed the budget. Advance by complete Unicode code
      // points; never slice the UTF-16 string in the middle of a surrogate pair.
      let endChar = startChar;
      while (endChar < diff.length) {
        const codePoint = diff.codePointAt(endChar);
        if (codePoint === undefined) break;
        const width = codePoint > 0xffff ? 2 : 1;
        const endByte = offsets[endChar + width]!;
        if (endByte - startByte > availableBytes) break;
        endChar += width;
      }
      if (endChar === startChar) {
        throw new ChunkError('line-too-large', 'A Unicode code point does not fit the diff budget.');
      }
      bestEndChar = endChar;
    }

    const endByte = offsets[bestEndChar]!;
    const chunkDiff = diff.slice(startChar, bestEndChar);
    if (endByte <= startByte || Buffer.byteLength(chunkDiff, 'utf8') + contextBytes > maxBytes) {
      throw new ChunkError('line-too-large', 'Unable to represent a diff chunk within the budget.');
    }
    chunks.push({ diff: chunkDiff, context, startByte, endByte });
    startChar = bestEndChar;
  }

  // Keep this assertion local so future changes cannot accidentally omit the
  // final source bytes while retaining the public exact-range contract.
  if (chunks[chunks.length - 1]?.endByte !== totalBytes) {
    throw new ChunkError('line-too-large', 'Diff partition did not cover the complete source.');
  }
  return chunks;
}

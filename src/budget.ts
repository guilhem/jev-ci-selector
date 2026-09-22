/**
 * Shared, explicitly-measured budgets for a single analysis.
 *
 * Every counter here measures exactly what it names: real UTF-8/JSON bytes
 * produced or sent, reserved call slots, and remaining wall-clock time. None of
 * them estimates provider tokens, and none of them is inferred from JavaScript
 * string lengths.
 *
 * Reservations are taken synchronously before a request is dispatched. The
 * runtime is single threaded, so a synchronous check-and-debit cannot be
 * interleaved by a concurrent worker: several in-flight calls can never
 * collectively exceed a limit. A reservation may be released while the request
 * has not been sent; once sent it is committed with the bytes actually written.
 */

export type BudgetKind =
  | 'manifest-bytes'
  | 'patch-unit-bytes'
  | 'collected-patch-bytes'
  | 'analysis-bytes'
  | 'jev-calls'
  | 'time';

export type BudgetScope = 'preparation' | 'observation';

export class BudgetError extends Error {
  constructor(
    readonly kind: BudgetKind,
    readonly limit: number,
    readonly used: number,
    readonly scope?: BudgetScope,
  ) {
    super(`budget:${kind}`);
    this.name = 'BudgetError';
  }
}

export interface BudgetLimits {
  /** Bytes of collected patch text, summed over every unit actually read. */
  maxCollectedPatchBytes: number;
  /** Bytes of complete request JSON sent to Jev, summed over every call. */
  maxAnalysisBytes: number;
  /** Jev calls actually dispatched, failures included. */
  maxJevCalls: number;
  /** Deadline on the `performance.now()` clock shared with the caller. */
  deadline: number;
}

export interface BudgetCounters {
  manifest_entries: number | null;
  patches_requested: number;
  patches_read: number;
  /** Bytes Git actually produced, rejected and retried attempts included. */
  patch_bytes_read: number;
  /** Bytes of complete patch text handed to the analysis. Always <= read. */
  patch_bytes_delivered: number;
  preparation_calls: number;
  preparation_bytes: number;
  observation_calls: number;
  observation_bytes: number;
  jev_calls: number;
  analysis_bytes: number;
  limits_reached: BudgetKind[];
}

export interface Reservation {
  readonly bytes: number;
  /** Confirm the call was dispatched. Committed reservations are never freed. */
  commit(): void;
  /** Return an unsent reservation to the shared pool. */
  release(): void;
}

/** Inventory ceiling for the raw manifest. Local size, never Jev context size. */
export const MANIFEST_BYTES = 4 * 1024 * 1024;
/** Ceiling for a single collected patch unit, applied before any allocation. */
export const PATCH_UNIT_BYTES = 256 * 1024;
/** Default ceiling for the sum of collected patch units. */
export const COLLECTED_PATCH_BYTES = 1024 * 1024;
/**
 * Default ceiling for the sum of complete request JSON sent to Jev.
 *
 * Sized from measurement, not from a round number. Context preparation asks one
 * question per tracked repository path, per pass, per job anchor, so its cost
 * scales with the size of the repository rather than with the change: a 250-file
 * repository spends roughly 220 KB on a single anchor's two passes. The earlier
 * 512 KiB default put that within a hair of the preparation sub-limit, so
 * `resolve_context_files` failed on every run of any repository of moderate
 * size. Repositories with many files or many job anchors still need to raise it.
 */
export const ANALYSIS_BYTES = 4 * 1024 * 1024;
/** Default ceiling for dispatched Jev calls, preparation and observation together. */
export const JEV_CALLS = 16;
/**
 * Share of the analysis budget preparation may consume. Preparation must not
 * be able to starve the decision it exists to serve.
 *
 * It follows that context preparation needs at least two call slots to run at
 * all: below `max-jev-calls: 2` its share floors to zero and every preparation
 * request is refused, which retains the tasks that asked for context.
 */
const PREPARATION_SHARE = 0.5;
/** Call slots below which context preparation cannot run at all. */
export const MIN_PREPARATION_CALLS = 2;

export class AnalysisBudget {
  readonly limits: BudgetLimits;
  #readBytes = 0;
  #deliveredBytes = 0;
  #patchesRequested = 0;
  #patchesRead = 0;
  #manifestEntries: number | null = null;
  #calls: Record<BudgetScope, number> = { preparation: 0, observation: 0 };
  #bytes: Record<BudgetScope, number> = { preparation: 0, observation: 0 };
  #reservedCalls = 0;
  #reservedBytes = 0;
  #reached = new Set<BudgetKind>();

  constructor(limits: BudgetLimits) {
    for (const key of ['maxCollectedPatchBytes', 'maxAnalysisBytes', 'maxJevCalls'] as const) {
      if (!Number.isSafeInteger(limits[key]) || limits[key] < 0) throw new Error(`invalid-budget:${key}`);
    }
    if (!Number.isFinite(limits.deadline)) throw new Error('invalid-budget:deadline');
    this.limits = { ...limits };
  }

  get counters(): BudgetCounters {
    return {
      manifest_entries: this.#manifestEntries,
      patches_requested: this.#patchesRequested,
      patches_read: this.#patchesRead,
      patch_bytes_read: this.#readBytes,
      patch_bytes_delivered: this.#deliveredBytes,
      preparation_calls: this.#calls.preparation,
      preparation_bytes: this.#bytes.preparation,
      observation_calls: this.#calls.observation,
      observation_bytes: this.#bytes.observation,
      jev_calls: this.#calls.preparation + this.#calls.observation,
      analysis_bytes: this.#bytes.preparation + this.#bytes.observation,
      limits_reached: [...this.#reached].sort(),
    };
  }

  get limitsReached(): BudgetKind[] {
    return [...this.#reached].sort();
  }

  noteManifest(entries: number): void {
    this.#manifestEntries = entries;
  }

  /**
   * Bytes still available for one patch unit, never above the per-unit cap.
   *
   * The allowance is computed from bytes already *read*, so an attempt that was
   * rejected and retried has already consumed part of it.
   */
  patchUnitAllowance(): number {
    const remaining = this.limits.maxCollectedPatchBytes - this.#readBytes;
    if (remaining <= 0) this.#reached.add('collected-patch-bytes');
    return Math.max(0, Math.min(PATCH_UNIT_BYTES, remaining));
  }

  notePatchRequested(): void {
    this.#patchesRequested += 1;
  }

  /**
   * Charge the work a read really cost, whatever its outcome.
   *
   * Git produces bytes before an oversized read is interrupted, and a patch
   * rejected as binary or unrepresentable was still produced in full. Charging
   * only accepted patches would bound the useful context rather than the work,
   * which is not the guarantee the input advertises. An interrupted read yields
   * a lower bound, never an exact size.
   */
  chargeRead(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('invalid-patch-bytes');
    this.#readBytes += bytes;
    if (this.#readBytes >= this.limits.maxCollectedPatchBytes) this.#reached.add('collected-patch-bytes');
  }

  /** Record a complete unit handed to the analysis. Throws past the cap. */
  spendPatchBytes(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('invalid-patch-bytes');
    if (this.#deliveredBytes + bytes > this.limits.maxCollectedPatchBytes) {
      this.#reached.add('collected-patch-bytes');
      throw new BudgetError('collected-patch-bytes', this.limits.maxCollectedPatchBytes, this.#deliveredBytes + bytes);
    }
    this.#deliveredBytes += bytes;
    this.#patchesRead += 1;
  }

  /** Register a ceiling that was reached elsewhere, for the report's registry. */
  noteLimit(kind: BudgetKind): void {
    this.#reached.add(kind);
  }

  remainingMs(): number {
    return Math.floor(this.limits.deadline - performance.now());
  }

  expired(): boolean {
    const expired = this.remainingMs() <= 0;
    if (expired) this.#reached.add('time');
    return expired;
  }

  #scopeCallLimit(scope: BudgetScope): number {
    return scope === 'preparation'
      ? Math.floor(this.limits.maxJevCalls * PREPARATION_SHARE)
      : this.limits.maxJevCalls;
  }

  #scopeByteLimit(scope: BudgetScope): number {
    return scope === 'preparation'
      ? Math.floor(this.limits.maxAnalysisBytes * PREPARATION_SHARE)
      : this.limits.maxAnalysisBytes;
  }

  /**
   * Whether another call of this size would fit right now.
   *
   * A pure query: unlike `reserve`, it records nothing, so asking the question
   * never makes the report claim a ceiling was reached.
   */
  fits(scope: BudgetScope, bytes: number): boolean {
    return this.#violation(scope, bytes) === null;
  }

  /** The ceiling a call of this size would break, without recording anything. */
  #violation(scope: BudgetScope, bytes: number): BudgetError | null {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('invalid-request-bytes');
    const calls = this.#calls.preparation + this.#calls.observation + this.#reservedCalls;
    const used = this.#bytes.preparation + this.#bytes.observation + this.#reservedBytes;
    if (calls + 1 > this.limits.maxJevCalls) return new BudgetError('jev-calls', this.limits.maxJevCalls, calls + 1);
    if (used + bytes > this.limits.maxAnalysisBytes) return new BudgetError('analysis-bytes', this.limits.maxAnalysisBytes, used + bytes);
    if (this.#calls[scope] + this.#reservedCalls + 1 > this.#scopeCallLimit(scope)) {
      return new BudgetError('jev-calls', this.#scopeCallLimit(scope), this.#calls[scope] + 1, scope);
    }
    if (this.#bytes[scope] + this.#reservedBytes + bytes > this.#scopeByteLimit(scope)) {
      return new BudgetError('analysis-bytes', this.#scopeByteLimit(scope), this.#bytes[scope] + bytes, scope);
    }
    return null;
  }

  /**
   * Debit one call slot and `bytes` of request JSON before dispatch. The debit
   * is synchronous, so concurrent workers cannot race past a limit.
   */
  reserve(scope: BudgetScope, bytes: number): Reservation {
    const violation = this.#violation(scope, bytes);
    if (violation) {
      this.#reached.add(violation.kind);
      throw violation;
    }
    this.#reservedCalls += 1;
    this.#reservedBytes += bytes;
    let settled = false;
    const budget = this;
    return {
      bytes,
      commit(): void {
        if (settled) return;
        settled = true;
        budget.#reservedCalls -= 1;
        budget.#reservedBytes -= bytes;
        budget.#calls[scope] += 1;
        budget.#bytes[scope] += bytes;
      },
      release(): void {
        if (settled) return;
        settled = true;
        budget.#reservedCalls -= 1;
        budget.#reservedBytes -= bytes;
      },
    };
  }
}

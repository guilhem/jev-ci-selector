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

export class BudgetError extends Error {
  constructor(
    readonly kind: BudgetKind,
    readonly limit: number,
    readonly used: number,
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
  jev_calls: number;
  analysis_bytes: number;
  /** HTTP attempts really made, retries included. Never below `jev_calls`. */
  attempts: number;
  limits_reached: BudgetKind[];
}

export interface Reservation {
  readonly bytes: number;
  /**
   * Confirm the call was dispatched. Committed reservations are never freed.
   *
   * `dispatched` is what the transport really wrote: the SDK may retry, so one
   * reservation can cover several attempts and more bytes than were admitted.
   * Passing the measured values keeps the counters truthful; omitting them
   * charges exactly what was reserved.
   */
  commit(dispatched?: { attempts: number; sentBytes: number }): void;
  /** Return an unsent reservation to the shared pool. */
  release(): void;
}

/** Inventory ceiling for the raw manifest. Local size, never Jev context size. */
export const MANIFEST_BYTES = 4 * 1024 * 1024;
/** Ceiling for a single collected patch unit, applied before any allocation. */
export const PATCH_UNIT_BYTES = 256 * 1024;
/** Default ceiling for the sum of collected patch units. */
export const COLLECTED_PATCH_BYTES = 1024 * 1024;
/** Default ceiling for the sum of complete request JSON sent to Jev. */
export const ANALYSIS_BYTES = 4 * 1024 * 1024;
/** Default ceiling for dispatched Jev calls. */
export const JEV_CALLS = 16;

export class AnalysisBudget {
  readonly limits: BudgetLimits;
  #readBytes = 0;
  #deliveredBytes = 0;
  #patchesRequested = 0;
  #patchesRead = 0;
  #manifestEntries: number | null = null;
  #calls = 0;
  #bytes = 0;
  #reservedCalls = 0;
  #reservedBytes = 0;
  #attempts = 0;
  #reached = new Set<BudgetKind>();

  constructor(limits: BudgetLimits) {
    for (const key of ['maxCollectedPatchBytes', 'maxAnalysisBytes', 'maxJevCalls'] as const) {
      if (!Number.isSafeInteger(limits[key]) || limits[key] < 0) throw new Error(`invalid-budget:${key}`);
    }
    // Zero means "no ceiling": the provider's own window and rate limits, plus
    // the job's own timeout, are what bound a run. A configured ceiling still
    // binds.
    const unbounded = (value: number) => value === 0 ? Number.POSITIVE_INFINITY : value;
    this.limits = {
      maxCollectedPatchBytes: unbounded(limits.maxCollectedPatchBytes),
      maxAnalysisBytes: unbounded(limits.maxAnalysisBytes),
      maxJevCalls: unbounded(limits.maxJevCalls),
      deadline: limits.deadline,
    };
  }

  get counters(): BudgetCounters {
    return {
      manifest_entries: this.#manifestEntries,
      patches_requested: this.#patchesRequested,
      patches_read: this.#patchesRead,
      patch_bytes_read: this.#readBytes,
      patch_bytes_delivered: this.#deliveredBytes,
      jev_calls: this.#calls,
      analysis_bytes: this.#bytes,
      attempts: this.#attempts,
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

  /**
   * Whether another call of this size would fit right now.
   *
   * A pure query: unlike `reserve`, it records nothing, so asking the question
   * never makes the report claim a ceiling was reached.
   */
  fits(bytes: number): boolean {
    return this.#violation(bytes) === null;
  }

  /** The ceiling a call of this size would break, without recording anything. */
  #violation(bytes: number): BudgetError | null {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('invalid-request-bytes');
    const calls = this.#calls + this.#reservedCalls;
    const used = this.#bytes + this.#reservedBytes;
    if (calls + 1 > this.limits.maxJevCalls) return new BudgetError('jev-calls', this.limits.maxJevCalls, calls + 1);
    if (used + bytes > this.limits.maxAnalysisBytes) return new BudgetError('analysis-bytes', this.limits.maxAnalysisBytes, used + bytes);
    return null;
  }

  /**
   * Debit one call slot and `bytes` of request JSON before dispatch. The debit
   * is synchronous, so concurrent workers cannot race past a limit.
   */
  reserve(bytes: number): Reservation {
    const violation = this.#violation(bytes);
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
      commit(dispatched?: { attempts: number; sentBytes: number }): void {
        if (settled) return;
        settled = true;
        budget.#reservedCalls -= 1;
        budget.#reservedBytes -= bytes;
        // Charge what actually went over the wire. A retried call costs several
        // attempts and several bodies; hiding that would make the counters lie.
        budget.#calls += Math.max(1, dispatched?.attempts ?? 1);
        budget.#bytes += Math.max(bytes, dispatched?.sentBytes ?? bytes);
        budget.#attempts += Math.max(1, dispatched?.attempts ?? 1);
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

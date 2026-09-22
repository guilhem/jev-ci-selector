/**
 * Shared, adaptive concurrency for every request this run dispatches.
 *
 * The provider publishes two ceilings: 1,200 requests per minute and 250,000
 * tokens per second. At a full-window request of roughly 30k tokens the token
 * ceiling binds first, at about 8 requests per second — so the defensible
 * ceiling here is single digits, not the dozens the request-per-minute figure
 * alone would suggest. The limits are also shared across every workflow using
 * the same key and the provider states they adjust dynamically, so the only
 * sound strategy is to probe upward slowly and retreat immediately.
 *
 * One controller is shared by context preparation and observation, so a burst
 * of preparation cannot provoke rate limiting that the decision then pays for.
 */

/** Concurrency to start from: useful parallelism without probing for a limit. */
const INITIAL = 4;
/** Ceiling implied by the token rate limit at a full-window request. */
const CEILING = 8;
const FLOOR = 1;
/** Consecutive successes before widening by one. */
const WIDEN_AFTER = 8;

export interface Release {
  (): void;
}

export class RateController {
  #limit: number;
  #active = 0;
  #successes = 0;
  #waiting: Array<() => void> = [];
  #rateLimits = 0;
  #peak = 0;

  constructor(initial = INITIAL, readonly ceiling = CEILING) {
    this.#limit = Math.max(FLOOR, Math.min(initial, ceiling));
  }

  get limit(): number { return this.#limit; }
  get stats(): { peak_concurrency: number; rate_limits: number; final_limit: number } {
    return { peak_concurrency: this.#peak, rate_limits: this.#rateLimits, final_limit: this.#limit };
  }

  /** Wait for a slot. The returned release must be called exactly once. */
  async acquire(): Promise<Release> {
    // A resumed waiter re-checks: resolving a promise does not occupy the slot
    // synchronously, so admission can only be confirmed by the waiter itself.
    while (this.#active >= this.#limit) {
      await new Promise<void>(resolve => this.#waiting.push(resolve));
    }
    this.#active += 1;
    this.#peak = Math.max(this.#peak, this.#active);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
      this.#admit();
    };
  }

  /** A completed call. Widen only after a sustained run of them. */
  noteSuccess(): void {
    this.#successes += 1;
    if (this.#successes >= WIDEN_AFTER && this.#limit < this.ceiling) {
      this.#limit += 1;
      this.#successes = 0;
      this.#admit();
    }
  }

  /** A refused call. Halve immediately: the ceiling is shared and moves. */
  noteRateLimit(): void {
    this.#rateLimits += 1;
    this.#successes = 0;
    this.#limit = Math.max(FLOOR, Math.floor(this.#limit / 2));
  }

  #admit(): void {
    // Wake one waiter per free slot. Waking them all would let every waiter
    // past the check before any of them had taken its slot.
    for (let free = this.#limit - this.#active; free > 0 && this.#waiting.length; free--) {
      this.#waiting.shift()!();
    }
  }
}

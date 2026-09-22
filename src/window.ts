/**
 * Request sizing derived from measurement rather than from invented constants.
 *
 * The provider documents its window in tokens — 64k per request, of which 32k
 * for `state` plus the longest question — while everything we can count locally
 * is bytes. We never convert one into the other as if it were a fact: we keep a
 * bytes-per-token **ratio**, seed it with a declared prior, replace it with the
 * provider's own `usage.input_tokens` as soon as a real response arrives, and
 * lower it whenever a request is refused for size. The counts stay measured;
 * only the ratio is inferred, and the report publishes the whole chain.
 */

/** Documented: tokens available to `state` plus the longest question. */
export const PROVIDER_STATE_QUESTION_TOKENS = 32_000;
/** Documented: tokens available to a whole request. */
export const PROVIDER_REQUEST_TOKENS = 64_000;
/**
 * Starting ratio, stated as a prior and not as a measurement. It is exactly the
 * previous hardcoded 64 KiB against 32k tokens, so a cold start can never size
 * a request larger than the code did before its first response.
 */
export const BYTES_PER_TOKEN_PRIOR = 2.0;
/** Headroom kept against the documented ceiling. */
const SAFETY = 0.85;
/** A response smaller than this is mostly framing and distorts the ratio. */
const MIN_SAMPLE_TOKENS = 500;
/** One sample may never more than half again the previous budget. */
const MAX_GROWTH = 1.5;
const MIN_BYTES = 16 * 1024;
const MAX_BYTES = 512 * 1024;

export interface WindowReport {
  prior: number;
  observed_min: number | null;
  samples: number;
  applied: number;
  rejections: number;
}

export class TokenMeter {
  #ratio = BYTES_PER_TOKEN_PRIOR;
  #observedMin: number | null = null;
  #samples = 0;
  #rejections = 0;
  #lastStateBudget: number | null = null;

  get report(): WindowReport {
    return {
      prior: BYTES_PER_TOKEN_PRIOR,
      observed_min: this.#observedMin,
      samples: this.#samples,
      applied: this.#ratio,
      rejections: this.#rejections,
    };
  }

  /**
   * Fold in what one response really cost.
   *
   * The first usable sample replaces the prior outright, so a genuinely dense
   * ratio can raise the budget. Every later sample takes the minimum, because
   * we are sizing against a ceiling and the worst density is the one that has
   * to fit.
   */
  record(sentBytes: number, inputTokens: number): void {
    if (!Number.isFinite(sentBytes) || !Number.isFinite(inputTokens)) return;
    if (inputTokens < MIN_SAMPLE_TOKENS || sentBytes <= 0) return;
    const ratio = sentBytes / inputTokens;
    if (!Number.isFinite(ratio) || ratio <= 0) return;
    this.#samples += 1;
    this.#observedMin = this.#observedMin === null ? ratio : Math.min(this.#observedMin, ratio);
    this.#ratio = this.#samples === 1 ? ratio : this.#observedMin;
  }

  /**
   * A request refused for size proves that many bytes exceeded the window.
   *
   * The resulting ratio is strictly below the one that produced the rejection,
   * which is what makes the caller's split-and-retry loop terminate.
   */
  noteRejection(rejectedBytes: number): void {
    if (!Number.isFinite(rejectedBytes) || rejectedBytes <= 0) return;
    this.#rejections += 1;
    const implied = (rejectedBytes / PROVIDER_STATE_QUESTION_TOKENS) * 0.9;
    this.#ratio = Math.min(this.#ratio, implied);
    this.#observedMin = this.#observedMin === null ? this.#ratio : Math.min(this.#observedMin, this.#ratio);
  }

  #budget(tokens: number, previous: number | null): number {
    const raw = Math.floor(tokens * this.#ratio * SAFETY);
    const capped = previous === null ? raw : Math.min(raw, Math.floor(previous * MAX_GROWTH));
    return Math.max(MIN_BYTES, Math.min(MAX_BYTES, capped));
  }

  /** Byte budget for `state` plus the longest question. */
  stateAndQuestionBytes(): number {
    const value = this.#budget(PROVIDER_STATE_QUESTION_TOKENS, this.#lastStateBudget);
    this.#lastStateBudget = value;
    return value;
  }

  /** Byte budget for the complete request payload. */
  requestBytes(): number {
    return this.#budget(PROVIDER_REQUEST_TOKENS, null);
  }
}

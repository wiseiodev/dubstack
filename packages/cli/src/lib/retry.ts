/**
 * Options controlling {@link retry} behavior.
 */
export interface RetryOptions {
  /** Maximum number of attempts (including the first). Defaults to 4. */
  maxAttempts?: number;
  /** Base delay in milliseconds. Defaults to 100. */
  baseMs?: number;
  /** Upper bound for any single backoff delay. Defaults to 2000. */
  maxMs?: number;
  /**
   * Predicate that classifies an error as permanent. When it returns true,
   * the error is rethrown immediately without further retries.
   */
  isPermanent?: (err: unknown) => boolean;
  /**
   * Invoked before each retry attempt (i.e. before attempts 2..maxAttempts).
   * Receives the upcoming attempt number (1-indexed) and the last error.
   */
  onRetry?: (attempt: number, err: unknown) => void;
  /**
   * Hook for delaying between attempts. Exposed primarily for tests; defaults
   * to `setTimeout`-based sleep.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Hook returning a jitter factor in [0, 1). Exposed primarily for tests;
   * defaults to `Math.random`.
   */
  random?: () => number;
}

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BASE_MS = 100;
const DEFAULT_MAX_MS = 2000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retries `fn` with exponential backoff and jitter.
 *
 * The delay before retry K (1-indexed: the wait before the K-th retry, which
 * runs as attempt K+1) is `min(baseMs * 2^(K-1), maxMs)` plus a small random
 * jitter (up to 25% of that delay), with the final value re-clamped to
 * `maxMs`. When `isPermanent(err)` returns true, the error is rethrown
 * immediately. After exhausting all attempts, the last error is wrapped in a
 * new Error whose message includes the attempt count, preserving the original
 * via `cause`.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseMs = options.baseMs ?? DEFAULT_BASE_MS;
  const maxMs = options.maxMs ?? DEFAULT_MAX_MS;
  const isPermanent = options.isPermanent;
  const onRetry = options.onRetry;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('retry: maxAttempts must be a positive integer');
  }
  if (!Number.isFinite(baseMs) || baseMs < 0) {
    throw new Error('retry: baseMs must be a finite non-negative number');
  }
  if (!Number.isFinite(maxMs) || maxMs < 0) {
    throw new Error('retry: maxMs must be a finite non-negative number');
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (isPermanent?.(err)) {
        throw err;
      }
      if (attempt >= maxAttempts) {
        break;
      }
      const exp = Math.min(baseMs * 2 ** (attempt - 1), maxMs);
      const r = random();
      const clampedR = Number.isFinite(r) && r >= 0 && r < 1 ? r : 0;
      const jitter = exp * 0.25 * clampedR;
      const delay = Math.min(exp + jitter, maxMs);
      onRetry?.(attempt + 1, err);
      await sleep(delay);
    }
  }

  const message =
    lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `retry: giving up after ${maxAttempts} attempts: ${message}`,
    { cause: lastError },
  );
}

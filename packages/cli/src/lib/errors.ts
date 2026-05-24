/**
 * Base error class for all user-facing DubStack errors.
 *
 * The CLI entry point catches instances of this class and prints
 * a clean, colored error message followed by a recovery block when
 * `recovery` hints are provided. Unknown errors still get a full
 * stack trace.
 *
 * @example
 * ```ts
 * throw new DubError("Branch 'feat/x' already exists", [
 *   "Run 'dub create feat/y' with a different branch name.",
 *   "Run 'dub checkout feat/x' to switch to the existing branch.",
 * ])
 * ```
 */
export class DubError extends Error {
  readonly recovery: string[];

  constructor(message: string, recovery: string[] = []) {
    super(message);
    this.name = 'DubError';
    this.recovery = recovery;
  }

  /**
   * Sentinel factory for failures where there is genuinely nothing for the
   * user to recover — typically because the user explicitly cancelled an
   * interactive prompt. Produces a `DubError` with an empty `recovery` array
   * and is the only sanctioned way to construct one (the `no-bare-duberror`
   * lint rule blocks `new DubError(msg)` and `new DubError(msg, [])` for
   * everything else).
   */
  static cancelled(message = 'Cancelled.'): DubError {
    return new DubError(message, []);
  }
}

/**
 * Formats a `DubError` for display: the original message, then a
 * "What you can do:" block listing each recovery hint on its own
 * numbered line. Returns the bare message when recovery is empty.
 */
export function formatDubError(error: DubError): string {
  if (error.recovery.length === 0) {
    return error.message;
  }
  const steps = error.recovery
    .map((step, idx) => `  ${idx + 1}. ${step}`)
    .join('\n');
  return `${error.message}\n\nWhat you can do:\n${steps}`;
}

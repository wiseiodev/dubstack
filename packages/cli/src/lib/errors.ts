/**
 * Base error class for all user-facing DubStack errors.
 *
 * The CLI entry point catches instances of this class and prints
 * a clean, colored error message. Unknown errors get a full stack trace.
 *
 * @example
 * ```ts
 * throw new DubError("Branch 'feat/x' already exists")
 * ```
 */
export class DubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DubError';
  }
}

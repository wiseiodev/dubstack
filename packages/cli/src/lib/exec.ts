import { execa as rawExeca } from 'execa';
import { getActiveProgress, logVerboseCommand } from './progress';

type RawExeca = typeof rawExeca;

/**
 * Wraps `execa(file, args, options)` so that `--verbose` invocations print
 * the command (sanitized) before the subprocess runs and pause any active
 * progress bar around the print. When verbose is off this is a no-op and
 * the call is functionally equivalent to `execa` itself.
 *
 * The wrapper preserves execa's overloaded call signatures via a cast so
 * downstream stdout/stderr typing keeps working unchanged.
 */
export const execa: RawExeca = ((
  file: string,
  args?: readonly string[],
  options?: unknown,
) => {
  logVerboseCommand(file, args ?? [], { progress: getActiveProgress() });
  return (rawExeca as unknown as (...a: unknown[]) => unknown)(
    file,
    args,
    options,
  );
}) as unknown as RawExeca;

export type { Options } from 'execa';

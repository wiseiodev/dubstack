import * as fs from 'node:fs';
import * as path from 'node:path';
import { DubError } from './errors';
import { getRepoRoot } from './git';

export interface StateLockInfo {
  pid: number;
  startedAt: string;
  command: string;
}

export interface AcquireStateLockOptions {
  commandName?: string;
  timeoutMs?: number;
  retryMs?: number;
  onWait?: (message: string) => void;
  now?: () => Date;
  allowReentrant?: boolean;
}

export interface StateLockHandle {
  path: string;
  info: StateLockInfo;
  release: () => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_MS = 500;
const localLocks = new Map<
  string,
  { info: StateLockInfo; path: string; count: number }
>();

export async function getStateLockPath(cwd: string): Promise<string> {
  const root = await getRepoRoot(cwd);
  return path.join(root, '.git', 'dubstack', 'state.lock');
}

export async function acquireStateLock(
  cwd: string,
  options: AcquireStateLockOptions = {},
): Promise<StateLockHandle> {
  const lockPath = await getStateLockPath(cwd);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const startedWaitingAt = Date.now();
  let printedWaitMessage = false;
  const localLock = localLocks.get(lockPath);
  if (localLock && options.allowReentrant !== false) {
    localLock.count += 1;
    return makeStateLockHandle(localLock.path, localLock.info);
  }
  if (localLock) {
    throw new DubError('DubStack state lock is already held by this process.', [
      'This usually means a command tried to acquire a non-reentrant state lock while already mutating state.',
      'Please report this at https://github.com/dubstack/dubstack/issues with the command you were running.',
    ]);
  }

  while (true) {
    const acquired = tryCreateLock(lockPath, options);
    if (acquired) {
      localLocks.set(lockPath, {
        path: lockPath,
        info: acquired,
        count: 1,
      });
      return makeStateLockHandle(lockPath, acquired);
    }

    const heldBy = readLockInfo(lockPath);
    if (heldBy && !isProcessAlive(heldBy.pid)) {
      tryRemoveLock(lockPath, heldBy);
      continue;
    }

    if (!printedWaitMessage) {
      const message = heldBy
        ? `Another dub command (PID ${heldBy.pid} running \`${heldBy.command}\` since ${heldBy.startedAt}) is currently writing state. Waiting...`
        : `Another dub command is currently writing state at ${lockPath}. Waiting...`;
      (options.onWait ?? console.warn)(message);
      printedWaitMessage = true;
    }

    if (Date.now() - startedWaitingAt >= timeoutMs) {
      throw new DubError(
        'Timed out waiting for another DubStack command to finish writing state.',
        [
          "Run 'dub doctor' to check for interrupted DubStack operations.",
          `If no dub process is running, remove '${lockPath}' manually and retry.`,
        ],
      );
    }

    await sleep(retryMs);
  }
}

export async function withStateLock<T>(
  cwd: string,
  fn: () => Promise<T> | T,
  options: AcquireStateLockOptions = {},
): Promise<T> {
  const lock = await acquireStateLock(cwd, options);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

function tryCreateLock(
  lockPath: string,
  options: AcquireStateLockOptions,
): StateLockInfo | null {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const info: StateLockInfo = {
    pid: process.pid,
    startedAt: (options.now ?? (() => new Date()))().toISOString(),
    command: options.commandName ?? inferCommandName(),
  };
  const payload = `${JSON.stringify(info, null, 2)}\n`;

  let fd: number | null = null;
  let created = false;
  let completed = false;
  try {
    fd = fs.openSync(lockPath, 'wx');
    created = true;
    fs.writeFileSync(fd, payload, 'utf8');
    completed = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw error;
  } finally {
    if (fd != null) fs.closeSync(fd);
    if (created && !completed) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Preserve the original create/write failure; cleanup is best effort.
      }
    }
  }

  return info;
}

function makeStateLockHandle(
  lockPath: string,
  info: StateLockInfo,
): StateLockHandle {
  return {
    path: lockPath,
    info,
    release: async () => releaseLocalStateLock(lockPath, info),
  };
}

function releaseLocalStateLock(lockPath: string, info: StateLockInfo): void {
  const localLock = localLocks.get(lockPath);
  if (!localLock || !sameLockInfo(localLock.info, info)) return;
  localLock.count -= 1;
  if (localLock.count > 0) return;
  localLocks.delete(lockPath);

  const current = readLockInfo(lockPath);
  if (!current || !sameLockInfo(current, info)) return;
  try {
    fs.unlinkSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function readLockInfo(lockPath: string): StateLockInfo | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(lockPath, 'utf8'),
    ) as Partial<StateLockInfo>;
    if (
      typeof parsed.pid !== 'number' ||
      typeof parsed.startedAt !== 'string' ||
      typeof parsed.command !== 'string'
    ) {
      return null;
    }
    return {
      pid: parsed.pid,
      startedAt: parsed.startedAt,
      command: parsed.command,
    };
  } catch {
    return null;
  }
}

function tryRemoveLock(lockPath: string, expected: StateLockInfo): void {
  const current = readLockInfo(lockPath);
  if (!current || !sameLockInfo(current, expected)) return;
  try {
    fs.unlinkSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function sameLockInfo(a: StateLockInfo, b: StateLockInfo): boolean {
  return (
    a.pid === b.pid && a.startedAt === b.startedAt && a.command === b.command
  );
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

function inferCommandName(): string {
  const args = process.argv.slice(2);
  return args.length > 0 ? `dub ${args.join(' ')}` : 'dub';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

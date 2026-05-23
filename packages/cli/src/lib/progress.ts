import process from 'node:process';
import cliProgress from 'cli-progress';
import { sanitizeRemoteUrl } from './sanitize';

export interface Progress {
  start(label: string, total?: number): void;
  update(label: string, current: number, detail?: string): void;
  complete(label: string): void;
  pause(): void;
  resume(): void;
}

export interface ProgressOptions {
  isTTY?: boolean;
  ci?: boolean;
  stream?: NodeJS.WriteStream;
}

interface BarState {
  label: string;
  total: number;
  current: number;
  detail?: string;
}

let verboseFlag = false;
let activeProgress: Progress | null = null;

export function setVerbose(value: boolean): void {
  verboseFlag = value;
}

export function isVerbose(): boolean {
  return verboseFlag;
}

export function getActiveProgress(): Progress | null {
  return activeProgress;
}

export function resetProgressStateForTests(): void {
  verboseFlag = false;
  activeProgress = null;
}

export function createProgress(options: ProgressOptions = {}): Progress {
  const stream = options.stream ?? process.stderr;
  const isTTY = options.isTTY ?? Boolean(stream.isTTY);
  const ci = options.ci ?? isCIEnvironment();

  if (!isTTY || ci) {
    return createNoopProgress();
  }

  return createTTYProgress(stream);
}

function createNoopProgress(): Progress {
  const noop: Progress = {
    start: () => {},
    update: () => {},
    complete: () => {},
    pause: () => {},
    resume: () => {},
  };
  return noop;
}

function createTTYProgress(stream: NodeJS.WriteStream): Progress {
  let bar: cliProgress.SingleBar | null = null;
  let state: BarState | null = null;
  let paused = false;

  const buildBar = (indeterminate: boolean): cliProgress.SingleBar =>
    new cliProgress.SingleBar(
      {
        stream,
        format: indeterminate
          ? '{label} {value} {detail}'
          : '{label} [{bar}] {value}/{total} {detail}',
        clearOnComplete: false,
        hideCursor: true,
      },
      cliProgress.Presets.shades_classic,
    );

  const startBarFromState = (next: BarState) => {
    const indeterminate = next.total <= 0;
    bar = buildBar(indeterminate);
    // cli-progress requires total > 0 to render a bar; for indeterminate mode
    // we still pass a positive total to keep the renderer happy and only show
    // the value/label/detail in the format string.
    bar.start(indeterminate ? 1 : next.total, next.current, {
      label: next.label,
      detail: next.detail ?? '',
    });
  };

  const progress: Progress = {
    start(label, total) {
      if (bar) {
        bar.stop();
      }
      state = { label, total: total ?? 0, current: 0 };
      paused = false;
      startBarFromState(state);
      activeProgress = progress;
    },
    update(label, current, detail) {
      if (!state) return;
      state = { ...state, label, current, detail };
      if (paused || !bar) return;
      bar.update(current, { label, detail: detail ?? '' });
    },
    complete(label) {
      if (!state) return;
      const total = state.total > 0 ? state.total : Math.max(state.current, 1);
      state = { ...state, label, current: total };
      if (!paused && bar) {
        bar.update(total, { label, detail: state.detail ?? '' });
        bar.stop();
      }
      bar = null;
      state = null;
      paused = false;
      if (activeProgress === progress) {
        activeProgress = null;
      }
    },
    pause() {
      if (paused || !bar) return;
      bar.stop();
      bar = null;
      paused = true;
    },
    resume() {
      if (!paused || !state) return;
      paused = false;
      startBarFromState(state);
    },
  };

  return progress;
}

function isCIEnvironment(): boolean {
  return Boolean(process.env.CI && process.env.CI !== 'false');
}

export interface LogVerboseCommandOptions {
  stream?: NodeJS.WriteStream;
  progress?: Progress | null;
}

export function logVerboseCommand(
  command: string,
  args: readonly string[] = [],
  options: LogVerboseCommandOptions = {},
): void {
  if (!verboseFlag) return;

  const stream = options.stream ?? process.stderr;
  const progress =
    options.progress === undefined ? activeProgress : options.progress;
  const line = formatVerboseCommandLine(command, args);

  if (progress) progress.pause();
  stream.write(`${line}\n`);
  if (progress) progress.resume();
}

export function formatVerboseCommandLine(
  command: string,
  args: readonly string[] = [],
): string {
  const sanitizedArgs = args.map((arg) =>
    looksLikeUrl(arg) ? sanitizeRemoteUrl(arg) : arg,
  );
  return ['$', command, ...sanitizedArgs].join(' ');
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

import {
  createPrompt,
  isDownKey,
  isEnterKey,
  isUpKey,
  Separator,
  useEffect,
  useKeypress,
  useMemo,
  usePagination,
  usePrefix,
  useRef,
  useState,
} from '@inquirer/core';
import chalk from 'chalk';

/** One row in the branch picker. */
export interface BranchPickerChoice {
  /** Branch name — the value returned when the user selects this row. */
  value: string;
  /** Pre-styled label to display (may include ANSI codes from chalk). */
  label: string;
  /** Plain text used for fuzzy filtering (no ANSI, no metadata noise). */
  searchKey: string;
  /** When set, the row is shown but cannot be selected (e.g. current branch). */
  disabled?: string;
}

/** Outcome of one picker session. The caller loops on side-effect actions. */
export type BranchPickerOutcome =
  | { type: 'checkout'; branch: string }
  | { type: 'cancel' }
  | { type: 'pr'; branch: string }
  | { type: 'diff'; branch: string }
  | { type: 'copy'; branch: string };

export interface BranchPickerConfig {
  message: string;
  choices: BranchPickerChoice[];
  /** Pre-select this branch on open. Defaults to first selectable. */
  defaultBranch?: string;
  /** Optional footer line (e.g. "Loading PR data..." or truncation notice). */
  footer?: string;
  pageSize?: number;
}

function isSelectable(choice: BranchPickerChoice): boolean {
  return !choice.disabled;
}

function findLastIndexSelectable(list: BranchPickerChoice[]): number {
  for (let i = list.length - 1; i >= 0; i--) {
    if (isSelectable(list[i])) return i;
  }
  return -1;
}

const cursorIcon = '❯';

/**
 * Custom `dub co` picker built on `@inquirer/core` so we can dispatch the
 * `p`/`d`/`c` shortcuts on top of `@inquirer/search`'s autocomplete +
 * arrow-key navigation. Resolves with a {@link BranchPickerOutcome} the
 * caller dispatches on: `checkout` and `cancel` are terminal; `pr`,
 * `diff`, and `copy` are side-effect actions the caller performs before
 * re-launching the picker.
 */
type BranchPickerPrompt = (
  config: BranchPickerConfig,
  context?: { signal?: AbortSignal },
) => Promise<BranchPickerOutcome>;

export const branchPickerPrompt: BranchPickerPrompt = createPrompt<
  BranchPickerOutcome,
  BranchPickerConfig
>((config, done) => {
  const { pageSize = 10 } = config;
  const [status, setStatus] = useState<'idle' | 'done'>('idle');
  const [searchTerm, setSearchTerm] = useState('');
  const prefix = usePrefix({ status });

  const filtered = useMemo(() => {
    if (!searchTerm) return config.choices;
    const needle = searchTerm.toLowerCase();
    return config.choices.filter((c) =>
      c.searchKey.toLowerCase().includes(needle),
    );
  }, [searchTerm, config.choices]);

  const bounds = useMemo(() => {
    const first = filtered.findIndex(isSelectable);
    const last = findLastIndexSelectable(filtered);
    return { first, last };
  }, [filtered]);

  const filteredRef = useRef(filtered);
  filteredRef.current = filtered;

  const initialActive = useMemo(() => {
    if (config.defaultBranch) {
      const idx = config.choices.findIndex(
        (c) => isSelectable(c) && c.value === config.defaultBranch,
      );
      if (idx !== -1) return idx;
    }
    return Math.max(0, config.choices.findIndex(isSelectable));
  }, [config.choices, config.defaultBranch]);
  const [active, setActive] = useState<number>(initialActive);

  // Reset `active` to the first selectable row when the filter narrows past
  // the current cursor; otherwise the renderer would point to a missing row.
  useEffect(() => {
    const current = filtered[active];
    if (!current || !isSelectable(current)) {
      setActive(bounds.first === -1 ? 0 : bounds.first);
    }
  }, [filtered]);

  const selected = filtered[active];

  useKeypress(async (key, rl) => {
    if (status !== 'idle') return;

    if (
      key.name === 'escape' ||
      (key.name === 'q' && !rl.line) ||
      (key.ctrl && key.name === 'c')
    ) {
      setStatus('done');
      done({ type: 'cancel' });
      return;
    }

    if (isEnterKey(key)) {
      if (selected && isSelectable(selected)) {
        setStatus('done');
        done({ type: 'checkout', branch: selected.value });
      }
      // No-op when the highlighted row isn't selectable (e.g. the filter
      // matched only the disabled current branch). Writing `searchTerm`
      // back to the readline buffer here would double the visible text.
      return;
    }

    if (isUpKey(key) || isDownKey(key)) {
      rl.clearLine(0);
      const list = filteredRef.current;
      // Nothing to navigate when the filter excludes every selectable row;
      // returning early avoids the do/while spinning forever looking for
      // a row that doesn't exist.
      if (list.length === 0 || bounds.first === -1) return;
      if (
        (isUpKey(key) && active !== bounds.first) ||
        (isDownKey(key) && active !== bounds.last)
      ) {
        const offset = isUpKey(key) ? -1 : 1;
        let next = active;
        do {
          next = (next + offset + list.length) % list.length;
        } while (!isSelectable(list[next]));
        setActive(next);
      }
      return;
    }

    // Side-effect shortcuts only fire when the search input is empty so
    // typing `p`/`d`/`c` into a branch name like `feat/copy` still works.
    if (
      !rl.line &&
      selected &&
      isSelectable(selected) &&
      (key.name === 'p' || key.name === 'd' || key.name === 'c')
    ) {
      rl.clearLine(0);
      setStatus('done');
      const type = key.name === 'p' ? 'pr' : key.name === 'd' ? 'diff' : 'copy';
      done({ type, branch: selected.value });
      return;
    }

    setSearchTerm(rl.line);
  });

  const renderedPage = usePagination({
    items: filtered,
    active,
    renderItem({ item, isActive }) {
      const choice = item as BranchPickerChoice;
      if (choice.disabled) {
        const tag =
          typeof choice.disabled === 'string' ? choice.disabled : '(disabled)';
        return chalk.dim(`- ${choice.label} ${tag}`);
      }
      const cursor = isActive ? cursorIcon : ' ';
      const line = `${cursor} ${choice.label}`;
      return isActive ? chalk.cyan(line) : line;
    },
    pageSize,
    loop: false,
  });

  const message = chalk.bold(config.message);
  const searchStr = searchTerm ? chalk.cyan(searchTerm) : '';
  const header = [prefix, message, searchStr]
    .filter(Boolean)
    .join(' ')
    .trimEnd();

  const helpLine = chalk.dim(
    [
      `${chalk.bold('↑↓')} navigate`,
      `${chalk.bold('⏎')} checkout`,
      `${chalk.bold('p')} open PR`,
      `${chalk.bold('d')} diff`,
      `${chalk.bold('c')} copy`,
      `${chalk.bold('esc')} cancel`,
    ].join(' • '),
  );

  if (status === 'done') {
    return header;
  }

  let body: string;
  if (filtered.length === 0) {
    body = chalk.red('> No branches match.');
  } else {
    body = renderedPage;
  }

  const parts = [body, config.footer ?? '', helpLine].filter(Boolean);
  return [header, parts.join('\n')];
});

/** Re-export for callers that want to add separators (e.g. between stacks). */
export { Separator };

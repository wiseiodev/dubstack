import type { Command } from 'commander';

/**
 * Generates shell completion scripts for the `dub` CLI by introspecting the
 * commander.js program tree. Output is emitted to stdout and intended to be
 * sourced from the user's shell config.
 */

export type CompletionShell = 'bash' | 'zsh' | 'fish';

/**
 * Subcommands that accept a branch name as their primary positional argument.
 * Used to drive shell-level branch-name completion via `git for-each-ref`.
 * `up` and `down` take a numeric step count, not a branch, so they are
 * intentionally absent.
 */
const BRANCH_ARG_COMMANDS = [
  'checkout',
  'co',
  'delete',
  'untrack',
  'track',
] as const;

/**
 * Flags whose value should be completed with branch names rather than free
 * text. Surfaces a small but high-value set; everything else falls back to
 * default shell completion.
 */
const BRANCH_VALUE_FLAGS = ['--parent', '--branch', '--before', '--after'];

/**
 * Flags whose value should be completed with file paths (default shell
 * filename completion). Limited to the long flag name — the same shell-level
 * file completion runs for both `--by-file foo.ts bar.ts` and any future
 * variadic file-valued option.
 */
const FILE_VALUE_FLAGS = ['--by-file'];

export interface OptionSpec {
  flags: string;
  long: string | null;
  short: string | null;
  takesValue: boolean;
  description: string;
}

export interface CommandSpec {
  name: string;
  aliases: string[];
  description: string;
  options: OptionSpec[];
  subcommands: CommandSpec[];
  /** Quoted to keep brackets/angle-brackets out of generated docs. */
  usageArgs: string;
  takesBranchArg: boolean;
  takesFileArg: boolean;
}

export interface ProgramSpec {
  name: string;
  description: string;
  options: OptionSpec[];
  commands: CommandSpec[];
}

interface CommandLike {
  name(): string;
  aliases(): string[];
  description(): string;
  options: CommanderOption[];
  commands: CommandLike[];
  _args?: Array<{ name?: () => string; _name?: string }>;
}

interface CommanderOption {
  flags: string;
  long: string | null;
  short: string | null;
  description: string;
  required?: boolean;
  optional?: boolean;
}

export function describeProgram(program: Command): ProgramSpec {
  const node = program as unknown as CommandLike;
  return {
    name: node.name(),
    description: node.description(),
    options: node.options.map(describeOption),
    commands: node.commands.map((cmd) => describeCommand(cmd, [node.name()])),
  };
}

function describeCommand(cmd: CommandLike, ancestors: string[]): CommandSpec {
  const name = cmd.name();
  const aliases = cmd.aliases();
  const argSpecs = (cmd._args ?? []).map((arg) => {
    const argName =
      typeof arg.name === 'function' ? arg.name() : (arg._name ?? '');
    return argName;
  });
  const usageArgs = argSpecs.join(' ');
  // Allow-list only. A broader regex over the description used to match
  // `dub revert <target>` (a PR number / SHA) and `dub trunk` (which has
  // subcommands), producing misleading branch completions.
  const branchPositional =
    BRANCH_ARG_COMMANDS.includes(
      name as (typeof BRANCH_ARG_COMMANDS)[number],
    ) ||
    aliases.some((alias) =>
      BRANCH_ARG_COMMANDS.includes(
        alias as (typeof BRANCH_ARG_COMMANDS)[number],
      ),
    );
  return {
    name,
    aliases,
    description: cmd.description(),
    options: cmd.options.map(describeOption),
    subcommands: cmd.commands.map((c) =>
      describeCommand(c, [...ancestors, name]),
    ),
    usageArgs,
    takesBranchArg: branchPositional,
    takesFileArg: /<file|<path|<files\.\.\./.test(usageArgs),
  };
}

function describeOption(option: CommanderOption): OptionSpec {
  const flags = option.flags;
  return {
    flags,
    long: option.long,
    short: option.short,
    takesValue:
      Boolean(option.required) ||
      Boolean(option.optional) ||
      /<|\[/.test(flags),
    description: option.description ?? '',
  };
}

function collectCommandNames(spec: ProgramSpec): string[] {
  const names = new Set<string>();
  for (const cmd of spec.commands) {
    names.add(cmd.name);
    for (const alias of cmd.aliases) names.add(alias);
  }
  return [...names].sort();
}

function flagTokens(option: OptionSpec): string[] {
  const out: string[] = [];
  if (option.long) out.push(option.long);
  if (option.short) out.push(option.short);
  return out;
}

function commandFlagList(cmd: CommandSpec): string[] {
  return cmd.options.flatMap(flagTokens);
}

interface CommandPath {
  /** Joined with `::` for use as a bash case key. */
  key: string;
  /** Pipe-joined name + aliases for the *terminal* name only. */
  patterns: string;
  /** All `::`-joined keys that should dispatch to this entry (including aliases). */
  aliasKeys: string[];
  flags: string[];
  /** Names of any direct subcommands (including aliases). */
  childNames: string[];
  cmd: CommandSpec;
}

/**
 * Flatten the command tree into per-path entries — one for every reachable
 * `dub` invocation, top-level and nested. `dub config ai-provider`
 * collapses to key `config::ai-provider`, with `aliasKeys` accounting for
 * the parent's aliases too so e.g. `dub co <Tab>` and `dub checkout <Tab>`
 * dispatch identically.
 */
function enumerateCommandPaths(commands: CommandSpec[]): CommandPath[] {
  const out: CommandPath[] = [];
  const walk = (cmd: CommandSpec, parents: string[][]) => {
    // parents is a list of equivalent ancestor-path arrays (each one a
    // valid concrete path via aliases). For the root the list is `[[]]`.
    const selfNames = [cmd.name, ...cmd.aliases];
    const ownPaths: string[][] = [];
    for (const parent of parents) {
      for (const name of selfNames) ownPaths.push([...parent, name]);
    }
    const key = ownPaths[0].join('::');
    const aliasKeys = ownPaths.map((p) => p.join('::'));
    out.push({
      key,
      patterns: selfNames.join('|'),
      aliasKeys,
      flags: commandFlagList(cmd),
      childNames: cmd.subcommands.flatMap((s) => [s.name, ...s.aliases]),
      cmd,
    });
    for (const sub of cmd.subcommands) walk(sub, ownPaths);
  };
  for (const cmd of commands) walk(cmd, [[]]);
  return out;
}

export function generateBashCompletion(program: Command): string {
  const spec = describeProgram(program);
  const topLevel = collectCommandNames(spec).join(' ');
  const branchValueFlags = BRANCH_VALUE_FLAGS.join('|');
  const fileValueFlags = FILE_VALUE_FLAGS.join('|');

  const paths = enumerateCommandPaths(spec.commands);

  // Per-path case entries. Includes top-level and any nested subcommand
  // paths so `dub config ai-provider --<Tab>` lists that nested command's
  // flags rather than the parent's.
  const cmdCases: string[] = [];
  const branchArgKeys: string[] = [];
  const fileArgKeys: string[] = [];
  // Index of every known command path key, used by __dub_walk_path to know
  // how deep to descend before stopping.
  const knownKeys = new Set<string>();
  for (const p of paths) {
    for (const k of p.aliasKeys) knownKeys.add(k);
    const completions = [...p.flags, ...p.childNames].join(' ');
    // The case label must accept every alias-key variant — bash patterns
    // can't be empty, so we join with `|`.
    const label = p.aliasKeys.join('|');
    cmdCases.push(
      `    ${label})\n      __dub_complete_words '${completions}'\n      ;;`,
    );
    if (p.cmd.takesBranchArg) branchArgKeys.push(...p.aliasKeys);
    if (p.cmd.takesFileArg) fileArgKeys.push(...p.aliasKeys);
  }

  const branchArgPattern = branchArgKeys.join('|');
  const fileArgPattern = fileArgKeys.join('|');
  const knownKeysLiteral = [...knownKeys].sort().join(' ');

  // Wrap each per-pattern case in a conditional so empty patterns do not
  // produce `case "$x" in )` — bash treats that as a syntax error.
  const branchArgCase = branchArgPattern
    ? `  if [[ "$cur" != -* ]] && [[ -n "$path" ]]; then
    case "$path" in
      ${branchArgPattern})
        __dub_compreply_lines "$(__dub_branches)"
        return 0
        ;;
    esac
  fi`
    : '';
  const fileArgCase = fileArgPattern
    ? `  if [[ "$cur" != -* ]]; then
    case "$path" in
      ${fileArgPattern})
        COMPREPLY=( $(compgen -f -- "$cur") )
        return 0
        ;;
    esac
  fi`
    : '';

  return `# dub bash completion
# Source this file (or save under /etc/bash_completion.d/) to enable.
#
# Usage:
#   eval "$(dub completion bash)"
#   # or
#   dub completion bash > ~/.local/share/bash-completion/completions/dub

__dub_branches() {
  git for-each-ref --format='%(refname:short)' refs/heads/ 2>/dev/null
}

# Set IFS to newline so branch names with shell-special characters survive
# word-splitting by compgen. Used by callers that pipe __dub_branches into
# completion candidates.
__dub_compreply_lines() {
  local IFS=$'\\n'
  COMPREPLY=( $(compgen -W "$1" -- "$cur") )
}

__dub_complete_words() {
  local words="$1"
  COMPREPLY=( $(compgen -W "$words" -- "$cur") )
}

# Returns the deepest known command path (e.g. "config::ai-provider") for
# the current argv, descending through nested subcommands while skipping
# flags and their values. The path is whatever portion of the argv we can
# confidently classify; flag completion is left to the per-path case below.
__dub_known_keys=" ${knownKeysLiteral} "
__dub_walk_path() {
  local idx=1 next path=""
  while [ "$idx" -lt "$cword" ]; do
    next="\${words[$idx]}"
    if [[ "$next" == -* ]]; then
      idx=$((idx+1))
      continue
    fi
    local candidate
    if [ -z "$path" ]; then
      candidate="$next"
    else
      candidate="\${path}::$next"
    fi
    case "$__dub_known_keys" in
      *" $candidate "*) path="$candidate" ;;
      *) break ;;
    esac
    idx=$((idx+1))
  done
  echo "$path"
}

_dub() {
  local cur prev words cword
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  words=( "\${COMP_WORDS[@]}" )
  cword=$COMP_CWORD

  # Branch-valued option flag just before the cursor wins over command-arg.
  case "$prev" in
    ${branchValueFlags})
      __dub_compreply_lines "$(__dub_branches)"
      return 0
      ;;
    ${fileValueFlags})
      COMPREPLY=( $(compgen -f -- "$cur") )
      return 0
      ;;
  esac

  # Top-level: complete subcommand names.
  if [ "$cword" -le 1 ]; then
    COMPREPLY=( $(compgen -W "${topLevel}" -- "$cur") )
    return 0
  fi

  local path
  path="$(__dub_walk_path)"

  # Branch-arg commands: complete with local branches when the user is on
  # a positional position and the current token is not a flag.
${branchArgCase}

  # File-arg commands fall through to default file completion.
${fileArgCase}

  # Otherwise complete that command's flags/subcommands.
  case "$path" in
${cmdCases.join('\n')}
    *)
      COMPREPLY=( $(compgen -W "--help" -- "$cur") )
      ;;
  esac
}

complete -F _dub dub
`;
}

export function generateZshCompletion(program: Command): string {
  const spec = describeProgram(program);

  // Top-level subcommand descriptions for `_describe`.
  const topDescribe = spec.commands
    .map((cmd) => `      '${cmd.name}:${escapeZsh(cmd.description)}'`)
    .concat(
      spec.commands.flatMap((cmd) =>
        cmd.aliases.map(
          (alias) => `      '${alias}:${escapeZsh(`alias for ${cmd.name}`)}'`,
        ),
      ),
    )
    .join('\n');

  // Per-top-level case branches. When a command has subcommands we route to
  // a second-level case so nested invocations like `dub config ai-provider`
  // complete that subcommand's flags rather than the parent's.
  const subcommandCases = spec.commands
    .map((cmd) => {
      const patterns = [cmd.name, ...cmd.aliases].join('|');
      if (cmd.subcommands.length > 0) {
        const nestedCases = cmd.subcommands
          .map((sub) => {
            const subPatterns = [sub.name, ...sub.aliases].join('|');
            const subFlags = sub.options
              .map(zshOptionSpec)
              .filter(Boolean)
              .join(' \\\n            ');
            const subArg = zshArgSpec(sub);
            return `        ${subPatterns})
          _arguments -s \\
            ${subFlags || ':: :->done'} \\
            ${subArg}
          ;;`;
          })
          .join('\n');
        const subDescribe = cmd.subcommands
          .map((sub) => `        '${sub.name}:${escapeZsh(sub.description)}'`)
          .join('\n');
        const parentFlags = cmd.options
          .map(zshOptionSpec)
          .filter(Boolean)
          .join(' \\\n        ');
        return `    ${patterns})
      _arguments -C \\
        ${parentFlags ? `${parentFlags} \\\n        ` : ''}'1: :->sub' \\
        '*:: :->subargs'
      case $state in
        sub)
          local -a subs
          subs=(
${subDescribe}
          )
          _describe -t subcommands '${cmd.name} subcommand' subs
          ;;
        subargs)
          case "\${line[1]}" in
${nestedCases}
            *)
              _message 'no more arguments'
              ;;
          esac
          ;;
      esac
      ;;`;
      }
      const flagSpecs = cmd.options
        .map(zshOptionSpec)
        .filter(Boolean)
        .join(' \\\n        ');
      const argSpec = zshArgSpec(cmd);
      return `    ${patterns})
      _arguments -s \\
        ${flagSpecs || ':: :->done'} \\
        ${argSpec}
      ;;`;
    })
    .join('\n');

  return `#compdef dub
# dub zsh completion
#
# Usage:
#   mkdir -p ~/.zsh/completions
#   dub completion zsh > ~/.zsh/completions/_dub
#   # ensure ~/.zshrc has, before compinit:
#   #   fpath=(~/.zsh/completions $fpath)
#   #   autoload -Uz compinit && compinit

__dub_branches() {
  local -a branches
  local raw
  raw=$(git for-each-ref --format='%(refname:short)' refs/heads/ 2>/dev/null)
  [[ -z $raw ]] && return
  branches=("\${(@f)raw}")
  _describe -t branches 'branch' branches
}

_dub() {
  local context state state_descr line
  typeset -A opt_args

  _arguments -C \\
    '1: :->cmd' \\
    '*:: :->args'

  case $state in
    cmd)
      local -a subcmds
      subcmds=(
${topDescribe}
      )
      _describe -t commands 'dub command' subcmds
      ;;
    args)
      case "\${line[1]}" in
${subcommandCases}
        *)
          _message 'no more arguments'
          ;;
      esac
      ;;
  esac
}

_dub "$@"
`;
}

function zshOptionSpec(option: OptionSpec): string {
  const desc = escapeZsh(option.description || '');
  const tokens = flagTokens(option);
  if (tokens.length === 0) return '';
  // Combine short + long into a (--long -s) cluster so completion knows they
  // are aliases for the same option.
  const head = tokens.length > 1 ? `(${tokens.join(' ')})` : '';
  const flag = tokens[0];
  if (option.takesValue) {
    // Route option values through the right completer when the flag is on
    // the branch- or file-valued allow-list. Falls back to generic `:value:`
    // for plain string options.
    const valueAction = optionValueAction(option);
    return `'${head}${flag}[${desc}]${valueAction}'`;
  }
  return `'${head}${flag}[${desc}]'`;
}

function optionValueAction(option: OptionSpec): string {
  if (option.long && BRANCH_VALUE_FLAGS.includes(option.long)) {
    return ':branch:__dub_branches';
  }
  if (option.long && FILE_VALUE_FLAGS.includes(option.long)) {
    return ':file:_files';
  }
  return ':value:';
}

function zshArgSpec(cmd: CommandSpec): string {
  // Subcommands take priority: `dub trunk <Tab>` must offer list/add/remove,
  // not branch names, even if the parent declares a [branch] positional.
  if (cmd.subcommands.length > 0) {
    const subs = cmd.subcommands
      .map((s) => `'${s.name}:${escapeZsh(s.description)}'`)
      .join(' ');
    return `'1:subcommand:((${subs}))'`;
  }
  if (cmd.takesBranchArg) {
    return `'*::branch:__dub_branches'`;
  }
  if (cmd.takesFileArg) {
    return `'*::file:_files'`;
  }
  return `':: :->done'`;
}

function escapeZsh(value: string): string {
  // Escape backslashes first so the subsequent escape passes can't re-double
  // a backslash we added ourselves. Then handle single quotes (close-then-
  // reopen idiom inside a single-quoted string), and finally the characters
  // zsh treats specially inside _arguments option specs and _describe
  // candidate strings: `[`, `]`, `:`. Backticks and dollar signs are
  // neutralised defensively — even inside single quotes they do not expand,
  // but some _arguments contexts re-evaluate the description.
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "'\\''")
    .replace(/[[\]:`$]/g, '\\$&');
}

export function generateFishCompletion(program: Command): string {
  const spec = describeProgram(program);
  const out: string[] = [];

  out.push('# dub fish completion');
  out.push('#');
  out.push('# Usage:');
  out.push('#   dub completion fish > ~/.config/fish/completions/dub.fish');
  out.push('');
  out.push('function __dub_branches');
  out.push(
    "  git for-each-ref --format='%(refname:short)' refs/heads/ 2>/dev/null",
  );
  out.push('end');
  out.push('');
  out.push('function __dub_using_command');
  out.push('  set -l cmd (commandline -opc)');
  out.push('  test (count $cmd) -ge 2; and test $cmd[2] = $argv[1]');
  out.push('  and test (count $cmd) -lt 3');
  out.push('end');
  out.push('');
  // Predicate for nested subcommands. argv[1] = parent, argv[2] = child.
  out.push('function __dub_using_nested');
  out.push('  set -l cmd (commandline -opc)');
  out.push(
    '  test (count $cmd) -ge 3; and test $cmd[2] = $argv[1]; and test $cmd[3] = $argv[2]',
  );
  out.push('end');
  out.push('');
  out.push('function __dub_no_subcommand');
  out.push('  set -l cmd (commandline -opc)');
  out.push('  test (count $cmd) -eq 1');
  out.push('end');
  out.push('');

  // Top-level subcommands
  for (const cmd of spec.commands) {
    const desc = escapeFish(cmd.description);
    out.push(
      `complete -c dub -n '__dub_no_subcommand' -f -a '${cmd.name}' -d '${desc}'`,
    );
    for (const alias of cmd.aliases) {
      out.push(
        `complete -c dub -n '__dub_no_subcommand' -f -a '${alias}' -d 'alias for ${cmd.name}'`,
      );
    }
  }
  out.push('');

  // Per-subcommand flag + arg completions
  for (const cmd of spec.commands) {
    const names = [cmd.name, ...cmd.aliases];
    for (const name of names) {
      const usingCondition = `__dub_using_command ${name}`;
      if (cmd.subcommands.length > 0) {
        // Subcommand names are valid completions at depth 1.
        for (const sub of cmd.subcommands) {
          const subDesc = escapeFish(sub.description);
          out.push(
            `complete -c dub -n '${usingCondition}' -f -a '${sub.name}' -d '${subDesc}'`,
          );
        }
      } else if (cmd.takesBranchArg) {
        out.push(
          `complete -c dub -n '${usingCondition}' -f -a '(__dub_branches)'`,
        );
      } else if (cmd.takesFileArg) {
        out.push(`complete -c dub -n '${usingCondition}' -F`);
      }
      emitFishFlagCompletions(out, cmd.options, usingCondition);

      // Nested subcommands get their own predicate so e.g.
      // `dub config ai-provider --<Tab>` lists ai-provider's flags.
      for (const sub of cmd.subcommands) {
        const nestedCondition = `__dub_using_nested ${name} ${sub.name}`;
        if (sub.takesBranchArg) {
          out.push(
            `complete -c dub -n '${nestedCondition}' -f -a '(__dub_branches)'`,
          );
        } else if (sub.takesFileArg) {
          out.push(`complete -c dub -n '${nestedCondition}' -F`);
        }
        emitFishFlagCompletions(out, sub.options, nestedCondition);
      }
    }
  }

  return `${out.join('\n')}\n`;
}

function emitFishFlagCompletions(
  out: string[],
  options: OptionSpec[],
  condition: string,
): void {
  for (const option of options) {
    const long = option.long ? option.long.replace(/^--/, '') : '';
    const short = option.short ? option.short.replace(/^-/, '') : '';
    const desc = escapeFish(option.description || '');
    const parts = [`complete -c dub -n '${condition}'`];
    if (long) parts.push(`-l ${long}`);
    if (short) parts.push(`-s ${short}`);
    if (option.takesValue) {
      parts.push('-r');
      // Surface branch/file completers for value-taking flags that the
      // allow-lists know about. Plain string flags still default to the
      // shell's no-suggestion behavior, which is what fish users expect.
      if (option.long && BRANCH_VALUE_FLAGS.includes(option.long)) {
        parts.push("-a '(__dub_branches)'");
      } else if (option.long && FILE_VALUE_FLAGS.includes(option.long)) {
        parts.push('-F');
      }
    }
    parts.push(`-d '${desc}'`);
    out.push(parts.join(' '));
  }
}

function escapeFish(value: string): string {
  // Fish single-quoted strings honor `\\` and `\'` as escapes, so a literal
  // backslash in a description must be doubled before any single-quote
  // escaping happens. Order matters: backslash first, then quote, then
  // collapse newlines so a multi-line description never breaks the
  // surrounding `complete -d '...'`.
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/[\r\n]+/g, ' ');
}

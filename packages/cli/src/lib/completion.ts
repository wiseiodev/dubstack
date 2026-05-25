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
 */
const BRANCH_ARG_COMMANDS = [
  'checkout',
  'co',
  'up',
  'down',
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
 * filename completion).
 */
const FILE_VALUE_FLAGS = ['--input-file', '--profile'];

interface OptionSpec {
  flags: string;
  long: string | null;
  short: string | null;
  takesValue: boolean;
  description: string;
}

interface CommandSpec {
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

interface ProgramSpec {
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
  const argSpecs = (cmd._args ?? []).map((arg) => {
    const argName =
      typeof arg.name === 'function' ? arg.name() : (arg._name ?? '');
    return argName;
  });
  const usageArgs = argSpecs.join(' ');
  const lower = `${name} ${usageArgs}`.toLowerCase();
  const branchPositional =
    BRANCH_ARG_COMMANDS.includes(
      name as (typeof BRANCH_ARG_COMMANDS)[number],
    ) || /\b(branch|target|trunk)\b/.test(lower);
  return {
    name,
    aliases: cmd.aliases(),
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

export function generateBashCompletion(program: Command): string {
  const spec = describeProgram(program);
  const topLevel = collectCommandNames(spec).join(' ');
  const branchValueFlags = BRANCH_VALUE_FLAGS.join('|');
  const fileValueFlags = FILE_VALUE_FLAGS.join('|');

  // Build a case branch per command resolving to its flag set + arg behavior.
  const cmdCases: string[] = [];
  const branchArgCmds: string[] = [];
  const fileArgCmds: string[] = [];
  for (const cmd of spec.commands) {
    const flagList = commandFlagList(cmd);
    const subNames = cmd.subcommands.flatMap((s) => [s.name, ...s.aliases]);
    // Single-quote the completion list. Flags from commander are kebab-case
    // (`--foo-bar`, `-x`), so they cannot contain single quotes; this keeps
    // any `$` or `"` in a hypothetical future flag from being expanded by
    // bash inside the generated case body.
    const completions = [...flagList, ...subNames].join(' ');
    const patterns = [cmd.name, ...cmd.aliases].join('|');
    cmdCases.push(
      `    ${patterns})\n      __dub_complete_words '${completions}'\n      ;;`,
    );
    if (cmd.takesBranchArg) {
      branchArgCmds.push(...[cmd.name, ...cmd.aliases]);
    }
    if (cmd.takesFileArg) {
      fileArgCmds.push(...[cmd.name, ...cmd.aliases]);
    }
  }

  const branchArgPattern = branchArgCmds.join('|');
  const fileArgPattern = fileArgCmds.join('|');

  // Wrap each per-pattern case in a conditional so empty patterns do not
  // produce `case "$x" in )` — bash treats that as a syntax error.
  const branchArgCase = branchArgPattern
    ? `  if [[ "$cur" != -* ]] && [[ "$cword" -eq 2 ]]; then
    case "$subcmd" in
      ${branchArgPattern})
        __dub_compreply_lines "$(__dub_branches)"
        return 0
        ;;
    esac
  fi`
    : '';
  const fileArgCase = fileArgPattern
    ? `  if [[ "$cur" != -* ]]; then
    case "$subcmd" in
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

  local subcmd="\${words[1]}"

  # Branch-arg subcommands: complete with local branches when the user is on
  # the first positional and the current token is not a flag.
${branchArgCase}

  # File-arg subcommands fall through to default file completion.
${fileArgCase}

  # Otherwise complete that command's flags/subcommands.
  case "$subcmd" in
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

  const subcommandCases = spec.commands
    .map((cmd) => {
      const patterns = [cmd.name, ...cmd.aliases].join('|');
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
#   dub completion zsh > "\${fpath[1]}/_dub"
#   # then restart your shell or run: compinit

__dub_branches() {
  local -a branches
  branches=("\${(@f)$(git for-each-ref --format='%(refname:short)' refs/heads/ 2>/dev/null)}")
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
    return `'${head}${flag}[${desc}]:value:'`;
  }
  return `'${head}${flag}[${desc}]'`;
}

function zshArgSpec(cmd: CommandSpec): string {
  if (cmd.takesBranchArg) {
    return `'*::branch:__dub_branches'`;
  }
  if (cmd.takesFileArg) {
    return `'*::file:_files'`;
  }
  if (cmd.subcommands.length > 0) {
    const subs = cmd.subcommands
      .map((s) => `'${s.name}:${escapeZsh(s.description)}'`)
      .join(' ');
    return `'1:subcommand:((${subs}))'`;
  }
  return `':: :->done'`;
}

function escapeZsh(value: string): string {
  return value.replace(/'/g, "'\\''").replace(/[[\]:]/g, '\\$&');
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
      // Branch arg
      if (cmd.takesBranchArg) {
        out.push(
          `complete -c dub -n '__dub_using_command ${name}' -f -a '(__dub_branches)'`,
        );
      } else if (cmd.takesFileArg) {
        out.push(`complete -c dub -n '__dub_using_command ${name}' -F`);
      }
      // Flags
      for (const option of cmd.options) {
        const long = option.long ? option.long.replace(/^--/, '') : '';
        const short = option.short ? option.short.replace(/^-/, '') : '';
        const desc = escapeFish(option.description || '');
        const parts = [`complete -c dub -n '__dub_using_command ${name}'`];
        if (long) parts.push(`-l ${long}`);
        if (short) parts.push(`-s ${short}`);
        if (option.takesValue) parts.push('-r');
        parts.push(`-d '${desc}'`);
        out.push(parts.join(' '));
      }
      // Nested subcommand names
      for (const sub of cmd.subcommands) {
        const subDesc = escapeFish(sub.description);
        out.push(
          `complete -c dub -n '__dub_using_command ${name}' -f -a '${sub.name}' -d '${subDesc}'`,
        );
      }
    }
  }

  return `${out.join('\n')}\n`;
}

function escapeFish(value: string): string {
  // Strip newlines and escape single quotes for the surrounding fish string.
  return value.replace(/[\r\n]+/g, ' ').replace(/'/g, "\\'");
}

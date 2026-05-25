import type { Command } from 'commander';
import { type CommandSpec, describeProgram } from './completion';

/**
 * Generates roff (groff_man) markup for `dub.1`. Output goes to stdout and is
 * intended to be redirected into `~/.local/share/man/man1/dub.1` (or another
 * MANPATH location). The page documents the top-level `dub` invocation plus
 * every subcommand in a SUBCOMMANDS section.
 */
export function generateManPage(
  program: Command,
  options: { version: string; date?: string } = { version: 'dev' },
): string {
  const spec = describeProgram(program);
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const lines: string[] = [];

  // Apply escapeRoff to version + date even though both originate from
  // package.json / new Date() — keeps the .TH line consistent with how every
  // other roff value is treated and immune to pre-release tags like
  // "1.0.0-beta.1" whose hyphen renders better as \-.
  lines.push(
    `.TH DUB 1 "${escapeRoff(date)}" "DubStack ${escapeRoff(options.version)}" "User Commands"`,
  );
  lines.push('.SH NAME');
  lines.push(`dub \\- ${escapeRoff(spec.description)}`);
  lines.push('.SH SYNOPSIS');
  lines.push('.B dub');
  lines.push('[\\fIGLOBAL OPTIONS\\fR]');
  lines.push('\\fICOMMAND\\fR');
  lines.push('[\\fIARGS\\fR]');
  lines.push('.SH DESCRIPTION');
  lines.push(
    'DubStack is a local-first CLI for managing chains of dependent git branches (stacked diffs).',
  );
  lines.push(
    'It keeps stack metadata in .git/dubstack and integrates with GitHub PRs.',
  );

  if (spec.options.length > 0) {
    lines.push('.SH GLOBAL OPTIONS');
    for (const option of spec.options) {
      lines.push('.TP');
      lines.push(`\\fB${escapeRoff(option.flags)}\\fR`);
      lines.push(escapeRoff(option.description || ''));
    }
  }

  lines.push('.SH COMMANDS');
  for (const cmd of spec.commands) {
    renderCommandEntry(lines, cmd, [cmd.name]);
  }

  lines.push('.SH FILES');
  lines.push('.TP');
  lines.push('\\fB.git/dubstack/state.json\\fR');
  lines.push('Per-repo stack state. Created by \\fBdub init\\fR.');

  lines.push('.SH SEE ALSO');
  lines.push('\\fBgit\\fR(1), \\fBgh\\fR(1)');

  lines.push('.SH AUTHOR');
  lines.push('DubStack contributors. https://github.com/wiseiodev/dubstack');

  return `${lines.join('\n')}\n`;
}

/**
 * Recursively renders a command (and any nested subcommands) as a `.TP`
 * entry plus its options. The original implementation only listed nested
 * subcommand names without their options, which left useful surfaces like
 * `dub config ai-provider` and `dub skills add` undocumented.
 */
function renderCommandEntry(
  lines: string[],
  cmd: CommandSpec,
  path: string[],
): void {
  const fullName = path.join(' ');
  // Build the label with a literal leading space outside escapeRoff so the
  // trim() inside the escaper doesn't collapse the spacing between the
  // command name and the alias suffix.
  const aliasSuffix =
    cmd.aliases.length > 0 ? ` (aliases: ${cmd.aliases.join(', ')})` : '';
  lines.push('.TP');
  lines.push(
    `\\fB${escapeRoff(fullName)}\\fR${aliasSuffix ? ` ${escapeRoff(aliasSuffix.trimStart())}` : ''}`,
  );
  lines.push(escapeRoff(cmd.description || ''));
  if (cmd.options.length > 0) {
    lines.push('.RS');
    for (const option of cmd.options) {
      lines.push('.TP');
      lines.push(`\\fB${escapeRoff(option.flags)}\\fR`);
      lines.push(escapeRoff(option.description || ''));
    }
    lines.push('.RE');
  }
  for (const sub of cmd.subcommands) {
    renderCommandEntry(lines, sub, [...path, sub.name]);
  }
}

/**
 * Roff treats lines starting with `.` or `\\'` as commands. We never want
 * user-supplied text (description strings, option flags) to accidentally
 * trigger a directive; escape leading dots and any backslashes.
 */
function escapeRoff(value: string): string {
  if (!value) return '';
  // Collapse newlines so a single description never spans multiple lines.
  const collapsed = value.replace(/[\r\n]+/g, ' ').trim();
  const backslashEscaped = collapsed.replace(/\\/g, '\\\\');
  // Hyphens render best as \- in roff so they survive man's hyphenation pass.
  const hyphenEscaped = backslashEscaped.replace(/-/g, '\\-');
  // Escape a leading dot or apostrophe so it does not start a directive when
  // the value happens to sit at column 0 (rare but possible).
  if (hyphenEscaped.startsWith('.') || hyphenEscaped.startsWith("'")) {
    return `\\&${hyphenEscaped}`;
  }
  return hyphenEscaped;
}

import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { program } from './index';

function walk(
  cmd: Command,
  prefix = '',
): Array<{ name: string; cmd: Command }> {
  const here = prefix ? `${prefix} ${cmd.name()}` : cmd.name();
  // The root program's own helpInformation is not a "command tutorial";
  // skip it but still descend into its subcommands.
  const self = cmd.parent == null ? [] : [{ name: here, cmd }];
  const children = cmd.commands.flatMap((sub) => walk(sub, here));
  return [...self, ...children];
}

function renderHelp(cmd: Command): string {
  // Use Commander's per-command `configureOutput` to redirect help output into
  // a local buffer. Avoids mutating `process.stdout.write` globally, which
  // would race with other vitest workers running in parallel.
  let buffer = '';
  const writer = (text: string) => {
    buffer += text;
  };
  const previous = cmd.configureOutput();
  cmd.configureOutput({ writeOut: writer, writeErr: writer });
  try {
    cmd.outputHelp();
  } finally {
    cmd.configureOutput(previous);
  }
  return buffer;
}

// Some commands are pure aliases or wrappers where adding Examples + See also
// is redundant or impossible (no clear sibling to point at). Keep this list
// short and document why each entry is exempt.
const HELP_EXEMPT = new Set<string>([
  // Inquirer-driven; no flags, see flow's help instead.
  'dub help',
]);

const allCommands = walk(program);

describe('per-command help', () => {
  it.each(allCommands)('`$name` --help includes an Examples section', ({
    name,
    cmd,
  }) => {
    if (HELP_EXEMPT.has(name)) return;
    const help = renderHelp(cmd);
    expect(help, `Missing Examples in: ${name}`).toMatch(/Examples?:/);
  });

  it.each(
    allCommands.filter(({ cmd }) => cmd.commands.length === 0),
  )('`$name` --help includes a "See also" section (leaf commands only)', ({
    name,
    cmd,
  }) => {
    if (HELP_EXEMPT.has(name)) return;
    const help = renderHelp(cmd);
    expect(help, `Missing See also in: ${name}`).toMatch(/See also:/);
  });
});

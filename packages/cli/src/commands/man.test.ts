import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { man } from './man';

function buildFixtureProgram(): Command {
  const program = new Command();
  program
    .name('dub')
    .description('manage stacked diffs')
    .option('--verbose', 'Print verbose output');
  program
    .command('init')
    .description('Initialize DubStack in the current repository');
  program
    .command('create')
    .argument('[branch]', 'Name of the new branch')
    .option('-m, --message <message>', 'Commit message')
    .description('Create a stacked branch');
  const trunk = program
    .command('trunk')
    .description('Show or manage configured trunks');
  trunk.command('list').description('List configured trunks');
  trunk.command('add').argument('<name>').description('Register a trunk');
  return program;
}

describe('man', () => {
  it('starts with a .TH header carrying the supplied version and section', () => {
    const out = man(buildFixtureProgram(), {
      version: '9.9.9',
      date: '2026-05-25',
    });
    const firstLine = out.split('\n')[0];
    // Hyphens in date / pre-release versions become \- after roff escape.
    expect(firstLine).toBe(
      '.TH DUB 1 "2026\\-05\\-25" "DubStack 9.9.9" "User Commands"',
    );
  });

  it('escapes hyphens in pre-release version tags in the .TH header', () => {
    const out = man(buildFixtureProgram(), {
      version: '1.0.0-beta.1',
      date: '2026-01-02',
    });
    expect(out.split('\n')[0]).toBe(
      '.TH DUB 1 "2026\\-01\\-02" "DubStack 1.0.0\\-beta.1" "User Commands"',
    );
  });

  it('includes NAME, SYNOPSIS, DESCRIPTION, and COMMANDS sections', () => {
    const out = man(buildFixtureProgram(), { version: '1.0.0' });
    expect(out).toContain('.SH NAME');
    expect(out).toContain('.SH SYNOPSIS');
    expect(out).toContain('.SH DESCRIPTION');
    expect(out).toContain('.SH COMMANDS');
    expect(out).toContain('.SH SEE ALSO');
  });

  it('documents each subcommand with its description', () => {
    const out = man(buildFixtureProgram(), { version: '1.0.0' });
    expect(out).toContain('init');
    expect(out).toContain('Initialize DubStack');
    expect(out).toContain('create');
    expect(out).toContain('Create a stacked branch');
  });

  it('emits nested subcommand documentation', () => {
    const out = man(buildFixtureProgram(), { version: '1.0.0' });
    expect(out).toContain('trunk list');
    expect(out).toContain('trunk add');
  });

  it('documents options on nested subcommands (not only the parent)', () => {
    const program = new Command();
    program.name('dub').description('manage stacked diffs');
    const cfg = program.command('config').description('Manage config');
    cfg
      .command('ai-provider')
      .option('--clear', 'Clear the override')
      .description('Set the AI provider');
    const out = man(program, { version: '1.0.0' });
    // The nested command should appear as a labelled .TP entry with its
    // option in an indented .RS block underneath. Hyphens render as `\-`
    // in roff after escapeRoff.
    expect(out).toContain('config ai\\-provider');
    expect(out).toContain('\\-\\-clear');
    expect(out).toContain('Clear the override');
  });

  it('renders alias suffix with a space separating it from the command name', () => {
    const program = new Command();
    program.name('dub').description('manage stacked diffs');
    program.command('checkout').alias('co').description('Checkout a branch');
    const out = man(program, { version: '1.0.0' });
    // Regression: escapeRoff used to strip the leading space inside the
    // suffix, producing "checkout(aliases: co)". Now the space lives
    // outside the escaped fragment.
    expect(out).toMatch(
      /checkout\\fR \\&\(aliases: co\)|checkout\\fR \(aliases: co\)/,
    );
  });

  it('escapes hyphens as \\- so man rendering preserves them', () => {
    const out = man(buildFixtureProgram(), { version: '1.0.0' });
    // Description "Print verbose output" contains no hyphen, but
    // the SEE ALSO line references gh(1) without one. Use the SYNOPSIS
    // glyphs which always carry hyphens.
    expect(out).toContain('\\-');
  });

  it('escapes a backslash in user-supplied descriptions', () => {
    const program = new Command();
    program.name('dub').description('manage stacked diffs');
    program.command('weird').description('contains \\backslash here');
    const out = man(program, { version: '1.0.0' });
    // Original backslash must be doubled so groff treats it as a literal.
    expect(out).toContain('\\\\backslash');
  });

  it('renders as valid roff via a system roff formatter when available', () => {
    const out = man(buildFixtureProgram(), { version: '1.0.0' });
    // Prefer mandoc (BSD/macOS), fall back to groff (GNU). Both consume the
    // same input via stdin and emit a plain-text rendering on stdout.
    const candidates = [
      ['mandoc', ['-Tutf8']],
      ['groff', ['-man', '-Tutf8']],
    ] as const;
    for (const [bin, args] of candidates) {
      const result = spawnSync(bin, args, { input: out, encoding: 'utf8' });
      if (
        result.error &&
        (result.error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        continue;
      }
      expect(result.status, result.stderr).toBe(0);
      // Strip backspace overstrike (used by formatters to bold/underline) so
      // assertions match the rendered text regardless of formatter choice.
      const backspace = String.fromCharCode(8);
      const stripped = result.stdout.replace(
        new RegExp(`.${backspace}`, 'g'),
        '',
      );
      expect(stripped).toContain('DUB(1)');
      expect(stripped).toContain('NAME');
      expect(stripped).toContain('init');
      return;
    }
    // Neither formatter installed; structural assertions above already
    // exercise the contract — treat this as a soft skip.
  });
});

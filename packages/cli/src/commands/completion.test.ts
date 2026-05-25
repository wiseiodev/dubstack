import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { DubError } from '../lib/errors';
import { completion } from './completion';

function buildFixtureProgram(): Command {
  const program = new Command();
  program.name('dub').description('manage stacked diffs');
  program
    .command('checkout')
    .alias('co')
    .argument('[branch]', 'Branch to checkout')
    .description('Checkout a branch');
  program
    .command('up')
    .argument('[steps]', 'Number of levels')
    .option('-n, --steps <count>', 'Number of levels')
    .description('Move up');
  program
    .command('track')
    .argument('[branch]', 'Branch to track')
    .option('-p, --parent <branch>', 'Parent branch')
    .description('Track a branch');
  program
    .command('submit')
    .option('--branch <name>', 'Submit one branch')
    .option('--dry-run', 'Preview only')
    .description('Submit stack');
  program
    .command('split')
    .option('--by-file <files...>', 'Move specific files')
    .description('Split branch');
  // `revert <target>` — positional argName "target" must NOT trigger branch
  // completion. `target` is a PR number or commit SHA.
  program
    .command('revert')
    .argument('<target>', 'PR number or commit SHA')
    .description('Revert a merged PR or commit');
  // `trunk` has subcommands AND a `[branch]` positional. Subcommands win.
  const trunk = program.command('trunk').description('Show or manage trunks');
  trunk.command('list').description('List configured trunks');
  trunk.command('add').argument('<name>').description('Add a trunk');
  return program;
}

describe('completion', () => {
  it('rejects unsupported shells with an actionable DubError', () => {
    const program = buildFixtureProgram();
    expect(() => completion(program, 'powershell')).toThrow(DubError);
    try {
      completion(program, 'powershell');
    } catch (err) {
      expect(err).toBeInstanceOf(DubError);
      const message = (err as DubError).message;
      expect(message).toContain("'powershell'");
    }
  });

  describe('bash', () => {
    it('emits a complete -F registration and references known commands', () => {
      const out = completion(buildFixtureProgram(), 'bash');
      expect(out).toContain('complete -F _dub dub');
      expect(out).toContain('checkout');
      expect(out).toContain('co');
      expect(out).toContain('track');
      expect(out).toContain('submit');
    });

    it('completes branch names for branch-arg commands', () => {
      const out = completion(buildFixtureProgram(), 'bash');
      expect(out).toContain('__dub_branches');
      expect(out).toContain('git for-each-ref');
      // The branch-arg case pattern must include the spec commands.
      expect(out).toMatch(/checkout\|co/);
      expect(out).toContain('up');
      expect(out).toContain('track');
    });

    it('emits flag completions per command from commander metadata', () => {
      const out = completion(buildFixtureProgram(), 'bash');
      expect(out).toContain('--dry-run');
      expect(out).toContain('--branch');
      expect(out).toContain('--parent');
    });

    it('parses as valid bash syntax (when bash is available)', () => {
      const out = completion(buildFixtureProgram(), 'bash');
      const result = spawnSync('bash', ['-n'], { input: out });
      if (
        result.error &&
        (result.error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return; // bash not installed; skip syntax check
      }
      expect(result.status, result.stderr?.toString()).toBe(0);
    });

    it('does not branch-complete `revert` (positional is a PR/SHA, not a branch)', () => {
      const out = completion(buildFixtureProgram(), 'bash');
      // The branch-arg case enumerates a `|`-separated pattern list. `revert`
      // must not appear inside it. We also make sure `revert` is in the
      // top-level command list so the negative assertion is meaningful.
      expect(out).toContain('revert');
      const branchCase = out.split('Branch-arg subcommands')[1] ?? '';
      const branchPattern = branchCase.split('esac')[0] ?? '';
      expect(branchPattern).not.toMatch(/\brevert\b/);
    });

    it('does not branch-complete `trunk` (subcommands take priority)', () => {
      const out = completion(buildFixtureProgram(), 'bash');
      expect(out).toContain('trunk');
      const branchCase = out.split('Branch-arg subcommands')[1] ?? '';
      const branchPattern = branchCase.split('esac')[0] ?? '';
      expect(branchPattern).not.toMatch(/\btrunk\b/);
    });
  });

  describe('zsh', () => {
    it('starts with the #compdef magic comment', () => {
      const out = completion(buildFixtureProgram(), 'zsh');
      expect(out.startsWith('#compdef dub')).toBe(true);
    });

    it('describes top-level commands with their descriptions', () => {
      const out = completion(buildFixtureProgram(), 'zsh');
      expect(out).toContain('checkout:Checkout a branch');
      expect(out).toContain('Submit stack');
    });

    it('references __dub_branches for branch-arg commands', () => {
      const out = completion(buildFixtureProgram(), 'zsh');
      expect(out).toContain('__dub_branches');
      expect(out).toContain('git for-each-ref');
    });

    it('parses as valid zsh syntax (when zsh is available)', () => {
      const out = completion(buildFixtureProgram(), 'zsh');
      const result = spawnSync('zsh', ['-n'], { input: out });
      if (
        result.error &&
        (result.error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return; // zsh not installed; skip syntax check
      }
      expect(result.status, result.stderr?.toString()).toBe(0);
    });

    it('prefers subcommand completion over branch completion for parents with both', () => {
      const out = completion(buildFixtureProgram(), 'zsh');
      // The `trunk` arm should resolve to a subcommand spec, not branches.
      const trunkArm = out.split('trunk)')[1]?.split(';;')[0] ?? '';
      expect(trunkArm).toContain('subcommand');
      expect(trunkArm).not.toContain('__dub_branches');
    });

    it('does not route `revert` to __dub_branches', () => {
      const out = completion(buildFixtureProgram(), 'zsh');
      const revertArm = out.split('revert)')[1]?.split(';;')[0] ?? '';
      expect(revertArm).not.toContain('__dub_branches');
    });

    it('guards __dub_branches against empty repos', () => {
      const out = completion(buildFixtureProgram(), 'zsh');
      // Empty `git for-each-ref` output should short-circuit before _describe.
      expect(out).toMatch(/\[\[ -z \$raw \]\] && return/);
    });
  });

  describe('fish', () => {
    it('uses fish complete -c dub syntax', () => {
      const out = completion(buildFixtureProgram(), 'fish');
      expect(out).toContain('complete -c dub');
      expect(out).toContain('__dub_no_subcommand');
      expect(out).toContain('__dub_using_command');
    });

    it('lists top-level commands as completion candidates', () => {
      const out = completion(buildFixtureProgram(), 'fish');
      expect(out).toMatch(/-a 'checkout'/);
      expect(out).toMatch(/-a 'co'/);
      expect(out).toMatch(/-a 'track'/);
      expect(out).toMatch(/-a 'submit'/);
    });

    it('emits branch completion for branch-arg commands', () => {
      const out = completion(buildFixtureProgram(), 'fish');
      expect(out).toContain('function __dub_branches');
      expect(out).toContain('(__dub_branches)');
    });

    it('parses as valid fish syntax (when fish is available)', () => {
      const out = completion(buildFixtureProgram(), 'fish');
      const result = spawnSync('fish', ['-n'], { input: out });
      if (
        result.error &&
        (result.error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return; // fish not installed; skip syntax check
      }
      expect(result.status, result.stderr?.toString()).toBe(0);
    });

    it('escapes backslashes in option descriptions', () => {
      const program = new Command();
      program.name('dub');
      program
        .command('weird')
        .option('--path <p>', 'Windows-style path like C:\\Users\\foo');
      const out = completion(program, 'fish');
      // Backslash must be doubled so fish does not interpret it as an escape.
      expect(out).toContain('C:\\\\Users\\\\foo');
    });

    it('does not branch-complete `revert`', () => {
      const out = completion(buildFixtureProgram(), 'fish');
      expect(out).not.toMatch(/__dub_using_command revert.*\(__dub_branches\)/);
    });
  });
});

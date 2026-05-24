import { describe, expect, it } from 'vitest';
import { buildBranchMetaText, formatBranchLabel } from './branch-picker-format';
import type { BranchOverview } from './stack-overview';

function overview(
  partial: Partial<BranchOverview> & { branch: string },
): BranchOverview {
  return {
    parent: null,
    isRoot: false,
    pr: null,
    commit: null,
    prLink: null,
    lastSyncedAt: null,
    syncSource: null,
    ...partial,
  };
}

describe('buildBranchMetaText', () => {
  it('returns empty string for null overview', () => {
    expect(buildBranchMetaText(null)).toBe('');
  });

  it('returns empty string when no PR and no commit metadata', () => {
    expect(buildBranchMetaText(overview({ branch: 'feat/x' }))).toBe('');
  });

  it('formats PR number, draft, CI, and age', () => {
    const text = buildBranchMetaText(
      overview({
        branch: 'feat/x',
        pr: {
          number: 42,
          title: 't',
          state: 'OPEN',
          baseRefName: 'main',
          mergedAt: null,
          reviewDecision: null,
          ciRollup: 'PENDING',
          isDraft: true,
        },
        commit: {
          committedRel: '5 minutes ago',
          authorEmail: 'a@b.com',
          shortSha: 'abcdef12',
        },
      }),
    );
    expect(text).toBe('#42 · ✏ Draft · CI ● · 5 minutes ago');
  });

  it('uses APPROVED review label and SUCCESS CI glyph', () => {
    const text = buildBranchMetaText(
      overview({
        branch: 'feat/x',
        pr: {
          number: 7,
          title: 't',
          state: 'OPEN',
          baseRefName: 'main',
          mergedAt: null,
          reviewDecision: 'APPROVED',
          ciRollup: 'SUCCESS',
          isDraft: false,
        },
      }),
    );
    expect(text).toBe('#7 · ✔ Approved · CI ✔');
  });

  it('falls back to lifecycle label for merged PR with no review decision', () => {
    const text = buildBranchMetaText(
      overview({
        branch: 'feat/x',
        pr: {
          number: 9,
          title: 't',
          state: 'MERGED',
          baseRefName: 'main',
          mergedAt: '2026-05-01T00:00:00Z',
          reviewDecision: null,
          ciRollup: 'NONE',
          isDraft: false,
        },
      }),
    );
    expect(text).toBe('#9 · ⛓ Merged · CI −');
  });

  it('shows only commit age when no PR exists', () => {
    const text = buildBranchMetaText(
      overview({
        branch: 'feat/x',
        commit: {
          committedRel: '2 hours ago',
          authorEmail: 'a@b.com',
          shortSha: 'a1b2c3d4',
        },
      }),
    );
    expect(text).toBe('2 hours ago');
  });
});

describe('formatBranchLabel', () => {
  it('returns plain branch + metadata when noColor is true', () => {
    const label = formatBranchLabel({
      branch: 'feat/a',
      region: 'current',
      overview: overview({
        branch: 'feat/a',
        commit: {
          committedRel: '1 hour ago',
          authorEmail: 'a@b.com',
          shortSha: 'abcdef12',
        },
      }),
      branchColumnWidth: 10,
      noColor: true,
    });
    expect(label).toContain('feat/a');
    expect(label).toContain('1 hour ago');
    // No ANSI escape codes when noColor is true.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape check
    expect(label).not.toMatch(/\[/);
  });

  it('returns plain branch name when no metadata and noColor is true', () => {
    const label = formatBranchLabel({
      branch: 'feat/a',
      region: 'descendant',
      overview: null,
      branchColumnWidth: 10,
      noColor: true,
    });
    expect(label).toBe('feat/a');
  });
});

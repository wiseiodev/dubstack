import { DubError } from './errors';

const TEAM_REVIEWER_RE = /^@?[^/\s]+\/[^/\s]+$/;
const USER_REVIEWER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export function parseReviewerList(value: string): string[] {
  const seen = new Set<string>();
  const reviewers = value
    .split(',')
    .map((entry) => normalizeReviewer(entry))
    .filter((entry): entry is string => entry != null)
    .filter((entry) => {
      const key = entry.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  if (reviewers.length === 0) {
    throw new DubError('Reviewer list cannot be empty.', [
      "Pass a comma-separated list like 'alice,bob,@org/team'.",
      "Run 'dub config reviewers --clear' to remove repo-default reviewers.",
    ]);
  }

  return reviewers;
}

export function formatReviewers(reviewers: string[]): string {
  return reviewers.join(',');
}

function normalizeReviewer(value: string): string | null {
  const reviewer = value.trim();
  if (!reviewer) return null;
  if (TEAM_REVIEWER_RE.test(reviewer)) return reviewer;
  if (USER_REVIEWER_RE.test(reviewer)) return reviewer;

  throw new DubError(`Invalid reviewer '${reviewer}'.`, [
    "Use GitHub usernames like 'alice' or team handles like '@org/team'.",
    "Separate multiple reviewers with commas, for example 'alice,bob,@org/team'.",
  ]);
}

import { getOctokit } from '@actions/github';
import { retry } from '@octokit/plugin-retry';
import type { OpenPullSummary, RetargetClient } from './retarget.js';

/**
 * Wraps `@actions/github`'s Octokit with the retry plugin and exposes the
 * narrow surface `runRetarget` needs. Isolating this means tests inject a
 * plain object instead of mocking Octokit internals.
 */
export function createGitHubClient(
  token: string,
  owner: string,
  repo: string,
): RetargetClient {
  const octokit = getOctokit(token, { retry: { enabled: true } }, retry);

  return {
    async listOpenPulls(): Promise<OpenPullSummary[]> {
      const results: OpenPullSummary[] = [];
      const iterator = octokit.paginate.iterator(octokit.rest.pulls.list, {
        owner,
        repo,
        state: 'open',
        per_page: 100,
      });
      for await (const page of iterator) {
        for (const pr of page.data) {
          results.push({
            number: pr.number,
            title: pr.title,
            body: pr.body ?? null,
            base: { ref: pr.base.ref },
            head: { ref: pr.head.ref },
            auto_merge: pr.auto_merge ?? null,
          });
        }
      }
      return results;
    },

    async updatePullBase(prNumber, newBase) {
      await octokit.rest.pulls.update({
        owner,
        repo,
        pull_number: prNumber,
        base: newBase,
      });
    },

    async updatePullBody(prNumber, body) {
      await octokit.rest.pulls.update({
        owner,
        repo,
        pull_number: prNumber,
        body,
      });
    },

    async postComment(prNumber, body) {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body,
      });
    },
  };
}

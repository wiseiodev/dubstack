import * as core from '@actions/core';
import { context } from '@actions/github';
import { createGitHubClient } from './octokit.js';
import {
  type MergedPullInput,
  RetargetPermissionsError,
  runRetarget,
} from './retarget.js';

/**
 * Action entrypoint. Reads `github-token`, builds a retry-enabled Octokit
 * client, and delegates to `runRetarget`. All edge cases that mean
 * "nothing to do" exit 0 with an explanatory log; only real failures
 * (permissions, network) fail the workflow.
 */
export async function run(): Promise<void> {
  try {
    const token = core.getInput('github-token', { required: true });
    const payload = context.payload;
    const pr = payload.pull_request;
    if (!pr) {
      core.info('No pull_request payload on this event — nothing to retarget.');
      return;
    }

    const merged: MergedPullInput = {
      number: pr.number as number,
      merged: pr.merged === true,
      body: (pr.body as string | null | undefined) ?? null,
      base: { ref: (pr.base as { ref: string }).ref },
    };

    const client = createGitHubClient(
      token,
      context.repo.owner,
      context.repo.repo,
    );

    const outcome = await runRetarget(client, merged, {
      info: (m) => core.info(m),
      warning: (m) => core.warning(m),
      error: (m) => core.error(m),
    });

    if (outcome.status === 'done') {
      core.setOutput('retargeted', JSON.stringify(outcome.retargeted));
      core.setOutput('skipped', JSON.stringify(outcome.skipped));
    } else {
      core.setOutput('retargeted', '[]');
      core.setOutput('skipped', '[]');
    }
    core.setOutput('status', outcome.status);
  } catch (err) {
    if (err instanceof RetargetPermissionsError) {
      core.setFailed(
        `${err.message}\nAdd this to your workflow:\n\n  permissions:\n    contents: read\n    pull-requests: write`,
      );
      return;
    }
    if (err instanceof Error) {
      core.setFailed(err.message);
      return;
    }
    core.setFailed(String(err));
  }
}

run();

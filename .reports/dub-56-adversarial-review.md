# Adversarial Review - DUB-56

Target: staged diff for DUB-56.
Focus: correctness, GitHub command safety, stack-state side effects, and docs.
Iterations: 1 local staged-diff review.

## Summary

- Critical: 0
- Major: 0
- Minor: 0
- Nitpick: 0

## Review Notes

- Queue mode preserves the existing target-selection gate and uses the same
  stack ordering as direct `merge-next`.
- `--no-queue` returns before branch-protection detection, so it cannot be
  blocked by merge queue API availability and keeps the direct merge path.
- Explicit `--queue` fails before merge, retarget, or post-merge side effects
  when branch protection does not expose `required_merge_queue`.
- Queue mode avoids child PR retargeting and `postMerge`, which matches the
  fact that GitHub has not landed or deleted the branch yet.
- GitHub helper tests cover enabled, disabled, 404/unprotected, slash-containing
  branch names, enqueue command shape, and enqueue failure recovery.
- Docs and QA artifacts match the behavior and tell users to run `dub sync`
  after the queue processes.

## Disagreements

None. The main potential concern was whether queue mode should allow PRs whose
mergeability is still pending because `gh pr merge --auto` can wait for
requirements. This command already defines "next safe PR" through the existing
MERGEABLE selection contract, so preserving that gate is intentional for this
issue rather than a regression.

## Result

No critical or major findings remain.

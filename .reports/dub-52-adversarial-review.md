# Adversarial Review - DUB-52

Target: staged diff for DUB-52
Focus: submit lifecycle correctness, GitHub command safety, config drift, docs/tests
Iterations: 1

## Reviewer A - Architect

No critical or major findings.

- The submit lifecycle is resolved once from explicit flags or repo config, and
  the existing submit push/create/update structure is preserved.
- `--publish` preflights all selected branches before pushing, so the
  no-existing-PR error does not leave a partially pushed branch.
- The config addition is normalized with backward-compatible defaulting for
  existing config files.

## Reviewer B - Skeptic

No critical or major findings.

- The mutually exclusive lifecycle flags are validated before stack and GitHub
  mutations.
- Draft creation uses the existing `createPr` idempotency path and only adds
  `--draft` to the gh invocation.
- Ready-for-review promotion calls the GitHub CLI through the same retry and
  permission-error wrapping pattern as other gh mutations.

## Cross-Review

Reviewer A's main risk area was config schema drift; typecheck exposed and the
patch fixed the one strict fixture that needed `submitDefault`. Reviewer B's
main risk area was partial mutation during `--publish`; the preflight runs
before branch pushes and the regression test asserts no push/create happens
when a PR is missing.

## Follow-Up Review

After PR publication, Copilot identified a valid dry-run gap: `--publish
--dry-run` skipped the read-only PR existence preflight, so missing PRs would
not error until a real publish. The fix now runs publish preflight in dry-run
too, adds regression coverage for the missing-PR path, and makes successful
publish dry-runs print draft-publish-specific output instead of the generic
check/create wording.

The external two-reviewer `claude --print` path from the adversarial-review
skill was attempted for this follow-up, but the local CLI returned `401 Invalid
authentication credentials`. I completed the fallback review manually against
the current PR diff and Copilot's thread.

## Outcome

Remaining critical findings: 0
Remaining major findings: 0
Remaining minor findings: 0
Remaining nitpicks: 0

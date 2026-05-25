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

## Outcome

Remaining critical findings: 0
Remaining major findings: 0
Remaining minor findings: 0
Remaining nitpicks: 0

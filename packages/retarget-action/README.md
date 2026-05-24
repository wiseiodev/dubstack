# dubstack-retarget-action

GitHub Action that retargets dependent stacked PRs when a Dubstack PR merges.

When a Dubstack PR merges, its dependents still point at the now-deleted branch
as their base. This Action fixes that — it reads the merged PR's hidden
`dubstack-metadata` block, finds open PRs whose `parent` matches the merged
branch, and updates each one's base ref (plus its own metadata) so the stack
stays valid.

Zero infra. Runs on the consuming repo's own GitHub Actions minutes. No state,
no webhook server — everything the Action needs is in the PR bodies.

## Usage

Run `dub install retarget-action` from inside a repo that uses Dubstack. That
writes `.github/workflows/dubstack-retarget.yml`:

```yaml
name: Dubstack stack retarget
on:
  pull_request:
    types: [closed]
permissions:
  contents: read
  pull-requests: write
jobs:
  retarget:
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    steps:
      - uses: wiseiodev/dubstack-retarget@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

Commit + push. On the next stack PR merge, the Action runs, retargets each
dependent, and comments on each retargeted PR explaining what happened.

## Inputs

| Name           | Required | Description                                                                                       |
| -------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `github-token` | yes      | Token used to read PR bodies and update bases. Use `${{ secrets.GITHUB_TOKEN }}` for most repos. |

## Outputs

| Name          | Description                                                                |
| ------------- | -------------------------------------------------------------------------- |
| `status`      | One of `done`, `no-dependents`, `skipped-no-metadata`, etc.                |
| `retargeted`  | JSON array of `{ number, fromBase, toBase }`.                              |
| `skipped`     | JSON array of `{ number, reason }` for dependents we deliberately skipped. |

## Edge cases

The Action is intentionally permissive. It exits 0 in the following cases:

- The merged PR has no Dubstack metadata block (a non-Dubstack PR landed in a
  repo that happens to have this Action installed).
- The metadata is legacy-shaped (no `parent` link to follow). The user
  should re-submit the affected branches with the latest `dub` CLI to refresh
  the metadata.
- A dependent PR is already retargeted (e.g. a teammate did it manually).
- A dependent PR is queued to auto-merge — racing the merge would surprise
  users; we let the auto-merge finish.

It fails the workflow only on real GitHub API errors. A `403` response on
`pulls.update` surfaces a clear hint to add `pull-requests: write` to the
workflow's `permissions:` block.

## Development

```bash
pnpm --filter dubstack-retarget-action build       # bundles src/ → dist/index.js
pnpm --filter dubstack-retarget-action typecheck   # tsc --noEmit
pnpm --filter dubstack-retarget-action test        # vitest
```

The `dist/index.js` bundle is committed because GitHub Marketplace serves the
Action straight from the tagged tree. Don't add `dist/` to `.gitignore`. CI
rebuilds the bundle and fails if `dist/` drifts from the source.

The parser at `src/pr-body-parser.ts` is a copy of
`packages/cli/src/lib/pr-body.ts`'s `parseDubstackMetadata`. A vitest test in
`test/parser-sync.test.ts` cross-runs both implementations against a shared
fixture set and fails if they ever drift.

# DubStack Styleguide

Use this as a quick implementation checklist for both human and agent contributors.

## Language And Formatting

- TypeScript + ESM imports.
- 2-space indentation.
- Single quotes for strings.
- Kebab-case file names.
- Keep changes source-first in `src/`; do not hand-edit generated output in `dist/`.

## Command Design

- Prefer explicit, user-facing behavior in command output.
- Use `DubError` for actionable failures with clear next steps.
- Keep command modules thin; move reusable logic into `src/lib/*`.
- For new Tier 3 commands, follow [`patterns/tier-3-commands.md`](patterns/tier-3-commands.md)
  and start from the scaffold in [`templates/tier-3-command.md`](templates/tier-3-command.md).
  Biome plugins under `biome-plugins/` enforce the most error-prone rules
  (`no-bare-duberror`, `no-direct-execa-gh`, `no-direct-force-push`).

## State And Git Safety

- Preserve `.git/dubstack/*` state behavior and invariants.
- Prefer additive, minimal edits over broad rewrites.
- Avoid risky git operations in automation unless explicitly requested.

## Testing

- Add or update tests when behavior changes.
- Prioritize tests for:
  - stack state handling
  - submit/restack flow correctness
  - conflict and recovery paths
  - user-facing error messages

## Verification

Run from repo root:

1. `pnpm test`
2. `pnpm typecheck`
3. `pnpm checks`

All three must pass before claiming completion.

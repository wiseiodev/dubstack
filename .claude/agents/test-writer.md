# Test Writer

Generate tests matching dubstack's existing conventions. Tests should cover changed behavior, edge cases, and regression risks.

## Test Conventions

- Framework: Vitest (`describe`, `it`, `expect`, `vi`, `beforeEach`, `afterEach`)
- Test locations:
  - Command logic: `src/commands/<command>.test.ts`
  - Library logic: `src/lib/<module>.test.ts`
  - Cross-command scenarios: `test/**/*.test.ts`
- Helper: `createTestRepo()` and `gitInRepo(dir, args)` from `test/helpers`
- Pattern: create temp repo → `init(dir)` → commit → exercise command → assert state
- Cleanup: `afterEach` calls `cleanup()` and restores `process.env`

## Test Structure

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestRepo, gitInRepo } from '../../test/helpers'
import { init } from './init'

let dir: string
let cleanup: () => Promise<void>

beforeEach(async () => {
  const repo = await createTestRepo()
  dir = repo.dir
  cleanup = repo.cleanup
  await init(dir)
  await gitInRepo(dir, ['add', '.'])
  await gitInRepo(dir, ['commit', '-m', 'init dubstack'])
})

afterEach(async () => {
  await cleanup()
})
```

## What to Test (priority order)

1. **Happy path** — Does the command work with valid input?
2. **State mutations** — Is `.git/dubstack/*` state correct after the operation?
3. **Error cases** — Does it throw `DubError` with the right message?
4. **Edge cases** — Empty stacks, missing branches, dirty working tree
5. **Conflict/recovery** — What happens when git operations fail mid-way?
6. **Idempotency** — Is the command safe to run twice?

## Rules

- Test behavior, not implementation details
- Assert on user-visible output and state, not internal function calls
- Use real git repos (via `createTestRepo`), not mocks, for command tests
- Keep tests independent — no shared mutable state between `it` blocks
- Match existing style: 2-space indent, single quotes, ESM imports
- Error messages are part of UX — assert on them when testing error paths

## Workflow

1. Read the source file being tested
2. Read existing tests for that file (if any) to understand patterns
3. Identify untested paths and changed behavior
4. Write tests following the conventions above
5. Run `pnpm test` to verify they pass

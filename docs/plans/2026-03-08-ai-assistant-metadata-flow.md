# AI Assistant Metadata and Flow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add repo-configurable AI metadata generation for `create`, `submit`, and a new `flow` command, then document and teach the workflow across the docs site and bundled skills.

**Architecture:** Extend the existing repo-local AI config with per-command defaults, extract shared AI metadata generation into a reusable library, and keep `create`, `submit`, and `flow` as thin command surfaces over that shared logic. Preserve deterministic DubStack PR metadata while inserting AI-authored PR summaries via explicit body markers, then follow with docs, skill, and terminal-UX updates.

**Tech Stack:** TypeScript, Commander, Vitest, AI SDK, `gh` CLI integration, Fumadocs MDX content

---

## Implementation Notes

- Work in the current checkout. This repo explicitly does not use git worktrees.
- Do not run `git add`, `git commit`, or `git push` unless the user explicitly asks.
- Follow TDD for each behavior change.
- After any code changes, run `pnpm checks`, `pnpm typecheck`, and `pnpm test` from `/Users/wise/dev/dubstack`.

### Task 1: Add config support for AI defaults

**Files:**
- Modify: `packages/cli/src/lib/config.ts`
- Modify: `packages/cli/src/lib/config.test.ts`
- Modify: `packages/cli/src/commands/config.ts`
- Modify: `packages/cli/src/commands/config.test.ts`
- Modify: `packages/cli/src/index.ts`

**Step 1: Write the failing config-shape tests**

Add tests that expect `readConfig()` and `writeConfig()` to round-trip:

```ts
expect(config.ai.defaults).toEqual({
  createMetadata: false,
  submitDescription: false,
  flow: false,
});
```

Add tests for missing and partial config data to verify normalization preserves defaults.

**Step 2: Run the targeted tests to verify failure**

Run:

```bash
pnpm vitest packages/cli/src/lib/config.test.ts packages/cli/src/commands/config.test.ts
```

Expected: failing assertions because `ai.defaults` and new config commands do not exist yet.

**Step 3: Add minimal config schema support**

Implement `ai.defaults` in `packages/cli/src/lib/config.ts` and normalize booleans defensively:

```ts
defaults: {
  createMetadata:
    typeof defaults?.createMetadata === 'boolean'
      ? defaults.createMetadata
      : false,
  submitDescription:
    typeof defaults?.submitDescription === 'boolean'
      ? defaults.submitDescription
      : false,
  flow:
    typeof defaults?.flow === 'boolean' ? defaults.flow : false,
}
```

**Step 4: Extend config commands**

Add command helpers for:

```ts
configAiDefaults(cwd, 'create' | 'submit' | 'flow', 'on' | 'off' | undefined)
```

Then wire new `dub config ai-defaults ...` subcommands in `packages/cli/src/index.ts`.

**Step 5: Re-run the targeted tests**

Run:

```bash
pnpm vitest packages/cli/src/lib/config.test.ts packages/cli/src/commands/config.test.ts
```

Expected: PASS.

### Task 2: Extract shared AI metadata helpers

**Files:**
- Create: `packages/cli/src/lib/ai-metadata.ts`
- Create: `packages/cli/src/lib/ai-metadata.test.ts`
- Modify: `packages/cli/src/commands/create.ts`

**Step 1: Write failing tests for provider resolution and create metadata parsing**

Add tests that cover:

- Gemini provider selection
- Gateway fallback
- missing-key failure
- create metadata JSON parsing and validation

Example expectations:

```ts
await expect(generateCreateMetadata(diff, deps)).resolves.toEqual({
  branch: 'feat/example',
  message: 'feat: example',
});
```

**Step 2: Run the targeted tests to verify failure**

Run:

```bash
pnpm vitest packages/cli/src/lib/ai-metadata.test.ts packages/cli/src/commands/create.test.ts
```

Expected: module-not-found or failing expectations.

**Step 3: Move create AI logic into the shared helper**

Extract:

- model resolution
- prompt building
- JSON extraction
- conventional commit validation
- diff redaction and truncation

Keep `create.ts` focused on command behavior:

```ts
const generated = await generateCreateMetadata(stagedDiff, deps);
branchName = generated.branch;
commitMessage = generated.message;
```

**Step 4: Re-run the targeted tests**

Run:

```bash
pnpm vitest packages/cli/src/lib/ai-metadata.test.ts packages/cli/src/commands/create.test.ts
```

Expected: PASS.

### Task 3: Add tri-state AI behavior to `dub create`

**Files:**
- Modify: `packages/cli/src/commands/create.ts`
- Modify: `packages/cli/src/commands/create.test.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `apps/docs/content/docs/commands/create.mdx`

**Step 1: Write failing command tests for `--no-ai` and repo defaults**

Add tests for:

- repo default enables AI when no flag is passed
- `--no-ai` disables AI even when repo default is on
- `--ai` overrides repo default off
- manual `-m` still conflicts with forced AI

Example:

```ts
await create(undefined as unknown as string, dir, { noAi: true });
```

should fail with the manual-mode branch-name requirement instead of calling AI.

**Step 2: Run the targeted tests to verify failure**

Run:

```bash
pnpm vitest packages/cli/src/commands/create.test.ts
```

Expected: failing expectations because tri-state AI resolution does not exist.

**Step 3: Implement tri-state option resolution**

Add command options for:

```ts
ai?: boolean;
noAi?: boolean;
```

Then resolve AI mode with:

```ts
const useAi =
  options.ai === true ? true
  : options.noAi === true ? false
  : config.ai.defaults.createMetadata;
```

Reject invalid combinations such as `--ai` with `--no-ai`.

**Step 4: Re-run the targeted tests**

Run:

```bash
pnpm vitest packages/cli/src/commands/create.test.ts
```

Expected: PASS.

### Task 4: Add AI-managed PR description support to `submit`

**Files:**
- Modify: `packages/cli/src/commands/submit.ts`
- Modify: `packages/cli/src/commands/submit.test.ts`
- Modify: `packages/cli/src/lib/pr-body.ts`
- Modify: `packages/cli/src/lib/pr-body.test.ts`
- Modify: `packages/cli/src/lib/ai-metadata.ts`

**Step 1: Write failing tests for AI PR summary composition**

Add `pr-body` tests that verify:

- AI summary sections can be inserted
- existing AI summary sections can be replaced
- user-written content is preserved
- DubStack metadata blocks remain intact

Add submit tests that verify:

- `submit --ai` requests a generated PR summary
- PR titles still come from `getLastCommitMessage`
- existing PRs get updated bodies rather than rewritten titles

**Step 2: Run the targeted tests to verify failure**

Run:

```bash
pnpm vitest packages/cli/src/lib/pr-body.test.ts packages/cli/src/commands/submit.test.ts
```

Expected: failing expectations because AI body markers and submit AI generation do not exist.

**Step 3: Implement AI summary markers and composer helpers**

Extend `pr-body.ts` with helpers like:

```ts
buildAiSummarySection(summary: string): string
stripAiSummarySection(body: string): string
composePrBody(existingBody, aiSummary, stackTable, metadataBlock): string
```

Use explicit markers so only the AI-managed summary is replaced.

**Step 4: Implement submit AI mode**

Add tri-state AI resolution to `submit`, then call a shared helper such as:

```ts
const summary = await generatePrDescriptionSummary(context, deps);
```

Use diff-vs-parent, branch name, base branch, and commit title as prompt context.

If the user chooses to edit generated PR text, write it to a temporary markdown file, apply it through a file-backed `gh` command, and clean up the temp file afterward.

**Step 5: Re-run the targeted tests**

Run:

```bash
pnpm vitest packages/cli/src/lib/pr-body.test.ts packages/cli/src/commands/submit.test.ts
```

Expected: PASS.

### Task 5: Add `dub flow` and `dub f`

**Files:**
- Create: `packages/cli/src/commands/flow.ts`
- Create: `packages/cli/src/commands/flow.test.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/src/commands/create.ts`
- Modify: `packages/cli/src/commands/submit.ts`

**Step 1: Write failing tests for flow orchestration**

Add tests that verify:

- flow stages changes according to `-a`, `-u`, or `-p`
- flow previews AI metadata before mutating
- `-y` skips confirmation
- flow can route generated commit and PR text through separate temp markdown files for editing
- flow calls create and submit in sequence
- `dub f` works as an alias

**Step 2: Run the targeted tests to verify failure**

Run:

```bash
pnpm vitest packages/cli/src/commands/flow.test.ts
```

Expected: failing expectations because the command does not exist.

**Step 3: Implement minimal orchestration**

Create a thin command wrapper that:

1. resolves AI mode
2. stages changes
3. generates metadata preview
4. renders the preview with terminal markdown
5. prompts unless `-y`
6. optionally writes commit and PR text to separate temp markdown files for editing
7. delegates to `create`
8. delegates to `submit`

Keep business rules in reusable helpers rather than inside `index.ts`.

**Step 4: Re-run the targeted tests**

Run:

```bash
pnpm vitest packages/cli/src/commands/flow.test.ts
```

Expected: PASS.

### Task 6: Expand docs and bundled skills

**Files:**
- Modify: `apps/docs/content/docs/guides/ai-assistant.mdx`
- Modify: `apps/docs/content/docs/commands/create.mdx`
- Modify: `apps/docs/content/docs/commands/submit.mdx`
- Modify: `apps/docs/content/docs/index.mdx`
- Modify: `apps/docs/content/docs/getting-started/quickstart.mdx`
- Modify: `skills/dubstack/SKILL.md`
- Modify: `skills/dub-flow/SKILL.md`
- Audit and update any additional docs pages under `apps/docs/content/docs/` that mention AI commands, AI flags, or AI capabilities

**Step 1: Write the docs changes directly from the approved design**

Update the AI guide so it becomes the complete AI overview page, including:

- setup
- `dub ai ask`
- AI shortcut usage
- `dub create --ai`
- `dub submit --ai`
- `dub flow`
- repo defaults and precedence
- AI conflict resolution

Update the bundled skills so agents learn the new setup and workflow.

Treat this as a site-wide consistency pass. Do not stop after the obvious pages above if other docs still mention old AI behavior.

**Step 2: Verify docs and skill content by inspection**

Check that examples are internally consistent and reflect the final CLI syntax:

```bash
rg -n -- 'create --ai|submit --ai|--no-ai|dub flow|dub f|ai-defaults' \
  apps/docs/content/docs skills
```

Expected: all new syntax appears consistently, and stale wording is removed.

Then run a broader audit for any remaining AI references:

```bash
rg -n -- 'dub ai|ai-assistant|--ai|--no-ai|AI conflict|branch naming|commit messages|PR description' \
  apps/docs/content/docs skills
```

Expected: every remaining mention of AI behavior is either still correct or updated in the same change.

### Task 7: Improve `dub ai ask` terminal UX

**Files:**
- Modify: `packages/cli/src/commands/ai.ts`
- Modify: `packages/cli/src/commands/ai.test.ts`
- Create: `packages/cli/src/lib/terminal-render.ts`
- Create: `packages/cli/src/lib/terminal-render.test.ts`

**Step 1: Write failing renderer tests**

Cover:

- TTY status-line rendering
- plain-mode stability for non-TTY output
- readable formatting for headings, bullets, and code fences
- readable formatting for blockquotes and tables
- explicit tool activity lines
- rendered previews for approval flows that include commit messages and PR descriptions

**Step 2: Run the targeted tests to verify failure**

Run:

```bash
pnpm vitest packages/cli/src/lib/terminal-render.test.ts packages/cli/src/commands/ai.test.ts
```

Expected: failing expectations because the richer renderer does not exist.

**Step 3: Implement a shared terminal renderer**

Extract renderer logic from `ai.ts` and support:

- concise live status labels
- visible tool activity events
- lightweight markdown rendering suitable for streaming and previews
- plain fallback for non-TTY output

Keep reasoning hidden by default and do not stream noisy internal previews.

Use the renderer in both:

- `dub ai ask`
- approval and confirmation flows for generated commit messages and PR descriptions

**Step 4: Re-run the targeted tests**

Run:

```bash
pnpm vitest packages/cli/src/lib/terminal-render.test.ts packages/cli/src/commands/ai.test.ts
```

Expected: PASS.

### Task 8: Add temp-file helpers for generated text editing

**Files:**
- Create: `packages/cli/src/lib/temp-text-file.ts`
- Create: `packages/cli/src/lib/temp-text-file.test.ts`
- Modify: `packages/cli/src/lib/git.ts`
- Modify: `packages/cli/src/lib/github.ts`
- Modify: `packages/cli/src/commands/flow.ts`
- Modify: `packages/cli/src/commands/create.ts`
- Modify: `packages/cli/src/commands/submit.ts`

**Step 1: Write failing tests for temp-file lifecycle**

Cover:

- writes separate temp markdown files for commit and PR text
- applies file-backed content through git or gh helpers
- always cleans up temp files, even on failure

**Step 2: Run the targeted tests to verify failure**

Run:

```bash
pnpm vitest packages/cli/src/lib/temp-text-file.test.ts
```

Expected: failing expectations because the helper does not exist.

**Step 3: Implement the helper and file-backed apply paths**

Add a helper that:

- creates temp markdown files with predictable prefixes
- returns the path
- deletes files in cleanup logic

Then expose file-backed helpers such as:

```ts
commitStagedFromFile(filePath, cwd)
createPr(..., bodyFile, cwd)
updatePrBody(..., bodyFile, cwd)
```

Prefer `git commit --file <path>` and `gh pr ... --body-file <path>` over inline multiline arguments.

**Step 4: Re-run the targeted tests**

Run:

```bash
pnpm vitest packages/cli/src/lib/temp-text-file.test.ts
```

Expected: PASS.

### Task 9: Run full verification

**Files:**
- No file edits

**Step 1: Run repo quality gates**

Run:

```bash
pnpm checks
pnpm typecheck
pnpm test
```

Expected: all PASS.

**Step 2: Record any failures before further edits**

If a command fails, capture the exact file and assertion/type/lint error before making follow-up changes.

**Step 3: Re-run the full suite after fixes**

Run the same three commands again until the repo is green.

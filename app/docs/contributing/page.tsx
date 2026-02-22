import type { Metadata } from "next";
import { CodeBlock } from "@/components/code-block";
import { PageNav } from "@/components/docs/page-nav";

export const metadata: Metadata = {
  title: "Contributing - DubStack Docs",
  description:
    "How to contribute to DubStack: setup, workflow, conventions, and coding agent guidance",
};

export default function ContributingPage() {
  return (
    <article>
      <h1
        id="contributing"
        className="mb-2 text-3xl font-bold text-foreground"
      >
        Contributing
      </h1>
      <p className="mb-8 text-lg text-muted-foreground">
        DubStack accepts contributions from both humans and coding agents. The
        goal is predictable, safe changes to stacked-branch workflows.
      </p>

      <h2
        id="prerequisites"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        Prerequisites
      </h2>
      <ul className="mb-4 flex flex-col gap-2 text-sm text-muted-foreground">
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          Node{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            {">=22"}
          </code>
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            pnpm
          </code>{" "}
          (
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            pnpm@10.29.1
          </code>
          )
        </li>
      </ul>
      <CodeBlock code={`pnpm install`} language="bash" />

      <h2
        id="development-workflow"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        Development Workflow
      </h2>
      <ol className="mb-4 flex flex-col gap-3 text-sm text-muted-foreground">
        <li className="flex items-start gap-3">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
            1
          </span>
          Read{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            AGENTS.md
          </code>{" "}
          (required for repo-specific conventions).
        </li>
        <li className="flex items-start gap-3">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
            2
          </span>
          Make focused source changes in{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            src/
          </code>
          .
        </li>
        <li className="flex items-start gap-3">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
            3
          </span>
          Add/update tests near the changed behavior.
        </li>
        <li className="flex items-start gap-3">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
            4
          </span>
          Run verification commands.
        </li>
        <li className="flex items-start gap-3">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
            5
          </span>
          Open a PR using the repository PR template.
        </li>
      </ol>
      <CodeBlock
        code={`pnpm test
pnpm typecheck
pnpm checks`}
        language="bash"
      />
      <p className="mt-4 text-sm text-muted-foreground">
        Before submitting stacked PRs, run{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
          dub ready
        </code>{" "}
        to validate health + submit preflight. Changes are not ready to merge
        unless all three verification commands pass.
      </p>

      <h2
        id="formatting-and-naming"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        Formatting and Naming
      </h2>
      <ul className="mb-4 flex flex-col gap-2 text-sm text-muted-foreground">
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          Biome is the source of truth for formatting/linting.
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          Use 2 spaces (not tabs) for indentation.
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          Use single quotes in JavaScript/TypeScript.
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          Use kebab-case file names.
        </li>
      </ul>

      <h2
        id="using-a-coding-agent"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        Using a Coding Agent
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        If you use Codex, Claude Code, Cursor Agent, or similar:
      </p>
      <ul className="mb-4 flex flex-col gap-2 text-sm text-muted-foreground">
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          Point the agent to{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            AGENTS.md
          </code>{" "}
          and{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            .agents/
          </code>{" "}
          docs first.
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          Keep edits minimal and scoped to the requested behavior.
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          Require tests for behavior changes.
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          Do not use git worktrees unless a maintainer explicitly asks.
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          Prefer safe, non-destructive git operations.
        </li>
      </ul>

      <h2
        id="commit-messages"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        Commit Messages (Conventional Commits)
      </h2>
      <CodeBlock
        code={`type(scope): short description

# Examples:
feat(submit): support draft PR creation
fix(restack): preserve parent mapping after rebase
test(create): cover ensureState auto-init
docs(contributing): add coding-agent workflow`}
        language="text"
      />
      <p className="mt-4 text-sm text-muted-foreground">
        Common types:{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
          feat
        </code>
        ,{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
          fix
        </code>
        ,{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
          docs
        </code>
        ,{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
          refactor
        </code>
        ,{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
          test
        </code>
        ,{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
          chore
        </code>
      </p>

      <h2
        id="pull-requests"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        Pull Requests
      </h2>
      <ul className="mb-4 flex flex-col gap-2 text-sm text-muted-foreground">
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          Keep PRs focused and reviewable.
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          Include behavioral impact and risk in PR description.
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          If UX or command semantics change, update docs in the same PR.
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            main
          </code>{" "}
          is configured for squash merge only + linear history + required checks.
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          For stacked PRs, merge in order and prefer{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            dub merge-next
          </code>{" "}
          to avoid out-of-order merges.
        </li>
      </ul>

      <PageNav currentHref="/docs/contributing" />
    </article>
  );
}

import type { Metadata } from "next";
import { CodeBlock } from "@/components/code-block";
import { CommandCard } from "@/components/docs/command-card";
import { PageNav } from "@/components/docs/page-nav";

export const metadata: Metadata = {
  title: "dub create",
  description: "Create stacked branches with commits",
};

export default function CreatePage() {
  return (
    <article>
      <h1 id="dub-create" className="mb-2 text-3xl font-bold text-foreground">
        dub create
      </h1>
      <p className="mb-8 text-lg text-muted-foreground">
        Create a branch stacked on top of the current branch, with optional
        staging and commit.
      </p>

      <h2 id="usage" className="mb-3 mt-10 text-xl font-semibold text-foreground">
        Usage
      </h2>
      <CodeBlock
        code={`# Branch only
dub create feat/my-change

# Create + commit staged changes
dub create feat/my-change -m "feat: ..."

# Stage all + create + commit
dub create feat/my-change -am "feat: ..."

# Stage tracked-file updates + create + commit
dub create feat/my-change -um "feat: ..."

# Interactive hunk staging + create + commit
dub create feat/my-change -pm "feat: ..."

# AI-generate branch + conventional commit from staged changes
dub create --ai

# Stage all, then AI-generate branch + commit
dub create -ai`}
        language="bash"
      />

      <h2 id="flags" className="mb-3 mt-10 text-xl font-semibold text-foreground">
        Flags
      </h2>
      <CommandCard
        command="dub create [branch]"
        description="Create a branch stacked on top of the current branch."
        flags={[
          { flag: "-m, --message <message>", description: "Commit message" },
          { flag: "-a, --all", description: "Stage all changes before commit (requires -m or --ai)" },
          { flag: "-u, --update", description: "Stage tracked-file updates before commit (requires -m or --ai)" },
          { flag: "-p, --patch", description: "Select hunks interactively before commit (requires -m or --ai)" },
          { flag: "-i, --ai", description: "AI-generate branch + conventional commit from staged changes" },
        ]}
      />

      <h2 id="ai-mode" className="mb-3 mt-10 text-xl font-semibold text-foreground">
        AI Mode
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        When using <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">--ai</code> or{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">-ai</code>, DubStack analyzes your
        staged changes and generates a descriptive branch name and conventional
        commit message. This requires an AI key configured via{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">dub ai env</code>.
      </p>
      <CodeBlock
        code={`# AI with explicit staging
dub create --ai

# Stage all + AI (shorthand)
dub create -ai`}
        language="bash"
      />

      <h2 id="notes" className="mb-3 mt-10 text-xl font-semibold text-foreground">
        Notes
      </h2>
      <ul className="flex flex-col gap-2 text-sm text-muted-foreground">
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">dub create</code> auto-initializes
          DubStack state if needed.
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          The new branch is always stacked on the current branch.
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          Use <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">dub undo</code> to revert the
          last create operation.
        </li>
      </ul>

      <PageNav currentHref="/docs/commands/create" />
    </article>
  );
}

import type { Metadata } from "next";
import { CodeBlock } from "@/components/code-block";
import { CommandCard } from "@/components/docs/command-card";
import { PageNav } from "@/components/docs/page-nav";

export const metadata: Metadata = {
  title: "dub track",
  description: "Track, untrack, and delete branches",
};

export default function TrackPage() {
  return (
    <article>
      <h1 id="dub-track" className="mb-2 text-3xl font-bold text-foreground">
        dub track
      </h1>
      <p className="mb-8 text-lg text-muted-foreground">
        Track existing branches, re-parent tracked branches, untrack, or delete
        with stack-aware expansion.
      </p>

      <h2 id="track" className="mb-3 mt-10 text-xl font-semibold text-foreground">
        Track
      </h2>
      <CodeBlock
        code={`# Track current branch
dub track

# Track explicit branch
dub track feat/auth-login --parent feat/auth-types

# Repair parent metadata
dub track feat/auth-login --parent main`}
        language="bash"
      />
      <CommandCard
        command="dub track [branch] [--parent <branch>]"
        description="Track an existing local branch or re-parent a tracked branch."
        flags={[
          { flag: "--parent <branch>", description: "Specify parent branch (inferred if omitted)" },
        ]}
        className="mt-4"
      />
      <p className="mt-3 text-sm text-muted-foreground">
        If <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">--parent</code> is omitted,
        DubStack tries to infer a safe default. In interactive shells, DubStack
        prompts when parent choice is ambiguous.
      </p>

      <h2 id="untrack" className="mb-3 mt-10 text-xl font-semibold text-foreground">
        Untrack
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Remove branch metadata from DubStack without deleting local git
        branches:
      </p>
      <CodeBlock
        code={`# Untrack current branch only
dub untrack

# Untrack explicit branch and descendants
dub untrack feat/auth-login --downstack`}
        language="bash"
      />

      <h2 id="delete" className="mb-3 mt-10 text-xl font-semibold text-foreground">
        Delete
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Delete local branches with stack-aware expansion and metadata repair:
      </p>
      <CodeBlock
        code={`# Delete one branch (with confirmation)
dub delete feat/auth-login

# Delete branch and descendants
dub delete feat/auth-login --upstack

# Delete branch and ancestors toward trunk
dub delete feat/auth-login --downstack

# Fully non-interactive destructive delete
dub delete feat/auth-login --upstack --force --quiet`}
        language="bash"
      />
      <CommandCard
        command="dub delete [branch]"
        description="Delete local branches with stack-aware expansion and metadata repair."
        flags={[
          { flag: "--upstack", description: "Include descendants" },
          { flag: "--downstack", description: "Include ancestors (excluding root)" },
          { flag: "-f, --force", description: "Force delete unmerged branches" },
          { flag: "-q, --quiet", description: "Skip confirmation prompt" },
        ]}
        className="mt-4"
      />

      <PageNav currentHref="/docs/commands/track" />
    </article>
  );
}

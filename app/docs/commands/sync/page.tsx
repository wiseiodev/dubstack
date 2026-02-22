import type { Metadata } from "next";
import { CodeBlock } from "@/components/code-block";
import { CommandCard } from "@/components/docs/command-card";
import { PageNav } from "@/components/docs/page-nav";

export const metadata: Metadata = {
  title: "dub sync",
  description: "Synchronize with remote and restack branches",
};

export default function SyncPage() {
  return (
    <article>
      <h1 id="dub-sync" className="mb-2 text-3xl font-bold text-foreground">
        dub sync
      </h1>
      <p className="mb-8 text-lg text-muted-foreground">
        Synchronize tracked branches with remote refs and optionally restack.
      </p>

      <h2 id="usage" className="mb-3 mt-10 text-xl font-semibold text-foreground">
        Usage
      </h2>
      <CodeBlock
        code={`# Sync current stack
dub sync

# Sync all tracked stacks
dub sync --all

# Non-interactive mode
dub sync --no-interactive

# Force destructive sync decisions
dub sync --force

# Include post-sync restack
dub sync --restack`}
        language="bash"
      />

      <CommandCard
        command="dub sync"
        description="Synchronize tracked branches with remote refs."
        flags={[
          { flag: "--all", description: "Sync all tracked stacks" },
          { flag: "--no-interactive", description: "Deterministic non-interactive mode" },
          { flag: "--force", description: "Skip prompts for destructive actions" },
          { flag: "--restack", description: "Include post-sync restack" },
        ]}
        className="mt-4"
      />

      <h2 id="behavior" className="mb-3 mt-10 text-xl font-semibold text-foreground">
        Sync Behavior
      </h2>
      <ul className="flex flex-col gap-2 text-sm text-muted-foreground">
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          Fetch tracked refs from <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">origin</code>
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          Attempt trunk fast-forward (or overwrite with <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">--force</code>)
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          Auto-clean local branches for merged PRs (and closed PRs confirmed in trunk)
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          Reconcile local/remote divergence states per branch
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          Optional restack when <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">--restack</code> is set
        </li>
      </ul>

      <h2 id="restack" className="mb-3 mt-10 text-xl font-semibold text-foreground">
        Restack
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Rebase stack branches onto updated parents:
      </p>
      <CodeBlock
        code={`dub restack

# Continue after resolving conflicts
dub restack --continue`}
        language="bash"
      />

      <PageNav currentHref="/docs/commands/sync" />
    </article>
  );
}

import type { Metadata } from "next";
import { CodeBlock } from "@/components/code-block";
import { CommandCard } from "@/components/docs/command-card";
import { PageNav } from "@/components/docs/page-nav";

export const metadata: Metadata = {
  title: "Maintenance",
  description: "Doctor, ready, prune, merge-check, merge-next, and post-merge",
};

export default function MaintenancePage() {
  return (
    <article>
      <h1 id="maintenance" className="mb-2 text-3xl font-bold text-foreground">
        Maintenance
      </h1>
      <p className="mb-8 text-lg text-muted-foreground">
        Health checks, cleanup, and safe merge commands.
      </p>

      <h2 id="doctor" className="mb-3 mt-10 text-xl font-semibold text-foreground">
        dub doctor
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Run health checks for stack metadata and submit readiness:
      </p>
      <CodeBlock
        code={`dub doctor

# Check all stacks
dub doctor --all

# Skip remote fetch
dub doctor --no-fetch`}
        language="bash"
      />
      <p className="mt-3 text-sm text-muted-foreground">
        Checks include: in-progress operation detection, missing tracked
        branches, submit blockers, and local/remote SHA drift.
      </p>

      <h2 id="ready" className="mb-3 mt-10 text-xl font-semibold text-foreground">
        dub ready
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Run pre-submit checklist (doctor + submit preflight):
      </p>
      <CodeBlock code="dub ready" language="bash" />

      <h2 id="prune" className="mb-3 mt-10 text-xl font-semibold text-foreground">
        dub prune
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Preview or remove stale tracked branch metadata:
      </p>
      <CodeBlock
        code={`# Preview only
dub prune

# Apply removals
dub prune --apply

# Include every stack
dub prune --all --apply`}
        language="bash"
      />

      <h2
        id="merge-check"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        dub merge-check
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Validate merge order for a stack PR:
      </p>
      <CodeBlock
        code={`# Check current branch PR
dub merge-check

# Check explicit PR number
dub merge-check --pr 123`}
        language="bash"
      />

      <h2
        id="merge-next"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        dub merge-next / dub land
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Merge the next safe PR in your current stack path, pre-retarget direct
        child PRs, then run post-merge maintenance:
      </p>
      <CodeBlock
        code={`dub merge-next
# alias
dub land

# Preview only
dub merge-next --dry-run`}
        language="bash"
      />

      <h2
        id="post-merge"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        dub post-merge
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Repair stack metadata and retarget remaining PRs after manual merges:
      </p>
      <CodeBlock
        code={`dub post-merge

# Preview only
dub post-merge --dry-run

# Include all stacks
dub post-merge --all`}
        language="bash"
      />

      <h2
        id="stale-recovery"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        Stale Branch Recovery
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        When submit or sync gets blocked by stale tracked branches:
      </p>
      <CodeBlock
        code={`# 1) Inspect current health
dub doctor

# 2) Preview stale branch metadata
dub prune

# 3) Remove stale metadata if confirmed
dub prune --apply

# 4) Re-run pre-submit checks
dub ready

# 5) Submit current linear path
dub submit --path current`}
        language="bash"
      />

      <PageNav currentHref="/docs/commands/maintenance" />
    </article>
  );
}

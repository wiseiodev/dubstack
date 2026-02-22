import type { Metadata } from "next";
import { CodeBlock } from "@/components/code-block";
import { PageNav } from "@/components/docs/page-nav";

export const metadata: Metadata = {
  title: "Workflows - DubStack Docs",
  description: "Copy-paste workflow playbooks for common DubStack operations",
};

export default function WorkflowsPage() {
  return (
    <article>
      <h1
        id="workflows"
        className="mb-2 text-3xl font-bold text-foreground"
      >
        Workflows
      </h1>
      <p className="mb-8 text-lg text-muted-foreground">
        Copy-paste playbooks for the most common stacked PR operations.
      </p>

      <h2
        id="create-and-submit"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        1. Create and Submit a New Stack
      </h2>
      <CodeBlock
        code={`git checkout main
git pull

dub create feat/base -am "feat: add base layer"
dub create feat/middle -am "feat: add middle layer"
dub create feat/top -am "feat: add top layer"

dub log
dub ss`}
        language="bash"
      />

      <h2
        id="update-middle-branch"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        2. Update a Middle Branch After Review
      </h2>
      <CodeBlock
        code={`dub co feat/middle

# edit files...
dub m -a -m "fix: address review feedback"

# optional diff check before modify
dub m -vv

dub ss`}
        language="bash"
      />

      <h2
        id="sync-after-trunk"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        3. Sync After Trunk Moves
      </h2>
      <CodeBlock
        code={`git checkout main
git pull

dub sync`}
        language="bash"
      />
      <p className="mb-4 mt-4 text-sm text-muted-foreground">
        For deterministic non-interactive behavior:
      </p>
      <CodeBlock code={`dub sync --no-interactive`} language="bash" />
      <p className="mb-4 mt-4 text-sm text-muted-foreground">
        For explicit destructive reconciliation:
      </p>
      <CodeBlock code={`dub sync --force`} language="bash" />

      <h2
        id="conflict-recovery"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        4. Conflict Recovery During Restack
      </h2>
      <CodeBlock
        code={`dub restack
# conflict occurs

# resolve files
git add <resolved-files>

dub restack --continue`}
        language="bash"
      />
      <p className="mb-4 mt-4 text-sm text-muted-foreground">
        If you are already mid-operation, use the unified recovery commands:
      </p>
      <CodeBlock
        code={`dub continue
# or
dub abort`}
        language="bash"
      />

      <h2
        id="open-pr"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        5. Open PR Quickly
      </h2>
      <CodeBlock
        code={`dub pr
# or
dub pr feat/top
# or
dub pr 123`}
        language="bash"
      />

      <h2
        id="undo-mistakes"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        6. Recover from Mistakes
      </h2>
      <CodeBlock code={`dub undo`} language="bash" />
      <ul className="mt-4 flex flex-col gap-2 text-sm text-muted-foreground">
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            undo
          </code>{" "}
          supports one level.
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          Intended for reverting last{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            create
          </code>{" "}
          or{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            restack
          </code>
          .
        </li>
      </ul>

      <h2
        id="repair-untracked"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        7. Repair Untracked Branch Metadata
      </h2>
      <CodeBlock
        code={`# Branch created outside dub create
git checkout feat/manual

dub track feat/manual --parent main

# Verify placement
dub parent feat/manual
dub trunk feat/manual`}
        language="bash"
      />

      <h2
        id="remove-metadata-delete"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        8. Remove Metadata or Delete Branches Safely
      </h2>
      <CodeBlock
        code={`# Metadata-only removal
dub untrack feat/top

# Remove branch + descendants from metadata
dub untrack feat/middle --downstack

# Delete branch with confirmation
dub delete feat/top

# Delete branch and descendants non-interactively
dub delete feat/middle --upstack --force --quiet`}
        language="bash"
      />

      <h2
        id="stack-inspection"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        9. Stack Inspection Modes
      </h2>
      <CodeBlock
        code={`dub log --stack
dub log --all
dub log --reverse`}
        language="bash"
      />

      <h2
        id="stack-navigation"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        10. Stack Navigation Patterns
      </h2>
      <CodeBlock
        code={`dub up
dub up 2
dub down
dub down --steps 2
dub top
dub bottom`}
        language="bash"
      />

      <h2
        id="checkout-patterns"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        11. Checkout Patterns
      </h2>
      <CodeBlock
        code={`# Interactive
dub checkout

# Interactive current stack only
dub checkout --stack

# Include untracked branches
dub checkout --show-untracked

# Jump to trunk
dub checkout --trunk`}
        language="bash"
      />

      <h2
        id="merge-safely"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        12. Merge Stacks Safely (Bottom-Up)
      </h2>
      <CodeBlock
        code={`# Merge next safe PR in stack order
dub merge-next

# Run again for the next layer
dub merge-next`}
        language="bash"
      />
      <p className="mb-4 mt-4 text-sm text-muted-foreground">
        If you merged manually, normalize state and retarget remaining PRs:
      </p>
      <CodeBlock code={`dub post-merge`} language="bash" />

      <PageNav currentHref="/docs/workflows" />
    </article>
  );
}

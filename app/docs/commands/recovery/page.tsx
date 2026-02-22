import type { Metadata } from "next";
import { CodeBlock } from "@/components/code-block";
import { PageNav } from "@/components/docs/page-nav";

export const metadata: Metadata = {
  title: "Recovery",
  description: "Continue, abort, and undo operations",
};

export default function RecoveryPage() {
  return (
    <article>
      <h1 id="recovery" className="mb-2 text-3xl font-bold text-foreground">
        Recovery
      </h1>
      <p className="mb-8 text-lg text-muted-foreground">
        Commands for resuming, canceling, and undoing stack operations.
      </p>

      <h2
        id="continue-abort"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        Continue / Abort
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Unified recovery pair for interrupted restacks and rebases:
      </p>
      <CodeBlock
        code={`# Continue active restack/rebase
dub continue

# Abort active restack/rebase
dub abort`}
        language="bash"
      />
      <p className="mt-3 text-sm text-muted-foreground">
        Use these when the CLI reports conflicts or an in-progress operation.
        The typical flow after a conflict is:
      </p>
      <CodeBlock
        code={`# 1. Resolve conflicts in your editor
# 2. Stage resolved files
git add <resolved-files>
# 3. Continue
dub continue`}
        language="bash"
        className="mt-3"
      />

      <h2 id="undo" className="mb-3 mt-10 text-xl font-semibold text-foreground">
        Undo
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Undo the last <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">dub create</code> or{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">dub restack</code> operation:
      </p>
      <CodeBlock code="dub undo" language="bash" />
      <ul className="mt-4 flex flex-col gap-2 text-sm text-muted-foreground">
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          Supports one level of undo
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          Intended for reverting the most recent create or restack
        </li>
      </ul>

      <PageNav currentHref="/docs/commands/recovery" />
    </article>
  );
}

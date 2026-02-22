import type { Metadata } from "next";
import { CodeBlock } from "@/components/code-block";
import { CommandCard } from "@/components/docs/command-card";
import { PageNav } from "@/components/docs/page-nav";

export const metadata: Metadata = {
  title: "dub submit",
  description: "Push branches and create/update PRs",
};

export default function SubmitPage() {
  return (
    <article>
      <h1 id="dub-submit" className="mb-2 text-3xl font-bold text-foreground">
        dub submit
      </h1>
      <p className="mb-8 text-lg text-muted-foreground">
        Push branches and create or update pull requests for your stack.
      </p>

      <h2 id="submit-usage" className="mb-3 mt-10 text-xl font-semibold text-foreground">
        Submit
      </h2>
      <CodeBlock
        code={`dub submit
dub ss

# Preview only
dub submit --dry-run

# Submit only current linear path (default)
dub submit --path current

# Submit the whole stack graph
dub submit --path stack

# Auto-fallback to current path when stack-mode is blocked
dub submit --path stack --fix`}
        language="bash"
      />

      <CommandCard
        command="dub submit"
        aliases={["dub ss"]}
        description="Push branches and create or update PRs."
        flags={[
          { flag: "--dry-run", description: "Preview submit actions without executing" },
          { flag: "--path current", description: "Submit only current linear path (default)" },
          { flag: "--path stack", description: "Submit the whole stack graph" },
          { flag: "--fix", description: "Auto-fallback to current path when stack-mode is blocked" },
        ]}
        className="mt-4"
      />

      <h2 id="dub-pr" className="mb-3 mt-10 text-xl font-semibold text-foreground">
        Open PR in Browser
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Use <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">dub pr</code> to open a PR in
        your browser via <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">gh</code>:
      </p>
      <CodeBlock
        code={`# Current branch PR
dub pr

# Explicit branch / PR target
dub pr feat/auth-login
dub pr 123`}
        language="bash"
      />

      <PageNav currentHref="/docs/commands/submit" />
    </article>
  );
}

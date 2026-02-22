import type { Metadata } from "next";
import { CodeBlock } from "@/components/code-block";
import { CommandCard } from "@/components/docs/command-card";
import { PageNav } from "@/components/docs/page-nav";

export const metadata: Metadata = {
  title: "dub log",
  description: "Visualize your stack as an ASCII tree",
};

export default function LogPage() {
  return (
    <article>
      <h1 id="dub-log" className="mb-2 text-3xl font-bold text-foreground">
        dub log
      </h1>
      <p className="mb-8 text-lg text-muted-foreground">
        Render tracked stacks as an ASCII tree for quick visual inspection.
      </p>

      <h2 id="usage" className="mb-3 mt-10 text-xl font-semibold text-foreground">
        Usage
      </h2>
      <CodeBlock
        code={`dub log
dub ls
dub l

# Show only current stack
dub log --stack

# Show all stacks explicitly
dub log --all

# Reverse branch ordering for quick top-down scan
dub log --reverse`}
        language="bash"
      />

      <CommandCard
        command="dub log"
        aliases={["dub ls", "dub l"]}
        description="Render tracked stacks as an ASCII tree."
        flags={[
          { flag: "--stack", description: "Show only current stack" },
          { flag: "--all", description: "Show all stacks explicitly" },
          { flag: "--reverse", description: "Reverse branch ordering" },
        ]}
        className="mt-4"
      />

      <h2 id="example-output" className="mb-3 mt-10 text-xl font-semibold text-foreground">
        Example Output
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        A typical stack looks like this:
      </p>
      <CodeBlock
        code={`(main)
  └─ feat/auth-types
       └─ feat/auth-login
            └─ feat/auth-tests   ← you are here`}
        language="text"
      />

      <h2 id="branch-info" className="mb-3 mt-10 text-xl font-semibold text-foreground">
        Branch Info
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        For detailed metadata about a specific branch:
      </p>
      <CodeBlock
        code={`# Current branch
dub info

# Explicit branch
dub info feat/auth-login`}
        language="bash"
      />

      <PageNav currentHref="/docs/commands/log" />
    </article>
  );
}

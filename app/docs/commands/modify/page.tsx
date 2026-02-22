import type { Metadata } from "next";
import { CodeBlock } from "@/components/code-block";
import { CommandCard } from "@/components/docs/command-card";
import { PageNav } from "@/components/docs/page-nav";

export const metadata: Metadata = {
  title: "dub modify",
  description: "Amend or create commits on the current branch, then restack",
};

export default function ModifyPage() {
  return (
    <article>
      <h1 id="dub-modify" className="mb-2 text-3xl font-bold text-foreground">
        dub modify
      </h1>
      <p className="mb-8 text-lg text-muted-foreground">
        Amend or create commits on the current branch, then automatically
        restack descendants.
      </p>

      <h2 id="usage" className="mb-3 mt-10 text-xl font-semibold text-foreground">
        Usage
      </h2>
      <CodeBlock
        code={`# Amend current commit
dub modify

# Create a new commit
dub modify -c -m "fix: ..."

# Interactive staging
dub modify -p

# Stage all tracked updates
dub modify -u

# Show staged diff before modify
dub modify -v

# Show staged + unstaged diff before modify
dub modify -vv

# Interactive rebase of this branch's commits
dub modify --interactive-rebase`}
        language="bash"
      />

      <h2 id="flags" className="mb-3 mt-10 text-xl font-semibold text-foreground">
        Flags
      </h2>
      <CommandCard
        command="dub modify"
        aliases={["dub m"]}
        description="Amend or create commits on the current branch, then restack descendants."
        flags={[
          { flag: "-a, --all", description: "Stage all changes" },
          { flag: "-u, --update", description: "Stage tracked-file updates" },
          { flag: "-p, --patch", description: "Interactive hunk staging" },
          { flag: "-c, --commit", description: "Create a new commit instead of amending" },
          { flag: "-e, --edit", description: "Edit the commit message" },
          { flag: "-m, --message <msg>", description: "Commit message (repeatable)" },
          { flag: "-v, --verbose", description: "Show diff before modify (repeatable: -vv for staged+unstaged)" },
          { flag: "--interactive-rebase", description: "Interactive rebase of branch commits" },
        ]}
      />

      <h2 id="examples" className="mb-3 mt-10 text-xl font-semibold text-foreground">
        Common Patterns
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Address review feedback on a middle branch:
      </p>
      <CodeBlock
        code={`# Jump to the branch
dub co feat/auth-login

# Edit files, then amend + restack descendants
dub m -a -m "fix: address review feedback"

# Push updates
dub ss`}
        language="bash"
      />

      <PageNav currentHref="/docs/commands/modify" />
    </article>
  );
}

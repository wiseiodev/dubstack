import type { Metadata } from "next";
import { CodeBlock, InlineCode } from "@/components/code-block";
import { PageNav } from "@/components/docs/page-nav";

export const metadata: Metadata = {
  title: "Quick Start",
  description: "Get up and running with DubStack in minutes",
};

export default function QuickStartPage() {
  return (
    <article>
      <h1 id="quick-start" className="mb-2 text-3xl font-bold text-foreground">
        Quick Start
      </h1>
      <p className="mb-8 text-lg text-muted-foreground">
        Get from zero to a working stacked PR flow fast.
      </p>

      <h2
        id="prerequisites"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        Prerequisites
      </h2>
      <div className="mb-6 flex flex-col gap-3 text-sm">
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="mb-1 font-medium text-foreground">
            <InlineCode>git</InlineCode> installed
          </p>
          <p className="text-muted-foreground">Version control must be available on your system.</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="mb-2 font-medium text-foreground">
            <InlineCode>gh</InlineCode> CLI authenticated
          </p>
          <CodeBlock code="gh auth login" language="bash" />
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="mb-2 font-medium text-foreground">
            <InlineCode>dub</InlineCode> installed
          </p>
          <div className="flex flex-col gap-2">
            <div>
              <p className="mb-1 text-xs text-muted-foreground">Homebrew</p>
              <CodeBlock code={`brew tap wiseiodev/dubstack\nbrew install dubstack`} language="bash" />
            </div>
            <div>
              <p className="mb-1 text-xs text-muted-foreground">npm</p>
              <CodeBlock code="npm i -g dubstack" language="bash" />
            </div>
          </div>
        </div>
      </div>

      <h2
        id="enable-ai"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        Optional: Enable AI Assistant
      </h2>
      <CodeBlock
        code={`# Add one API key to your shell profile
dub ai env --gemini-key "<your-gemini-key>"
# or:
dub ai env --gateway-key "<your-ai-gateway-key>"

# Reload your shell
source ~/.zshrc

# Enable assistant for this repo
dub config ai-assistant on

# Ask a question
dub ai ask "Summarize this stack from trunk to current branch"`}
        language="bash"
      />

      <h2
        id="start-from-trunk"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        1. Start from Trunk
      </h2>
      <CodeBlock
        code={`git checkout main
git pull`}
        language="bash"
      />

      <h2
        id="create-a-stack"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        2. Create a Stack
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Create three stacked branches with commits:
      </p>
      <CodeBlock
        code={`# Layer 1
dub create feat/auth-types -am "feat: add auth types"

# Layer 2 (parent: feat/auth-types)
dub create feat/auth-login -am "feat: add login flow"

# Layer 3 (parent: feat/auth-login)
dub create feat/auth-tests -am "test: add auth tests"`}
        language="bash"
      />

      <h2
        id="inspect-and-navigate"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        3. Inspect and Navigate
      </h2>
      <CodeBlock
        code={`# View stack tree
dub log

# Interactive checkout
dub co

# Move around current path
dub up
dub down
dub top
dub bottom`}
        language="bash"
      />

      <h2
        id="submit-stack"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        4. Submit Stack PRs
      </h2>
      <CodeBlock
        code={`# Submit stack
dub ss

# Preview only
dub ss --dry-run

# Open PR in browser
dub pr`}
        language="bash"
      />

      <h2
        id="respond-to-feedback"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        5. Respond to Feedback
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        When feedback lands on a middle branch:
      </p>
      <CodeBlock
        code={`dub co feat/auth-login

# Amend current commit
dub m -a -m "fix: address review feedback"

# Or create a new commit
dub m -c -a -m "fix: follow-up"

# Push updates
dub ss`}
        language="bash"
      />

      <h2
        id="keep-in-sync"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        6. Keep Stack in Sync
      </h2>
      <CodeBlock
        code={`git checkout main
git pull
dub sync`}
        language="bash"
      />

      <h2
        id="handle-conflicts"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        7. Handle Restack Conflicts
      </h2>
      <CodeBlock
        code={`dub restack
# Resolve conflicts in files
git add <resolved-files>
dub restack --continue`}
        language="bash"
      />

      <h2
        id="merge-safely"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        8. Merge in Safe Order
      </h2>
      <CodeBlock
        code={`# Merge next safe PR in stack order
dub merge-next

# Run again for the next layer
dub merge-next

# If merges happened manually
dub post-merge`}
        language="bash"
      />

      <h2
        id="fast-command-list"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        Fast Command List
      </h2>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="px-4 py-3 text-left font-medium text-foreground">
                Command
              </th>
              <th className="px-4 py-3 text-left font-medium text-foreground">
                Purpose
              </th>
            </tr>
          </thead>
          <tbody>
            {[
              ["dub create <name> -am \"msg\"", "Stage all + create + commit"],
              ["dub m", "Modify current branch commit(s)"],
              ["dub log", "Show stack graph"],
              ["dub co", "Interactive checkout"],
              ["dub ss", "Submit stack PRs"],
              ["dub pr", "Open PR in browser"],
              ["dub sync", "Sync local state with remote"],
              ["dub doctor", "Run stack health checks"],
              ["dub ready", "Run pre-submit checklist"],
              ["dub restack", "Rebase stack onto updated parents"],
              ["dub merge-next", "Merge next safe PR + maintenance"],
              ["dub continue / dub abort", "Resume/cancel operations"],
              ["dub undo", "Undo last create/restack"],
              ["dub ai ask \"...\"", "Ask AI assistant"],
            ].map(([cmd, desc]) => (
              <tr
                key={cmd}
                className="border-b border-border last:border-0"
              >
                <td className="px-4 py-2.5">
                  <code className="font-mono text-xs text-primary">{cmd}</code>
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <PageNav currentHref="/docs" />
    </article>
  );
}

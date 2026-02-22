import type { Metadata } from "next";
import { CodeBlock } from "@/components/code-block";
import { PageNav } from "@/components/docs/page-nav";

export const metadata: Metadata = {
  title: "Troubleshooting - DubStack Docs",
  description:
    "Common issues and solutions for DubStack",
};

export default function TroubleshootingPage() {
  const issues = [
    {
      problem: "gh CLI not found",
      solution: (
        <>
          Install GitHub CLI:{" "}
          <a
            href="https://cli.github.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-2 hover:text-primary/80"
          >
            cli.github.com
          </a>
        </>
      ),
    },
    {
      problem: "Not authenticated with GitHub",
      solution: (
        <>
          Run{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            gh auth login
          </code>
        </>
      ),
    },
    {
      problem: "Branch not part of stack",
      solution: (
        <>
          Create via{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            dub create
          </code>{" "}
          or run from a tracked branch
        </>
      ),
    },
    {
      problem: "Restack conflict",
      solution: (
        <>
          Resolve files, run{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            git add
          </code>
          , then{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            dub restack --continue
          </code>
        </>
      ),
    },
    {
      problem: "Rebase/restack interrupted",
      solution: (
        <>
          Use{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            dub continue
          </code>{" "}
          to resume or{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            dub abort
          </code>{" "}
          to cancel
        </>
      ),
    },
    {
      problem: "Branch not tracked",
      solution: (
        <>
          Run{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            {"dub track <branch> --parent <parent>"}
          </code>
        </>
      ),
    },
    {
      problem: "Need metadata-only removal",
      solution: (
        <>
          Use{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            dub untrack
          </code>{" "}
          (or{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            --downstack
          </code>
          )
        </>
      ),
    },
    {
      problem: "Need stack-aware branch deletion",
      solution: (
        <>
          Use{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            dub delete
          </code>{" "}
          with{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            --upstack
          </code>{" "}
          /{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            --downstack
          </code>
        </>
      ),
    },
    {
      problem: "Sync skipped branch",
      solution: (
        <>
          Re-run with{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            --interactive
          </code>{" "}
          or{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            --force
          </code>{" "}
          as appropriate
        </>
      ),
    },
    {
      problem: "Wrong operation during create/restack",
      solution: (
        <>
          Use{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            dub undo
          </code>{" "}
          (single-level)
        </>
      ),
    },
    {
      problem: "PR merge blocked by order",
      solution: (
        <>
          Run{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            {"dub merge-check --pr <number>"}
          </code>{" "}
          and merge previous PR first
        </>
      ),
    },
    {
      problem: "Manual merge left stack inconsistent",
      solution: (
        <>
          Run{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            dub post-merge
          </code>
        </>
      ),
    },
  ];

  return (
    <article>
      <h1
        id="troubleshooting"
        className="mb-2 text-3xl font-bold text-foreground"
      >
        Troubleshooting
      </h1>
      <p className="mb-8 text-lg text-muted-foreground">
        Common issues and how to resolve them.
      </p>

      <h2
        id="common-issues"
        className="mb-4 mt-10 text-xl font-semibold text-foreground"
      >
        Common Issues
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="py-3 pr-4 text-left font-semibold text-foreground">
                Problem
              </th>
              <th className="py-3 text-left font-semibold text-foreground">
                Solution
              </th>
            </tr>
          </thead>
          <tbody>
            {issues.map((issue) => (
              <tr key={issue.problem} className="border-b border-border/50">
                <td className="py-3 pr-4 font-mono text-xs text-muted-foreground">
                  {issue.problem}
                </td>
                <td className="py-3 text-sm text-muted-foreground">
                  {issue.solution}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2
        id="stale-branch-recovery"
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

      <h2
        id="state-files"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        State Files
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        DubStack stores local state in your repo. Nothing is pushed to your remote from
        these files.
      </p>
      <CodeBlock
        code={`.git/dubstack/
├── state.json
├── undo.json
└── restack-progress.json`}
        language="text"
      />

      <PageNav currentHref="/docs/troubleshooting" />
    </article>
  );
}

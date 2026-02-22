import type { Metadata } from "next";
import { CodeBlock } from "@/components/code-block";
import { PageNav } from "@/components/docs/page-nav";

export const metadata: Metadata = {
  title: "Agent Skills - DubStack Docs",
  description:
    "Packaged agent skills for coding assistants to use DubStack correctly",
};

export default function SkillsPage() {
  return (
    <article>
      <h1
        id="agent-skills"
        className="mb-2 text-3xl font-bold text-foreground"
      >
        Agent Skills
      </h1>
      <p className="mb-8 text-lg text-muted-foreground">
        DubStack ships packaged skills so coding assistants can use{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
          dub
        </code>{" "}
        correctly for stacked PR workflows.
      </p>

      <h2
        id="included-skills"
        className="mb-4 mt-10 text-xl font-semibold text-foreground"
      >
        Included Skills
      </h2>

      <div className="mb-8 flex flex-col gap-6">
        <div className="rounded-lg border border-border bg-card p-6">
          <h3 className="mb-2 text-lg font-semibold text-foreground">
            dubstack
          </h3>
          <p className="mb-4 text-sm text-muted-foreground">
            General CLI reference and workflow guidance for creating and
            navigating stacks, modifying branches and restacking, syncing with
            remote state, submitting PR stacks, and recovering from common
            errors.
          </p>
          <CodeBlock
            code={`npx skills add wiseiodev/dubstack/skills/dubstack`}
            language="bash"
          />
        </div>

        <div className="rounded-lg border border-border bg-card p-6">
          <h3 className="mb-2 text-lg font-semibold text-foreground">
            dub-flow
          </h3>
          <p className="mb-4 text-sm text-muted-foreground">
            Task-oriented PR execution flow for agents that need to analyze
            staged changes, propose branch + commit naming, run{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
              dub create
            </code>{" "}
            /{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
              dub submit
            </code>
            , and open and polish PR metadata.
          </p>
          <CodeBlock
            code={`npx skills add wiseiodev/dubstack/skills/dub-flow`}
            language="bash"
          />
        </div>
      </div>

      <h2
        id="install-via-cli"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        Install via DubStack CLI
      </h2>
      <CodeBlock
        code={`# Install all packaged skills
dub skills add

# Install specific skill
dub skills add dubstack
dub skills add dub-flow`}
        language="bash"
      />

      <h2
        id="remove-skills"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        Remove Skills
      </h2>
      <CodeBlock
        code={`dub skills remove dubstack
dub skills remove dub-flow`}
        language="bash"
      />

      <h2
        id="dry-run"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        Dry Run
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Preview changes without modifying anything:
      </p>
      <CodeBlock
        code={`dub skills add --dry-run
dub skills remove --dry-run`}
        language="bash"
      />

      <h2
        id="what-agents-gain"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        What Agents Gain
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        With these skills installed, agents are more reliable at:
      </p>
      <ul className="flex flex-col gap-2 text-sm text-muted-foreground">
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          Using stack-safe commands (
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            create
          </code>
          ,{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            modify
          </code>
          ,{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            sync
          </code>
          ,{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            restack
          </code>
          ,{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            submit
          </code>
          )
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          Choosing safer recovery paths after conflicts
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          Avoiding destructive or non-stack-aware git flows
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          Producing consistent PR workflow outputs
        </li>
      </ul>

      <h2
        id="dub-flow-workflow"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        dub-flow Workflow Phases
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        The{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
          dub-flow
        </code>{" "}
        skill guides agents through a structured 4-phase PR creation process:
      </p>
      <ol className="mb-4 flex flex-col gap-3 text-sm text-muted-foreground">
        <li className="flex items-start gap-3">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
            1
          </span>
          <div>
            <span className="font-medium text-foreground">
              Analyze Changes
            </span>{" "}
            - Inspect staged diffs, determine scope (feature/fix/refactor/etc.)
          </div>
        </li>
        <li className="flex items-start gap-3">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
            2
          </span>
          <div>
            <span className="font-medium text-foreground">
              Propose Naming
            </span>{" "}
            - Suggest branch name (
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
              {"type/short-kebab-scope"}
            </code>
            ) and conventional commit message
          </div>
        </li>
        <li className="flex items-start gap-3">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
            3
          </span>
          <div>
            <span className="font-medium text-foreground">
              Confirm
            </span>{" "}
            - Present plan to user for approval before execution
          </div>
        </li>
        <li className="flex items-start gap-3">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
            4
          </span>
          <div>
            <span className="font-medium text-foreground">Execute</span> - Run{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
              dub create
            </code>{" "}
            +{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
              dub ss
            </code>
          </div>
        </li>
      </ol>

      <PageNav currentHref="/docs/skills" />
    </article>
  );
}

import type { Metadata } from "next";
import { CodeBlock } from "@/components/code-block";
import { CommandCard } from "@/components/docs/command-card";
import { PageNav } from "@/components/docs/page-nav";

export const metadata: Metadata = {
  title: "AI Commands - DubStack Docs",
  description:
    "AI-powered assistance: dub ai ask, dub ai env, dub config ai-assistant, and dub history",
};

export default function AICommandsPage() {
  return (
    <article>
      <h1 id="ai-commands" className="mb-2 text-3xl font-bold text-foreground">
        AI Commands
      </h1>
      <p className="mb-8 text-lg text-muted-foreground">
        DubStack includes an AI assistant that understands your stack context,
        plus commands for managing AI configuration and inspecting command
        history.
      </p>

      <h2
        id="dub-ai-ask"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        dub ai ask
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Ask DubStack{"'"}s AI assistant using streaming output. The assistant
        automatically receives a context packet including current branch/stack
        signals, git status, doctor summary, and recent command history.
      </p>
      <CodeBlock
        code={`dub ai ask "Summarize what this stack is changing"`}
        language="bash"
      />

      <h3
        id="ai-context"
        className="mb-3 mt-8 text-lg font-semibold text-foreground"
      >
        Automatic Context
      </h3>
      <p className="mb-4 text-sm text-muted-foreground">
        The AI assistant can invoke a constrained shell tool limited to a strict
        allow-list of safe, read-only commands (for example{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
          git status
        </code>
        ,{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
          dub doctor
        </code>
        ,{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
          dub ready
        </code>
        ) when command output is needed. It cannot execute arbitrary shell
        commands; requests outside the allow-list are rejected.
      </p>

      <h3
        id="ai-providers"
        className="mb-3 mt-8 text-lg font-semibold text-foreground"
      >
        Provider Selection
      </h3>
      <ul className="mb-6 flex flex-col gap-2 text-sm text-muted-foreground">
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          If{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            DUBSTACK_GEMINI_API_KEY
          </code>{" "}
          is set, DubStack uses direct Google provider access (
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            gemini-3-flash
          </code>
          ).
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          Otherwise, if{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            DUBSTACK_AI_GATEWAY_API_KEY
          </code>{" "}
          is set, DubStack uses Vercel AI Gateway (
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            google/gemini-3-flash
          </code>
          ).
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          If both are set, DubStack prefers{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            DUBSTACK_GEMINI_API_KEY
          </code>
          .
        </li>
      </ul>

      <h2
        id="dub-ai-env"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        dub ai env
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Write DubStack AI keys into your shell profile (macOS/Linux).
      </p>
      <CodeBlock
        code={`# Write Gemini key
dub ai env --gemini-key "<your-key>"

# Write Gateway key
dub ai env --gateway-key "<your-key>"

# Write both
dub ai env --gemini-key "<gemini-key>" --gateway-key "<gateway-key>"

# Target a specific profile file
dub ai env --gemini-key "<your-key>" --profile ~/.zshrc`}
        language="bash"
      />
      <CommandCard
        command="dub ai env"
        description="Write AI provider keys into your shell profile."
        flags={[
          {
            flag: "--gemini-key <key>",
            description: "Set DUBSTACK_GEMINI_API_KEY",
          },
          {
            flag: "--gateway-key <key>",
            description: "Set DUBSTACK_AI_GATEWAY_API_KEY",
          },
          {
            flag: "--profile <path>",
            description:
              "Target specific profile file (auto-detects zsh/bash otherwise)",
          },
        ]}
      />

      <h2
        id="dub-config-ai-assistant"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        dub config ai-assistant
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Enable or disable the repo-local AI assistant flag.
      </p>
      <CodeBlock
        code={`# Check current value
dub config ai-assistant

# Enable
dub config ai-assistant on

# Disable
dub config ai-assistant off`}
        language="bash"
      />

      <h2
        id="dub-history"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        dub history
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Inspect recent Dub command history used for troubleshooting context.
      </p>
      <CodeBlock
        code={`# Show last 20 entries
dub history

# Show more
dub history --limit 50

# Machine-readable output
dub history --json`}
        language="bash"
      />
      <CommandCard
        command="dub history"
        description="Inspect recent command history."
        flags={[
          {
            flag: "--limit <number>",
            description: "Number of entries to show (default: 20)",
          },
          { flag: "--json", description: "Output in JSON format" },
        ]}
      />

      <PageNav currentHref="/docs/commands/ai" />
    </article>
  );
}

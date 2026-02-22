import Link from "next/link";
import {
  GitBranch,
  Layers,
  RefreshCw,
  Terminal,
  ArrowRight,
  Sparkles,
  Github,
} from "lucide-react";
import { Header } from "@/components/header";
import { CodeBlock } from "@/components/code-block";

const features = [
  {
    icon: Layers,
    title: "Stacked Branches",
    description:
      "Split work into focused, dependent layers. Each branch builds on the one below, keeping PRs small and reviewable.",
  },
  {
    icon: RefreshCw,
    title: "Auto Restack",
    description:
      "When a lower branch changes, dub restack propagates it upstack. Conflict recovery is built in with dub continue and dub abort.",
  },
  {
    icon: Terminal,
    title: "Graphite Compatible",
    description:
      "If you have gt muscle memory, DubStack maps 1:1. Same mental model, same workflow patterns, fully local-first.",
  },
  {
    icon: Sparkles,
    title: "AI Powered",
    description:
      "AI-generate branch names and commit messages from staged changes. Ask the built-in assistant for stack-aware guidance.",
  },
];

export default function HomePage() {
  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <main className="flex-1">
        {/* Hero */}
        <section className="relative overflow-hidden border-b border-border">
          <div className="absolute inset-0 bg-gradient-to-b from-primary/5 via-transparent to-transparent" />
          <div className="relative mx-auto max-w-4xl px-4 py-20 text-center md:px-6 md:py-32">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-1.5 text-sm text-muted-foreground">
              <GitBranch className="h-3.5 w-3.5 text-primary" />
              <span>Local-first CLI for stacked branch workflows</span>
            </div>
            <h1 className="mb-6 text-4xl font-bold tracking-tight text-foreground text-balance md:text-6xl">
              Ship stacked PRs{" "}
              <span className="text-primary">without the friction</span>
            </h1>
            <p className="mx-auto mb-10 max-w-2xl text-lg leading-relaxed text-muted-foreground text-pretty">
              DubStack makes stacked branch workflows fast and safe. Create
              dependent branches, restack automatically, and submit entire PR
              stacks in one command.
            </p>
            <div className="mb-10 mx-auto max-w-md">
              <CodeBlock
                code="brew tap wiseiodev/dubstack && brew install dubstack"
                language="bash"
              />
            </div>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Link
                href="/docs"
                className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Get Started
                <ArrowRight className="h-4 w-4" />
              </Link>
              <a
                href="https://github.com/wiseiodev/dubstack"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
              >
                <Github className="h-4 w-4" />
                View on GitHub
              </a>
            </div>
          </div>
        </section>

        {/* Features */}
        <section className="mx-auto max-w-5xl px-4 py-20 md:px-6">
          <h2 className="mb-3 text-center text-2xl font-bold text-foreground md:text-3xl">
            Built for the stacked PR workflow
          </h2>
          <p className="mx-auto mb-12 max-w-2xl text-center text-muted-foreground">
            Everything you need to manage dependent branches, from creation to
            merge.
          </p>
          <div className="grid gap-6 sm:grid-cols-2">
            {features.map((feature) => (
              <div
                key={feature.title}
                className="rounded-lg border border-border bg-card p-6"
              >
                <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-md bg-primary/10">
                  <feature.icon className="h-5 w-5 text-primary" />
                </div>
                <h3 className="mb-2 text-lg font-semibold text-foreground">
                  {feature.title}
                </h3>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {feature.description}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* Quick example */}
        <section className="border-t border-border bg-card/50">
          <div className="mx-auto max-w-3xl px-4 py-20 md:px-6">
            <h2 className="mb-3 text-center text-2xl font-bold text-foreground md:text-3xl">
              From zero to stacked PRs
            </h2>
            <p className="mx-auto mb-10 max-w-xl text-center text-muted-foreground">
              Create a three-layer stack, view it, and submit all PRs in just a
              few commands.
            </p>
            <CodeBlock
              code={`# Start from trunk
git checkout main && git pull

# Create stacked branches
dub create feat/auth-types -am "feat: add auth types"
dub create feat/auth-login -am "feat: add login flow"
dub create feat/auth-tests -am "test: add auth tests"

# View your stack
dub log

# Submit all PRs
dub ss`}
              language="bash"
            />
            <div className="mt-8 text-center">
              <Link
                href="/docs"
                className="inline-flex items-center gap-2 text-sm font-medium text-primary transition-colors hover:text-primary/80"
              >
                Read the full quick start guide
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-6 md:px-6">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <GitBranch className="h-4 w-4 text-primary" />
            <span>DubStack</span>
          </div>
          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            <Link
              href="/docs"
              className="transition-colors hover:text-foreground"
            >
              Docs
            </Link>
            <a
              href="https://github.com/wiseiodev/dubstack"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-foreground"
            >
              GitHub
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

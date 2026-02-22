import type { Metadata } from "next";
import Link from "next/link";
import { PageNav } from "@/components/docs/page-nav";

export const metadata: Metadata = {
  title: "Command Overview",
  description: "Complete reference of all DubStack commands",
};

const commandGroups = [
  {
    title: "Create & Modify",
    commands: [
      { name: "dub create", desc: "Create stacked branch with commits", href: "/docs/commands/create" },
      { name: "dub modify", desc: "Amend or create commits, restack", href: "/docs/commands/modify" },
    ],
  },
  {
    title: "Navigate & Visualize",
    commands: [
      { name: "dub checkout", desc: "Interactive branch checkout", href: "/docs/commands/checkout" },
      { name: "dub log", desc: "Stack tree visualization", href: "/docs/commands/log" },
    ],
  },
  {
    title: "Submit & PR",
    commands: [
      { name: "dub submit", desc: "Push branches and manage PRs", href: "/docs/commands/submit" },
    ],
  },
  {
    title: "Sync & Rebase",
    commands: [
      { name: "dub sync", desc: "Synchronize with remote", href: "/docs/commands/sync" },
    ],
  },
  {
    title: "Track & Manage",
    commands: [
      { name: "dub track", desc: "Track, untrack, delete branches", href: "/docs/commands/track" },
    ],
  },
  {
    title: "Recovery",
    commands: [
      { name: "dub continue/abort/undo", desc: "Resume, cancel, undo operations", href: "/docs/commands/recovery" },
    ],
  },
  {
    title: "Maintenance",
    commands: [
      { name: "dub doctor/ready/prune", desc: "Health checks and cleanup", href: "/docs/commands/maintenance" },
    ],
  },
  {
    title: "AI Features",
    commands: [
      { name: "dub ai ask", desc: "AI assistant and config", href: "/docs/commands/ai" },
    ],
  },
];

export default function CommandsPage() {
  return (
    <article>
      <h1 id="command-overview" className="mb-2 text-3xl font-bold text-foreground">
        Command Overview
      </h1>
      <p className="mb-8 text-lg text-muted-foreground">
        Complete reference of all DubStack commands, organized by function.
      </p>

      <div className="flex flex-col gap-6">
        {commandGroups.map((group) => (
          <div key={group.title}>
            <h2
              id={group.title.toLowerCase().replace(/\s+/g, "-")}
              className="mb-3 text-xl font-semibold text-foreground"
            >
              {group.title}
            </h2>
            <div className="flex flex-col gap-2">
              {group.commands.map((cmd) => (
                <Link
                  key={cmd.name}
                  href={cmd.href}
                  className="group flex items-center justify-between rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary/30 hover:bg-primary/5"
                >
                  <div className="flex flex-col gap-1">
                    <code className="font-mono text-sm font-medium text-primary">
                      {cmd.name}
                    </code>
                    <span className="text-sm text-muted-foreground">
                      {cmd.desc}
                    </span>
                  </div>
                  <span className="text-muted-foreground transition-transform group-hover:translate-x-0.5">
                    {"\u2192"}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>

      <PageNav currentHref="/docs/commands" />
    </article>
  );
}

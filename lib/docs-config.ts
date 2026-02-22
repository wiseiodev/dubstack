export interface DocPage {
  title: string;
  href: string;
  description?: string;
  keywords?: string[];
}

export interface DocSection {
  title: string;
  pages: DocPage[];
}

export const docsConfig: DocSection[] = [
  {
    title: "Getting Started",
    pages: [
      {
        title: "Quick Start",
        href: "/docs",
        description: "Get up and running with DubStack in minutes",
        keywords: ["install", "setup", "start", "begin", "quickstart"],
      },
      {
        title: "Installation",
        href: "/docs/installation",
        description: "Install DubStack via Homebrew, npm, or from source",
        keywords: ["brew", "npm", "install", "setup", "homebrew"],
      },
      {
        title: "Graphite Migration",
        href: "/docs/graphite-migration",
        description: "Map Graphite commands to DubStack equivalents",
        keywords: ["graphite", "gt", "migrate", "migration", "map"],
      },
    ],
  },
  {
    title: "Commands",
    pages: [
      {
        title: "Command Overview",
        href: "/docs/commands",
        description: "Complete reference of all DubStack commands",
        keywords: ["reference", "commands", "overview", "list"],
      },
      {
        title: "dub create",
        href: "/docs/commands/create",
        description: "Create stacked branches with commits",
        keywords: ["create", "branch", "stack", "new", "ai"],
      },
      {
        title: "dub modify",
        href: "/docs/commands/modify",
        description: "Amend or create commits, then restack",
        keywords: ["modify", "amend", "commit", "edit", "rebase"],
      },
      {
        title: "dub checkout",
        href: "/docs/commands/checkout",
        description: "Navigate between branches interactively",
        keywords: ["checkout", "co", "navigate", "switch", "branch"],
      },
      {
        title: "dub log",
        href: "/docs/commands/log",
        description: "Visualize your stack as an ASCII tree",
        keywords: ["log", "ls", "tree", "visualize", "stack"],
      },
      {
        title: "dub submit",
        href: "/docs/commands/submit",
        description: "Push branches and create/update PRs",
        keywords: ["submit", "ss", "pr", "push", "pull request"],
      },
      {
        title: "dub sync",
        href: "/docs/commands/sync",
        description: "Synchronize with remote and restack",
        keywords: ["sync", "restack", "rebase", "remote", "fetch"],
      },
      {
        title: "dub track",
        href: "/docs/commands/track",
        description: "Track, untrack, and delete branches",
        keywords: ["track", "untrack", "delete", "metadata", "repair"],
      },
      {
        title: "Recovery",
        href: "/docs/commands/recovery",
        description: "Continue, abort, and undo operations",
        keywords: ["continue", "abort", "undo", "recovery", "conflict"],
      },
      {
        title: "Maintenance",
        href: "/docs/commands/maintenance",
        description: "Doctor, ready, prune, and merge commands",
        keywords: [
          "doctor",
          "ready",
          "prune",
          "merge-check",
          "merge-next",
          "land",
          "post-merge",
        ],
      },
      {
        title: "AI Features",
        href: "/docs/commands/ai",
        description: "AI-powered assistant, branch naming, and history",
        keywords: [
          "ai",
          "ask",
          "gemini",
          "assistant",
          "config",
          "history",
          "env",
        ],
      },
    ],
  },
  {
    title: "Workflows",
    pages: [
      {
        title: "Workflow Playbooks",
        href: "/docs/workflows",
        description: "Copy-paste playbooks for common stacked PR workflows",
        keywords: [
          "workflow",
          "playbook",
          "example",
          "pattern",
          "recipe",
          "guide",
        ],
      },
    ],
  },
  {
    title: "Reference",
    pages: [
      {
        title: "Troubleshooting",
        href: "/docs/troubleshooting",
        description: "Common issues and their solutions",
        keywords: [
          "troubleshoot",
          "error",
          "fix",
          "problem",
          "issue",
          "help",
        ],
      },
      {
        title: "Contributing",
        href: "/docs/contributing",
        description: "How to contribute to DubStack",
        keywords: [
          "contribute",
          "contributing",
          "pr",
          "development",
          "setup",
        ],
      },
      {
        title: "Agent Skills",
        href: "/docs/skills",
        description: "Packaged skills for coding assistants",
        keywords: [
          "skills",
          "agent",
          "ai",
          "codex",
          "claude",
          "cursor",
          "assistant",
        ],
      },
    ],
  },
];

export function getAllPages(): DocPage[] {
  return docsConfig.flatMap((section) => section.pages);
}

export function getPageByHref(href: string): DocPage | undefined {
  return getAllPages().find((page) => page.href === href);
}

export function getAdjacentPages(href: string): {
  prev: DocPage | undefined;
  next: DocPage | undefined;
} {
  const allPages = getAllPages();
  const index = allPages.findIndex((page) => page.href === href);
  return {
    prev: index > 0 ? allPages[index - 1] : undefined,
    next: index < allPages.length - 1 ? allPages[index + 1] : undefined,
  };
}

# DubStack Docs

The public documentation website for [DubStack](https://github.com/wiseiodev/dubstack), a local-first CLI for stacked branch workflows.

Built with Next.js 16, Tailwind CSS v4, and shadcn/ui using the Northern Lights theme from tweakcn.

## Getting Started

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

## Tech Stack

- **Framework**: Next.js 16.1.6 (App Router, Turbopack)
- **Styling**: Tailwind CSS v4 with Northern Lights theme
- **Components**: shadcn/ui
- **Fonts**: Plus Jakarta Sans, Source Serif 4, JetBrains Mono
- **Search**: cmdk command palette

## Structure

```
app/
  page.tsx                    # Landing page
  docs/
    page.tsx                  # Quick Start
    installation/             # Install guide
    graphite-migration/       # Migration from Graphite
    commands/                 # Command reference pages
    workflows/                # Workflow guides
    troubleshooting/          # Troubleshooting
    contributing/             # Contributing guide
    skills/                   # Agent skills
components/
  header.tsx                  # Site header with nav
  command-menu.tsx            # Cmd+K search palette
  code-block.tsx              # Syntax-highlighted code
  docs/
    sidebar.tsx               # Docs sidebar navigation
    toc.tsx                   # Table of contents
    page-nav.tsx              # Prev/next navigation
lib/
  docs-config.ts              # Navigation and search index
```

## License

MIT

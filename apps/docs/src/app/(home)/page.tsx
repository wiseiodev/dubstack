import {
  ArrowRight,
  Bot,
  GitBranch,
  Layers,
  Network,
  RefreshCw,
  Sparkles,
  Terminal,
} from 'lucide-react';
import Link from 'next/link';

const features = [
  {
    icon: Layers,
    title: 'Tree-Shaped Stacks',
    description:
      'Split work into focused layers — linear or branching. DubStack tracks the full stack tree and renders the current path in your terminal.',
  },
  {
    icon: RefreshCw,
    title: 'Safe Restack & Merge',
    description:
      'Restack propagates parent changes upstack. merge-next picks the next safe PR, post-merge cleans up retargets, and undo/redo is multi-level.',
  },
  {
    icon: Sparkles,
    title: 'AI Across The Flow',
    description:
      'Pluggable providers (Anthropic, Gemini, OpenAI, Bedrock, Ollama, AI Gateway) generate branch names, commit bodies, PR descriptions, and resolve restack conflicts.',
  },
  {
    icon: Bot,
    title: 'Agents & MCP',
    description:
      'Every read command emits JSON with schemaVersion: 1. The built-in MCP server exposes stack tools to Claude Code, Cursor, and any MCP-aware agent with a per-repo security model.',
  },
  {
    icon: Terminal,
    title: 'Shell & IDE Integration',
    description:
      'dub status drives prompts. dub completion + dub man emit shell completions and a man page from live commander metadata. Theming follows your terminal.',
  },
  {
    icon: Network,
    title: 'Graphite-Compatible',
    description:
      'If you have gt muscle memory, DubStack maps 1:1. Local-first state under .git/dubstack, optional SQLite backend for large stacks, and a GitHub Action that retargets stacks after merges.',
  },
];

export default function HomePage() {
  return (
    <div className='flex flex-col'>
      {/* Hero */}
      <section className='relative overflow-hidden border-b border-border'>
        <div className='absolute inset-0 bg-gradient-to-b from-primary/5 via-transparent to-transparent' />
        <div className='relative mx-auto max-w-4xl px-4 py-20 text-center md:px-6 md:py-32'>
          <div className='mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-1.5 text-sm text-muted-foreground'>
            <GitBranch className='size-3.5 text-primary' />
            <span>Local-first CLI for stacked branch workflows</span>
          </div>
          <h1 className='mb-6 text-4xl font-bold tracking-tight text-foreground text-balance md:text-6xl'>
            Ship stacked PRs{' '}
            <span className='text-primary'>without the friction</span>
          </h1>
          <p className='mx-auto mb-10 max-w-2xl text-lg leading-relaxed text-muted-foreground text-pretty'>
            A local-first CLI for tree-shaped stacked branches. Create dependent
            layers, restack safely, submit entire stacks, and drive it all from
            your shell, IDE, or an MCP-aware agent.
          </p>
          <div className='mb-10 mx-auto max-w-md'>
            <pre className='overflow-x-auto rounded-lg border border-border bg-card p-4 text-left text-sm'>
              <code className='font-mono text-foreground'>
                {'brew tap wiseiodev/dubstack\nbrew install dubstack'}
              </code>
            </pre>
          </div>
          <div className='flex flex-wrap items-center justify-center gap-3'>
            <Link
              href='/docs'
              className='inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90'
            >
              Get Started
              <ArrowRight className='size-4' />
            </Link>
            <a
              href='https://github.com/wiseiodev/dubstack'
              target='_blank'
              rel='noopener noreferrer'
              className='inline-flex items-center gap-2 rounded-md border border-border bg-background px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted'
            >
              <GitBranch className='size-4' />
              View on GitHub
            </a>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className='mx-auto max-w-5xl px-4 py-20 md:px-6'>
        <h2 className='mb-3 text-center text-2xl font-bold text-foreground md:text-3xl'>
          Built for the stacked PR workflow
        </h2>
        <p className='mx-auto mb-12 max-w-2xl text-center text-muted-foreground'>
          Everything you need to manage dependent branches, from creation to
          merge.
        </p>
        <div className='grid gap-6 sm:grid-cols-2 lg:grid-cols-3'>
          {features.map((feature) => (
            <div
              key={feature.title}
              className='rounded-lg border border-border bg-card p-6'
            >
              <div className='mb-3 flex size-10 items-center justify-center rounded-md bg-primary/10'>
                <feature.icon className='size-5 text-primary' />
              </div>
              <h3 className='mb-2 text-lg font-semibold text-foreground'>
                {feature.title}
              </h3>
              <p className='text-sm leading-relaxed text-muted-foreground'>
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Quick Example */}
      <section className='border-t border-border bg-card/50'>
        <div className='mx-auto max-w-3xl px-4 py-20 md:px-6'>
          <h2 className='mb-3 text-center text-2xl font-bold text-foreground md:text-3xl'>
            From zero to stacked PRs
          </h2>
          <p className='mx-auto mb-10 max-w-xl text-center text-muted-foreground'>
            Create a three-layer stack, view it, and submit all PRs in just a
            few commands.
          </p>
          <pre className='overflow-x-auto rounded-lg border border-border bg-card p-6 text-sm leading-relaxed'>
            <code className='font-mono text-foreground'>
              {`# Start from trunk
git checkout main && git pull

# Create stacked branches
dub create feat/auth-types -am "feat: add auth types"
dub create feat/auth-login -am "feat: add login flow"
dub create feat/auth-tests -am "test: add auth tests"

# View your stack
dub log

# Submit all PRs
dub ss`}
            </code>
          </pre>
          <div className='mt-8 text-center'>
            <Link
              href='/docs'
              className='inline-flex items-center gap-2 text-sm font-medium text-primary transition-colors hover:text-primary/80'
            >
              Read the full quick start guide
              <ArrowRight className='size-4' />
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className='border-t border-border'>
        <div className='mx-auto flex max-w-5xl items-center justify-between px-4 py-6 md:px-6'>
          <div className='flex items-center gap-2 text-sm text-muted-foreground'>
            <GitBranch className='size-4 text-primary' />
            <span>DubStack</span>
          </div>
          <div className='flex items-center gap-4 text-sm text-muted-foreground'>
            <Link
              href='/docs'
              className='transition-colors hover:text-foreground'
            >
              Docs
            </Link>
            <a
              href='https://github.com/wiseiodev/dubstack'
              target='_blank'
              rel='noopener noreferrer'
              className='transition-colors hover:text-foreground'
            >
              GitHub
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

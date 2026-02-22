import type { Metadata } from "next";
import { CodeBlock } from "@/components/code-block";
import { PageNav } from "@/components/docs/page-nav";

export const metadata: Metadata = {
  title: "Installation",
  description: "Install DubStack via Homebrew, npm, or from source",
};

export default function InstallationPage() {
  return (
    <article>
      <h1
        id="installation"
        className="mb-2 text-3xl font-bold text-foreground"
      >
        Installation
      </h1>
      <p className="mb-8 text-lg text-muted-foreground">
        Install DubStack via Homebrew, npm, or build from source.
      </p>

      <h2
        id="homebrew"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        Homebrew (recommended)
      </h2>
      <CodeBlock
        code={`brew tap wiseiodev/dubstack
brew install dubstack`}
        language="bash"
      />
      <p className="mt-3 text-sm text-muted-foreground">Update:</p>
      <CodeBlock code={`brew update\nbrew upgrade dubstack`} language="bash" className="mt-2" />

      <h2
        id="npm"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        npm
      </h2>
      <CodeBlock code="npm install -g dubstack" language="bash" />

      <h2
        id="from-source"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        From Source
      </h2>
      <CodeBlock
        code={`git clone https://github.com/wiseiodev/dubstack.git
cd dubstack
pnpm install
pnpm build
pnpm link --global`}
        language="bash"
      />

      <h2
        id="verify"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        Verify Installation
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        After installing, verify DubStack is available:
      </p>
      <CodeBlock code="dub --help" language="bash" />
      <p className="mt-4 text-sm text-muted-foreground">
        Initialize DubStack in your repository:
      </p>
      <CodeBlock code="dub init" language="bash" className="mt-2" />
      <p className="mt-3 text-sm text-muted-foreground">
        Note: <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">dub create</code> auto-initializes
        state if needed, so running <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">dub init</code> manually
        is optional but useful for explicit setup.
      </p>

      <PageNav currentHref="/docs/installation" />
    </article>
  );
}

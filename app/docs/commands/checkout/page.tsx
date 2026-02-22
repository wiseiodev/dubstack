import type { Metadata } from "next";
import { CodeBlock } from "@/components/code-block";
import { CommandCard } from "@/components/docs/command-card";
import { PageNav } from "@/components/docs/page-nav";

export const metadata: Metadata = {
  title: "dub checkout",
  description: "Navigate between branches interactively",
};

export default function CheckoutPage() {
  return (
    <article>
      <h1 id="dub-checkout" className="mb-2 text-3xl font-bold text-foreground">
        dub checkout
      </h1>
      <p className="mb-8 text-lg text-muted-foreground">
        Checkout a branch directly or use interactive search. Also includes
        stack navigation commands.
      </p>

      <h2 id="checkout-usage" className="mb-3 mt-10 text-xl font-semibold text-foreground">
        Checkout
      </h2>
      <CodeBlock
        code={`# Checkout explicit branch
dub checkout feat/auth-login

# Interactive picker
dub checkout

# Checkout trunk for current tracked stack
dub checkout --trunk

# Include non-tracked local branches
dub checkout --show-untracked

# Scope to current stack
dub checkout --stack`}
        language="bash"
      />

      <CommandCard
        command="dub checkout [branch]"
        aliases={["dub co"]}
        description="Checkout a branch directly or use the interactive picker."
        flags={[
          { flag: "--trunk", description: "Checkout stack trunk" },
          { flag: "--show-untracked", description: "Include non-tracked local branches in picker" },
          { flag: "--stack", description: "Restrict picker to current stack" },
        ]}
        className="mt-4"
      />

      <h2 id="navigation" className="mb-3 mt-10 text-xl font-semibold text-foreground">
        Stack Navigation
      </h2>
      <CodeBlock
        code={`# Move one branch upstack
dub up

# Move multiple levels upstack
dub up 2

# Move downstack
dub down
dub down 2

# Jump to tip branch in current path
dub top

# Jump to first branch above root
dub bottom`}
        language="bash"
      />

      <h2 id="orientation" className="mb-3 mt-10 text-xl font-semibold text-foreground">
        Orientation Commands
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Inspect where the current branch sits in its tracked stack:
      </p>
      <CodeBlock
        code={`dub parent      # Direct parent of current branch
dub children    # Direct children
dub trunk       # Stack root/trunk branch

# With explicit branch argument
dub parent feat/auth-login
dub children feat/auth-types
dub trunk feat/auth-tests`}
        language="bash"
      />
      <p className="mt-3 text-sm text-muted-foreground">
        If branch metadata is missing, these commands print a remediation path
        using <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">dub track</code>.
      </p>

      <PageNav currentHref="/docs/commands/checkout" />
    </article>
  );
}

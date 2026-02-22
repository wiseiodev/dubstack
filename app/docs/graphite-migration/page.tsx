import type { Metadata } from "next";
import { ComparisonTable } from "@/components/docs/comparison-table";
import { PageNav } from "@/components/docs/page-nav";

export const metadata: Metadata = {
  title: "Graphite Migration",
  description: "Map Graphite commands to DubStack equivalents",
};

const migrationRows = [
  { graphite: "gt create", dubstack: "dub create" },
  { graphite: "gt modify", dubstack: "dub modify / dub m" },
  { graphite: "gt submit / gt ss", dubstack: "dub submit / dub ss" },
  { graphite: "gt sync", dubstack: "dub sync" },
  { graphite: "gt checkout / gt co", dubstack: "dub checkout / dub co" },
  { graphite: "gt log / gt ls", dubstack: "dub log / dub ls" },
  { graphite: "gt up / gt down", dubstack: "dub up / dub down" },
  { graphite: "gt top / gt bottom", dubstack: "dub top / dub bottom" },
  { graphite: "gt info", dubstack: "dub info" },
  { graphite: "gt pr", dubstack: "dub pr" },
  { graphite: "gt restack", dubstack: "dub restack" },
  { graphite: "gt continue", dubstack: "dub continue" },
  { graphite: "gt abort", dubstack: "dub abort" },
  { graphite: "gt track --parent", dubstack: "dub track --parent" },
  { graphite: "gt untrack", dubstack: "dub untrack" },
  { graphite: "gt delete", dubstack: "dub delete" },
  { graphite: "gt parent", dubstack: "dub parent" },
  { graphite: "gt children", dubstack: "dub children" },
  { graphite: "gt trunk", dubstack: "dub trunk" },
  { graphite: "gt undo", dubstack: "dub undo" },
];

export default function GraphiteMigrationPage() {
  return (
    <article>
      <h1
        id="graphite-migration"
        className="mb-2 text-3xl font-bold text-foreground"
      >
        Graphite Migration
      </h1>
      <p className="mb-8 text-lg text-muted-foreground">
        If you have <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm text-foreground">gt</code> muscle memory,
        use this as a fast map. DubStack follows the same mental model.
      </p>

      <h2
        id="command-mapping"
        className="mb-4 mt-10 text-xl font-semibold text-foreground"
      >
        Command Mapping
      </h2>
      <ComparisonTable rows={migrationRows} />

      <h2
        id="key-differences"
        className="mb-3 mt-10 text-xl font-semibold text-foreground"
      >
        Key Differences
      </h2>
      <ul className="flex flex-col gap-3 text-sm text-muted-foreground">
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          <span>
            <strong className="text-foreground">Local-first</strong> -
            DubStack stores all state locally in{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">.git/dubstack/</code>. Nothing is
            pushed to your remote from these files.
          </span>
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          <span>
            <strong className="text-foreground">AI features</strong> -
            DubStack includes built-in AI for branch naming, commit messages,
            and stack-aware guidance via{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">dub ai ask</code>.
          </span>
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          <span>
            <strong className="text-foreground">Agent skills</strong> -
            DubStack ships packaged skills for coding assistants via{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">dub skills add</code>.
          </span>
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          <span>
            <strong className="text-foreground">Safe merging</strong> -
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">dub merge-next</code> handles
            retargeting child PRs before deleting merged branches.
          </span>
        </li>
      </ul>

      <PageNav currentHref="/docs/graphite-migration" />
    </article>
  );
}

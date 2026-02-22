import { cn } from "@/lib/utils";

interface CommandCardProps {
  command: string;
  aliases?: string[];
  description: string;
  flags?: { flag: string; description: string }[];
  className?: string;
}

export function CommandCard({
  command,
  aliases,
  description,
  flags,
  className,
}: CommandCardProps) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card p-4",
        className
      )}
    >
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <code className="rounded-md bg-primary/10 px-2 py-1 text-sm font-mono font-medium text-primary">
          {command}
        </code>
        {aliases?.map((alias) => (
          <code
            key={alias}
            className="rounded-md bg-muted px-2 py-1 text-xs font-mono text-muted-foreground"
          >
            {alias}
          </code>
        ))}
      </div>
      <p className="text-sm text-muted-foreground mb-3">{description}</p>
      {flags && flags.length > 0 && (
        <div className="border-t border-border pt-3">
          <p className="text-xs font-medium text-foreground mb-2">Flags</p>
          <div className="flex flex-col gap-1.5">
            {flags.map((f) => (
              <div key={f.flag} className="flex gap-3 text-sm">
                <code className="shrink-0 font-mono text-xs text-secondary">
                  {f.flag}
                </code>
                <span className="text-muted-foreground text-xs">
                  {f.description}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

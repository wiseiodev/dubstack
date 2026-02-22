"use client";

import { CopyButton } from "@/components/copy-button";
import { cn } from "@/lib/utils";

interface CodeBlockProps {
  code: string;
  language?: string;
  filename?: string;
  className?: string;
}

export function CodeBlock({
  code,
  language = "bash",
  filename,
  className,
}: CodeBlockProps) {
  return (
    <div
      className={cn(
        "group relative rounded-lg border border-border bg-card overflow-hidden",
        className
      )}
    >
      {(language || filename) && (
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <span className="text-xs font-mono text-muted-foreground">
            {filename || language}
          </span>
          <CopyButton text={code} />
        </div>
      )}
      {!language && !filename && (
        <div className="absolute right-2 top-2 opacity-0 transition-opacity group-hover:opacity-100">
          <CopyButton text={code} />
        </div>
      )}
      <pre className="overflow-x-auto p-4">
        <code className="text-sm font-mono leading-relaxed text-foreground">
          {code}
        </code>
      </pre>
    </div>
  );
}

interface InlineCodeProps {
  children: React.ReactNode;
}

export function InlineCode({ children }: InlineCodeProps) {
  return (
    <code className="rounded-md bg-muted px-1.5 py-0.5 text-sm font-mono text-foreground">
      {children}
    </code>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { Command } from "cmdk";
import { useRouter } from "next/navigation";
import { docsConfig } from "@/lib/docs-config";
import { Search, FileText, ArrowRight } from "lucide-react";

export function CommandMenu() {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (
        (e.key === "k" && (e.metaKey || e.ctrlKey)) ||
        (e.key === "/" &&
          !["INPUT", "TEXTAREA", "SELECT"].includes(
            (e.target as HTMLElement)?.tagName
          ) &&
          !(e.target as HTMLElement)?.isContentEditable)
      ) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const runCommand = useCallback(
    (command: () => unknown) => {
      setOpen(false);
      command();
    },
    []
  );

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex h-9 w-full max-w-64 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm text-muted-foreground transition-colors hover:bg-muted"
      >
        <Search className="h-4 w-4 shrink-0" />
        <span className="flex-1 text-left">Search docs...</span>
        <kbd className="pointer-events-none hidden h-5 select-none items-center gap-1 rounded border border-border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground sm:flex">
          <span className="text-xs">{"/"}</span>
        </kbd>
      </button>
      {open && (
        <div className="fixed inset-0 z-50">
          <div
            className="fixed inset-0 bg-background/80 backdrop-blur-sm"
            onClick={() => setOpen(false)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
            }}
          />
          <div className="fixed left-1/2 top-[20%] z-50 w-full max-w-lg -translate-x-1/2">
            <Command
              className="rounded-lg border border-border bg-popover shadow-lg"
              loop
            >
              <div className="flex items-center border-b border-border px-3">
                <Search className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                <Command.Input
                  placeholder="Search documentation..."
                  className="flex h-11 w-full bg-transparent py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground"
                  autoFocus
                />
              </div>
              <Command.List className="max-h-80 overflow-y-auto p-2">
                <Command.Empty className="py-6 text-center text-sm text-muted-foreground">
                  No results found.
                </Command.Empty>
                {docsConfig.map((section) => (
                  <Command.Group
                    key={section.title}
                    heading={section.title}
                    className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
                  >
                    {section.pages.map((page) => (
                      <Command.Item
                        key={page.href}
                        value={`${page.title} ${page.description || ""} ${(page.keywords || []).join(" ")}`}
                        onSelect={() =>
                          runCommand(() => router.push(page.href))
                        }
                        className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2.5 text-sm text-foreground aria-selected:bg-accent aria-selected:text-accent-foreground"
                      >
                        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <div className="flex flex-1 flex-col">
                          <span className="font-medium">{page.title}</span>
                          {page.description && (
                            <span className="text-xs text-muted-foreground">
                              {page.description}
                            </span>
                          )}
                        </div>
                        <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                      </Command.Item>
                    ))}
                  </Command.Group>
                ))}
              </Command.List>
            </Command>
          </div>
        </div>
      )}
    </>
  );
}

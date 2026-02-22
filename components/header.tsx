"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { GitBranch, Github } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { CommandMenu } from "@/components/command-menu";
import { MobileNav } from "@/components/docs/mobile-nav";
import { cn } from "@/lib/utils";

export function Header() {
  const pathname = usePathname();
  const isDocsPage = pathname.startsWith("/docs");

  return (
    <header className="sticky top-0 z-40 w-full border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="flex h-14 items-center gap-4 px-4 md:px-6">
        {isDocsPage && <MobileNav />}
        <Link
          href="/"
          className="flex items-center gap-2 font-semibold text-foreground"
        >
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary">
            <GitBranch className="h-4 w-4 text-primary-foreground" />
          </div>
          <span className="hidden sm:inline-block">DubStack</span>
        </Link>
        <nav className="hidden items-center gap-1 md:flex">
          <Link
            href="/docs"
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors hover:text-foreground",
              isDocsPage ? "text-foreground" : "text-muted-foreground"
            )}
          >
            Docs
          </Link>
          <a
            href="https://github.com/wiseiodev/dubstack"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            GitHub
          </a>
        </nav>
        <div className="flex flex-1 items-center justify-end gap-2">
          <div className="hidden sm:block">
            <CommandMenu />
          </div>
          <a
            href="https://github.com/wiseiodev/dubstack"
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground md:hidden"
            aria-label="GitHub"
          >
            <Github className="h-5 w-5" />
          </a>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

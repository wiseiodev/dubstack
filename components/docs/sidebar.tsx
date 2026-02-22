"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { docsConfig } from "@/lib/docs-config";
import { cn } from "@/lib/utils";

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden w-64 shrink-0 lg:block">
      <nav className="sticky top-14 h-[calc(100vh-3.5rem)] overflow-y-auto py-6 pr-4">
        <div className="flex flex-col gap-6">
          {docsConfig.map((section) => (
            <div key={section.title}>
              <h4 className="mb-2 px-2 text-sm font-semibold text-foreground">
                {section.title}
              </h4>
              <ul className="flex flex-col gap-0.5">
                {section.pages.map((page) => (
                  <li key={page.href}>
                    <Link
                      href={page.href}
                      className={cn(
                        "flex rounded-md px-2 py-1.5 text-sm transition-colors",
                        pathname === page.href
                          ? "bg-primary/10 font-medium text-primary"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground"
                      )}
                    >
                      {page.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </nav>
    </aside>
  );
}

export function SidebarContent() {
  const pathname = usePathname();

  return (
    <div className="flex flex-col gap-6 py-4">
      {docsConfig.map((section) => (
        <div key={section.title}>
          <h4 className="mb-2 px-2 text-sm font-semibold text-foreground">
            {section.title}
          </h4>
          <ul className="flex flex-col gap-0.5">
            {section.pages.map((page) => (
              <li key={page.href}>
                <Link
                  href={page.href}
                  className={cn(
                    "flex rounded-md px-2 py-1.5 text-sm transition-colors",
                    pathname === page.href
                      ? "bg-primary/10 font-medium text-primary"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                >
                  {page.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

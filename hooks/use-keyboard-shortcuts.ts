"use client";

import { useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { getAllPages } from "@/lib/docs-config";

export function useKeyboardShortcuts() {
  const router = useRouter();
  const pathname = usePathname();
  const { theme, setTheme } = useTheme();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const isInput =
        ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName) ||
        target?.isContentEditable;

      if (isInput) return;

      // t - toggle theme
      if (e.key === "t" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setTheme(theme === "dark" ? "light" : "dark");
        return;
      }

      // [ and ] - prev/next page
      if (e.key === "[" || e.key === "]") {
        e.preventDefault();
        const allPages = getAllPages();
        const currentIndex = allPages.findIndex((p) => p.href === pathname);
        if (currentIndex === -1) return;

        if (e.key === "[" && currentIndex > 0) {
          router.push(allPages[currentIndex - 1].href);
        } else if (e.key === "]" && currentIndex < allPages.length - 1) {
          router.push(allPages[currentIndex + 1].href);
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [router, pathname, theme, setTheme]);
}

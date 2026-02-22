import { Header } from "@/components/header";
import { Sidebar } from "@/components/docs/sidebar";
import { TableOfContents } from "@/components/docs/toc";
import { KeyboardShortcuts } from "@/components/keyboard-shortcuts";

export default function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <KeyboardShortcuts />
      <Header />
      <div className="flex flex-1 justify-center">
        <div className="flex w-full max-w-7xl px-4 md:px-6">
          <Sidebar />
          <main
            className="flex-1 min-w-0 py-6 lg:px-8"
            data-docs-content
          >
            <div className="mx-auto max-w-3xl">
              {children}
            </div>
          </main>
          <TableOfContents />
        </div>
      </div>
    </div>
  );
}

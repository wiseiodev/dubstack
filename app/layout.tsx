import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans, Source_Serif_4, JetBrains_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

const plusJakartaSans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-sans",
});

const sourceSerif4 = Source_Serif_4({
  subsets: ["latin"],
  variable: "--font-serif",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: {
    default: "DubStack - Local-First CLI for Stacked Branch Workflows",
    template: "%s | DubStack",
  },
  description:
    "DubStack is a local-first CLI for stacked branch workflows. Create, manage, and submit stacked PRs with ease.",
  keywords: [
    "git",
    "stacked diffs",
    "stacked PRs",
    "CLI",
    "developer tools",
    "DubStack",
    "graphite alternative",
  ],
  authors: [{ name: "wiseiodev" }],
  openGraph: {
    title: "DubStack - Local-First CLI for Stacked Branch Workflows",
    description:
      "Create, manage, and submit stacked PRs with ease. A Graphite-compatible CLI built for speed.",
    url: "https://dubstack.dev",
    siteName: "DubStack",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f9f9fa" },
    { media: "(prefers-color-scheme: dark)", color: "#1a1a2e" },
  ],
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${plusJakartaSans.variable} ${sourceSerif4.variable} ${jetbrainsMono.variable} font-sans antialiased`}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}

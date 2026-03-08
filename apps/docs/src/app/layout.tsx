import { RootProvider } from 'fumadocs-ui/provider/next';
import type { Metadata, Viewport } from 'next';
import {
  JetBrains_Mono,
  Plus_Jakarta_Sans,
  Source_Serif_4,
} from 'next/font/google';
import './global.css';

const plusJakartaSans = Plus_Jakarta_Sans({
  subsets: ['latin'],
  variable: '--font-sans',
});

const sourceSerif4 = Source_Serif_4({
  subsets: ['latin'],
  variable: '--font-serif',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
});

export const metadata: Metadata = {
  metadataBase: new URL('https://dubstack.dev'),
  title: {
    default: 'DubStack - Local-First CLI for Stacked Branch Workflows',
    template: '%s | DubStack',
  },
  description:
    'DubStack is a local-first CLI for stacked branch workflows. Create, manage, and submit stacked PRs with ease.',
  keywords: [
    'git',
    'stacked diffs',
    'stacked PRs',
    'CLI',
    'developer tools',
    'DubStack',
    'graphite alternative',
  ],
  authors: [{ name: 'wiseiodev' }],
  openGraph: {
    title: 'DubStack - Local-First CLI for Stacked Branch Workflows',
    description:
      'Create, manage, and submit stacked PRs with ease. A Graphite-compatible CLI built for speed.',
    url: 'https://dubstack.dev',
    siteName: 'DubStack',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'DubStack - Local-First CLI for Stacked Branch Workflows',
    description:
      'Create, manage, and submit stacked PRs with ease. A Graphite-compatible CLI built for speed.',
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f9f9fa' },
    { media: '(prefers-color-scheme: dark)', color: '#1a1a2e' },
  ],
  width: 'device-width',
  initialScale: 1,
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang='en'
      className={`${plusJakartaSans.variable} ${sourceSerif4.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <body className='flex flex-col min-h-screen font-sans antialiased'>
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}

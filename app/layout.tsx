import './globals.css';
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { Providers } from './providers';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

// Phase 9.9.19C -- the framework-guaranteed source of truth for both tags,
// now that this file is a real server component again (see providers.tsx
// for why it wasn't). Next.js renders these into <head> server-side, in
// the raw initial HTML, with no dependency on client hydration -- unlike
// the manual <meta> JSX this replaces, which produced a duplicate (if
// identical) viewport tag because Next.js synthesized its own fallback
// whenever a client component root layout meant this export path wasn't
// available to use instead.
// Phase 9.9.19C -- this project pins next@13.5.1, where viewport is a
// field on Metadata itself rather than the separate `export const
// viewport` API Next 14+ introduced. The string form is the most broadly
// compatible way to express it across 13.x point releases.
export const metadata: Metadata = {
  title: 'MagicFlux — Turn Prompts into Live Automations',
  description: 'MagicFlux turns plain English into live, working automations. Built for property managers, Airbnb hosts, and Shopify operators.',
  viewport: 'width=device-width, initial-scale=1',
  icons: {
    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⚡</text></svg>",
  },
  openGraph: {
    title: 'MagicFlux — Turn Prompts into Live Automations',
    description: 'MagicFlux turns plain English into live, working automations.',
    siteName: 'MagicFlux',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.variable} font-sans`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

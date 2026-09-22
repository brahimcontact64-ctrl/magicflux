'use client';

import { ThemeProvider } from 'next-themes';
import { AuthProvider } from '@/lib/auth-context';
import { Toaster } from '@/components/ui/sonner';

/**
 * Phase 9.9.19C -- split out of app/layout.tsx. The root layout previously
 * had `'use client'` at its own top level solely because it needed to
 * mount these three client-only providers -- but that made the ENTIRE
 * layout a client component, which meant `<meta name="viewport">` could
 * only ever be authored as manual JSX inside <head> rather than through
 * Next.js's own server-rendered `viewport` export (client components
 * cannot export `metadata`/`viewport` at all -- Next.js silently ignores
 * it). Confirmed via the raw server-rendered HTML that this had already
 * produced two duplicate (if identical) <meta name="viewport"> tags: one
 * from this file's own JSX, one Next.js synthesized as its own fallback
 * because no valid `viewport` export existed for it to use instead.
 * Isolating the client-only providers here lets the root layout go back
 * to being a real server component with a single, framework-guaranteed
 * viewport tag in the initial HTML -- present from the very first byte,
 * never dependent on client-side hydration timing.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
      <AuthProvider>
        {children}
        <Toaster position="top-right" richColors />
      </AuthProvider>
    </ThemeProvider>
  );
}

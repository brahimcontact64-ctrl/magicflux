'use client';

import { useEffect, useState } from 'react';

/**
 * Phase 9.4.2 — the one shared breakpoint check for switching between the
 * desktop React Flow canvas and the mobile step-list editor (and any other
 * responsive branch that needs a real JS decision, not just CSS
 * show/hide). CSS-only responsive classes are preferred wherever they're
 * enough; this exists specifically for cases where an entire heavy
 * component (React Flow) should not even mount on a narrow viewport.
 *
 * SSR-safe: returns `false` (desktop) until mounted, then measures the
 * real viewport — avoids a hydration mismatch by rendering the same thing
 * server and client on first paint, then swapping immediately after.
 * This means a mobile visitor briefly has the desktop tree in the React
 * tree description, but nothing heavy actually paints before the swap on
 * next tick, and no runtime error results either way.
 */
export function useIsBelowBreakpoint(breakpointPx: number): boolean {
  const [isBelow, setIsBelow] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpointPx - 1}px)`);
    const update = () => setIsBelow(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, [breakpointPx]);

  return isBelow;
}

/** Tailwind's `md` breakpoint (768px) — the same threshold used throughout this codebase's `md:` classes. */
export function useIsMobileEditor(): boolean {
  return useIsBelowBreakpoint(768);
}

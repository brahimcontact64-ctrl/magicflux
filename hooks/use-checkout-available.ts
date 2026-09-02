'use client';

import { useEffect, useState } from 'react';

/**
 * Phase 9.5 Step C/D — shared by every Upgrade CTA (pricing page, builder
 * page, navbar). Stripe being unconfigured today is a known, standing
 * state, not a transient outage, so every CTA should know this BEFORE
 * attempting a checkout call that will 503, not find out from a toast
 * after the fact. Defaults to `false` (unavailable) until the check
 * resolves, never the other way -- a slow/failed fetch must never render
 * a CTA that looks live and then fails.
 *
 * Reads the same /api/billing/plans response every pricing surface
 * already fetches for its plan list -- no new API surface.
 */
export function useCheckoutAvailable(): boolean {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/billing/plans', { cache: 'no-store' })
      .then((res) => res.json())
      .then((data: { checkoutAvailable?: boolean }) => {
        if (!cancelled) setAvailable(Boolean(data.checkoutAvailable));
      })
      .catch(() => {
        if (!cancelled) setAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return available;
}

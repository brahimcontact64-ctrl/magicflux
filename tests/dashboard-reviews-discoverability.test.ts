/**
 * Phase 9.9.5 — Human Review Discoverability / Beta UX.
 *
 * Before this fix, a live execution could sit correctly paused at
 * magicflux-nodes.humanReview (canonical 'waiting' status, fully
 * runtime-certified per Phase 9.9.4I) with a working /reviews page and API
 * -- but the authenticated Dashboard, the app's actual landing hub, had no
 * link to it and no indicator that a decision was pending. A user had no
 * way to discover where to act.
 *
 * This project has no jsdom/testing-library configured (vitest.config.ts
 * runs environment: 'node'), and app/dashboard/page.tsx is a large client
 * component wired to useAuth/router/supabase -- rendering it here would
 * need a disproportionate mocking harness for what's fundamentally a
 * "does this markup/wiring exist" question. So, consistent with this
 * codebase's established pattern for frontend regressions that can't be
 * rendered under vitest (tests/workflow-integrations-provider-alias.test.ts's
 * force-dynamic pin, tests/test-runtime-waiting-status.test.ts's badge
 * pins), these are precise source-level pins on the actual shipped file.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const dashboardSource = fs.readFileSync(
  path.join(__dirname, '..', 'app', 'dashboard', 'page.tsx'),
  'utf8'
);

describe('Phase 9.9.5 -- Reviews entry in the authenticated Dashboard navigation', () => {
  it('the Dashboard header links to /reviews', () => {
    expect(dashboardSource).toMatch(/<Link href='\/reviews'/);
  });

  it('the nav entry is labeled clearly as Reviews, not a generic icon-only control', () => {
    // Unbounded (but still non-greedy) so this reliably reaches the header
    // nav Link's own closing tag rather than silently falling through to
    // the later, shorter "Review now" CTA Link if the header block happens
    // to contain more markup (e.g. a conditional count badge) than a fixed
    // character budget would allow.
    const navBlock = dashboardSource.match(/<Link href='\/reviews'[\s\S]*?<\/Link>/)?.[0] ?? '';
    expect(navBlock).toContain('Reviews');
  });
});

describe('Phase 9.9.5 -- Dashboard Pending Reviews indicator sources owner-scoped truth', () => {
  it('fetches the same owner-scoped /api/reviews endpoint the /reviews page itself uses -- no separate or admin-wide data source', () => {
    expect(dashboardSource).toMatch(/fetch\('\/api\/reviews\?status=pending'/);
  });

  it('never fabricates a pending count while the fetch is still in flight (null, not 0, is the initial/unknown state)', () => {
    expect(dashboardSource).toMatch(/useState<PendingReviewSummary\[\] \| null>\(null\)/);
    expect(dashboardSource).toMatch(/pendingReviews === null/);
  });

  it('does not silently coerce a failed fetch into "zero pending" -- a failure leaves the prior/unknown state alone', () => {
    expect(dashboardSource).toMatch(/setPendingReviews\(\(prev\) => prev\)/);
  });
});

describe('Phase 9.9.5 -- CTA and zero-state semantics', () => {
  it('shows a "Review now" CTA linking to /reviews only when the count is confirmed greater than zero', () => {
    expect(dashboardSource).toMatch(/pendingReviews !== null && pendingReviews\.length > 0[\s\S]{0,200}?Review now/);
  });

  it('renders a non-alarming empty state (not a bare "0") when there are genuinely no pending reviews', () => {
    expect(dashboardSource).toContain('No workflows are waiting on a human decision right now.');
    // The zero-state copy must not itself render the literal count.
    const zeroStateLine = dashboardSource.split('\n').find((l) => l.includes('No workflows are waiting on a human decision right now.'));
    expect(zeroStateLine).toBeDefined();
    expect(zeroStateLine).not.toMatch(/\{pendingReviews\.length\}/);
  });
});

describe('Phase 9.9.5 -- failures, waiting executions, and pending reviews stay distinct concepts', () => {
  it('the Dashboard still tracks failed executions as its own stat, separate from the reviews indicator', () => {
    expect(dashboardSource).toMatch(/text-xs text-muted-foreground'>Failed<\/p>/);
    expect(dashboardSource).toMatch(/\{stats\.failed\}/);
  });

  it('the Pending Reviews banner documents itself as distinct from both failures and generic waiting status', () => {
    expect(dashboardSource).toMatch(/distinct\s+product\s+concept\s+from\s+a\s+failed\s+execution/);
  });
});

describe('Phase 9.9.5 -- /reviews routing stays intact and owner-gated', () => {
  const reviewsPageSource = fs.readFileSync(
    path.join(__dirname, '..', 'app', 'reviews', 'page.tsx'),
    'utf8'
  );

  it('the /reviews page still redirects unauthenticated visitors to /login rather than rendering anything', () => {
    expect(reviewsPageSource).toMatch(/if \(!user\) redirect\('\/login'\)/);
  });

  it('the /reviews page still renders the existing ReviewsPanel rather than a duplicated review UI', () => {
    expect(reviewsPageSource).toMatch(/<ReviewsPanel\s*\/>/);
  });
});

/**
 * Phase 9.5 Step H — regression test for a real production bug found live:
 * app/executions/page.tsx and app/executions/[id]/page.tsx both built their
 * auth-guard request object as
 *   { headers: Object.fromEntries((await headers()).entries()) }
 * which produces a PLAIN OBJECT. getUserFromRequest()'s very first line is
 * `req.headers.get('authorization')` -- a plain object has no .get(), so
 * this threw "TypeError: e.headers.get is not a function" on every single
 * visit (confirmed via the running server's own stack trace, digest
 * 359600837), crashing the entire executions list and every execution
 * detail page for any authenticated user. Fixed by passing next/headers'
 * headers() result straight through instead of flattening it.
 *
 * This test locks in the fix's contract: getUserFromRequest() must be
 * called with something Headers-like (a real `.get()`), not a plain object
 * -- so a future regression to the Object.fromEntries(...) pattern fails
 * fast here instead of only in a live server render.
 */

import { describe, it, expect } from 'vitest';
import { getUserFromRequest } from '@/lib/supabase-server';

describe('getUserFromRequest -- header object shape contract', () => {
  it('throws when headers is a plain object (the exact regression: Object.fromEntries(...) loses .get())', async () => {
    const plainObjectReq = {
      headers: Object.fromEntries(new Headers({ authorization: 'Bearer whatever' }).entries()),
    };

    await expect(getUserFromRequest(plainObjectReq as never)).rejects.toThrow(/\.get is not a function/);
  });

  it('does not throw when headers is a real Headers-like object with .get() (no auth header -> resolves to null)', async () => {
    const realHeadersReq = { headers: new Headers() };

    await expect(getUserFromRequest(realHeadersReq as never)).resolves.toBeNull();
  });
});

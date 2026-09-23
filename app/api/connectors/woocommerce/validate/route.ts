/**
 * Phase 9.9.22B -- lightweight "Test Connection" for the pre-connect form:
 * proves a typed-in Store URL/Consumer Key/Consumer Secret actually work
 * BEFORE committing to creating a real webhook subscription. Reuses the
 * exact same SSRF-guarded reachability check and credentials check the
 * real Connect flow uses -- never a second, divergent validation path.
 * Persists nothing; never returns the submitted credentials.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase-server';
import { diagnoseWooCommerceConnection } from '@/lib/connectors/woocommerce/client';

export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { storeUrl?: string; consumerKey?: string; consumerSecret?: string };
  if (!body.storeUrl || !body.consumerKey || !body.consumerSecret) {
    return NextResponse.json({ stage: 'credentials_invalid', detail: 'Store URL, Consumer Key and Consumer Secret are all required.' });
  }

  // Phase 9.9.22B -- full staged diagnosis (store -> WordPress REST ->
  // WooCommerce namespace -> credentials -> webhooks endpoint), with the
  // pretty-permalink/rest_route compatibility fallback applied
  // transparently at every step. Never a raw upstream body in the
  // response -- only the fixed, pre-written detail string per stage.
  const diagnosis = await diagnoseWooCommerceConnection(body.storeUrl, { storeUrl: body.storeUrl, consumerKey: body.consumerKey, consumerSecret: body.consumerSecret });

  if (diagnosis.stage === 'ready') {
    return NextResponse.json({ stage: 'ready', detail: 'Store reachable and credentials valid. Click "Connect WooCommerce" to finish setup.' });
  }
  return NextResponse.json({ stage: diagnosis.stage, detail: diagnosis.detail });
}

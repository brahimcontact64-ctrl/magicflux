import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-server';

export async function GET() {
  const db = createServiceClient();

  const { data, error } = await db
    .from('plans')
    .select('slug, name, price_monthly, integrations_limit, workflows_limit, executions_limit, deploy_enabled')
    .order('price_monthly', { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ plans: data ?? [] });
}

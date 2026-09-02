import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-server';
import { classifyError } from '@/lib/security/safe-error';

export async function GET() {
  const db = createServiceClient();

  const { data, error } = await db
    .from('plans')
    .select('slug, name, price_monthly, integrations_limit, workflows_limit, executions_limit, deploy_enabled')
    .order('price_monthly', { ascending: true });

  if (error) {
    const safe = classifyError(error);
    return NextResponse.json({ error: safe.code, message: safe.message, retryable: safe.retryable }, { status: safe.httpStatus });
  }

  return NextResponse.json({ plans: data ?? [] });
}

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createServiceClient } from '@/lib/supabase-server';

type Ctx = { params: { id: string } };

const SECRET_KEYS = ['password', 'pass', 'token', 'secret', 'api_key', 'apikey', 'webhook_url', 'authorization'];

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (!value || typeof value !== 'object') return value;

  const obj = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    const lower = key.toLowerCase();
    if (SECRET_KEYS.some((secretKey) => lower.includes(secretKey))) {
      next[key] = '[REDACTED]';
      continue;
    }
    next[key] = redact(val);
  }
  return next;
}

/**
 * GET /api/workflows/executions/[id]/steps
 * Returns all steps for a given execution (user must own the execution)
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  // Auth via Bearer token
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } }
  );
  const { data: userData } = await client.auth.getUser(authHeader.slice(7));
  if (!userData.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = createServiceClient();

  // Validate ownership
  const { data: exec } = await db
    .from('workflow_executions_v2')
    .select('id, user_id')
    .eq('id', params.id)
    .maybeSingle();

  if (!exec || exec.user_id !== userData.user.id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { data: steps, error } = await db
    .from('workflow_execution_steps')
    .select('*')
    .eq('execution_id', params.id)
    .order('created_at', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const safeSteps = (steps ?? []).map((step) => ({
    ...step,
    input_data: redact(step.input_data),
    output_data: redact(step.output_data),
    logs: Array.isArray(step.logs) ? step.logs.map((line: unknown) => String(redact(line))) : step.logs,
    error_message: typeof step.error_message === 'string' ? String(redact(step.error_message)) : step.error_message,
  }));

  return NextResponse.json({ steps: safeSteps });
}

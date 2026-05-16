import { NextRequest, NextResponse } from 'next/server';

import { createServiceClient, getUserFromRequest } from '@/lib/supabase-server';

type Ctx = { params: { id: string } };

export async function POST(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = createServiceClient();
  const { data: existing, error: fetchError } = await db
    .from('workflows')
    .select('name, description, prompt, workflow_json, integrations')
    .eq('id', params.id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 });
  if (!existing) return NextResponse.json({ error: 'Workflow not found' }, { status: 404 });

  const { data, error } = await db
    .from('workflows')
    .insert({
      user_id: user.id,
      name: `Copy of ${existing.name}`,
      description: existing.description,
      prompt: existing.prompt,
      workflow_json: existing.workflow_json,
      integrations: existing.integrations,
      status: 'draft',
    })
    .select('id, name, description, prompt, workflow_json, integrations, status, n8n_workflow_id, created_at, updated_at')
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true, workflow: data }, { status: 201 });
}

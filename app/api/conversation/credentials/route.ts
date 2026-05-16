import { NextRequest, NextResponse } from 'next/server';

import {
  markCredential,
  providerCredentialIsValid,
} from '@/lib/conversation-agent';
import { createServiceClient, getBearerToken, getUserFromAccessToken } from '@/lib/supabase-server';

async function getUserId(req: NextRequest): Promise<string | null> {
  const token = getBearerToken(req);
  if (!token) return null;
  const user = await getUserFromAccessToken(token);
  return user?.id ?? null;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as {
    sessionId?: string;
    provider?: string;
    credential?: string;
  };

  const sessionId = String(body.sessionId ?? '').trim();
  const provider = String(body.provider ?? '').trim().toLowerCase();
  const credential = String(body.credential ?? '').trim();

  if (!sessionId || !provider || !credential) {
    return NextResponse.json({ error: 'sessionId, provider and credential are required' }, { status: 400 });
  }

  if (!providerCredentialIsValid(provider, credential)) {
    return NextResponse.json({ error: 'Credential validation failed for selected provider' }, { status: 422 });
  }

  const userId = await getUserId(req);
  const db = createServiceClient();

  let query = db
    .from('automation_conversations')
    .select('id, collected_credentials')
    .eq('session_id', sessionId)
    .limit(1);
  if (userId) query = query.eq('user_id', userId);

  const { data: session, error: findError } = await query.maybeSingle();
  if (findError) return NextResponse.json({ error: findError.message }, { status: 500 });
  if (!session) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });

  const encrypted = markCredential(
    (session.collected_credentials ?? {}) as Record<string, unknown>,
    provider,
    credential
  );

  const { error: updateError } = await db
    .from('automation_conversations')
    .update({
      collected_credentials: encrypted,
      updated_at: new Date().toISOString(),
    })
    .eq('id', session.id);

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, provider, status: 'connected' });
}

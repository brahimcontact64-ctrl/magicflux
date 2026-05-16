import { NextRequest, NextResponse } from 'next/server';

import {
  type ConversationMessage,
  type ConversationSlots,
  type PlannerStatus,
} from '@/lib/conversation-agent';
import { processConversationTurn } from '@/lib/conversation/service';
import { createServiceClient, getBearerToken, getUserFromAccessToken } from '@/lib/supabase-server';
import { decryptJson } from '@/lib/security/encryption';

export const dynamic = "force-dynamic";

type ConversationRow = {
  id: string;
  session_id: string;
  user_id: string | null;
  current_goal: string;
  detected_trigger: string | null;
  detected_action: string | null;
  detected_platform: string | null;
  slot_trigger: string | null;
  slot_action: string | null;
  slot_platform: string | null;
  slot_destination: string | null;
  slot_ai_provider: string | null;
  slot_schedule: string | null;
  required_integrations: string[] | null;
  collected_credentials: Record<string, unknown> | null;
  missing_fields: string[] | null;
  conversation_history: ConversationMessage[] | null;
  planner_status: PlannerStatus;
  confidence: number;
  canonical_prompt: string;
};

function toSlots(row: ConversationRow | null): ConversationSlots {
  return {
    trigger: row?.slot_trigger ?? null,
    action: row?.slot_action ?? null,
    platform: row?.slot_platform ?? null,
    destination: row?.slot_destination ?? null,
    ai_provider: row?.slot_ai_provider ?? null,
    schedule: row?.slot_schedule ?? null,
    automation_style: null,
    business_type: null,
  };
}

async function getUserId(req: NextRequest): Promise<string | null> {
  const token = getBearerToken(req);
  if (!token) return null;
  const user = await getUserFromAccessToken(token);
  return user?.id ?? null;
}

async function getConnectedIntegrations(userId: string | null): Promise<Set<string>> {
  if (!userId) return new Set<string>();

  const db = createServiceClient();
  const { data } = await db
    .from('user_integrations')
    .select('provider, status')
    .eq('user_id', userId);

  return new Set(
    (data ?? [])
      .filter((row: { status: string }) => row.status === 'connected')
      .map((row: { provider: string }) => String(row.provider))
  );
}

// ---------------------------------------------------------------------------
// OpenAI Reasoning Layer — the autonomous AI builder brain
// ---------------------------------------------------------------------------
// (reasoning now handled by runAgentLoop in lib/agent/loop.ts)

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId')?.trim();
  if (!sessionId) {
    return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
  }

  const db = createServiceClient();
  const userId = await getUserId(req);

  let query = db
    .from('automation_conversations')
    .select('*')
    .eq('session_id', sessionId)
    .limit(1);

  if (userId) query = query.eq('user_id', userId);

  const { data, error } = await query.maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });

  const row = data as ConversationRow;
  const slots = toSlots(row);
  const credentialState = decryptJson(row.collected_credentials ?? {});
  const readyToBuild = row.planner_status === 'ready_to_build';

  let workflowGraph: Record<string, unknown> | null = null;
  try {
    let feedbackQuery = db
      .from('workflow_feedback')
      .select('generated_workflow, created_at')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(1);

    if (userId) {
      feedbackQuery = feedbackQuery.eq('user_id', userId);
    }

    const { data: feedbackRow } = await feedbackQuery.maybeSingle();
    if (feedbackRow?.generated_workflow && typeof feedbackRow.generated_workflow === 'object') {
      workflowGraph = feedbackRow.generated_workflow as Record<string, unknown>;
    }
  } catch {
    workflowGraph = null;
  }

  return NextResponse.json({
    success: true,
    workflowGraph,
    state: {
      sessionId: row.session_id,
      currentGoal: row.current_goal,
      detectedTrigger: row.detected_trigger,
      detectedAction: row.detected_action,
      detectedPlatform: row.detected_platform,
      requiredIntegrations: row.required_integrations ?? [],
      collectedCredentials: credentialState,
      missingFields: row.missing_fields ?? [],
      conversationHistory: row.conversation_history ?? [],
      plannerStatus: row.planner_status,
      slots,
      confidence: row.confidence,
      readyToBuild,
      canonicalPrompt: row.canonical_prompt,
    },
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as {
    sessionId?: string;
    message?: string;
    mode?: 'safe_preview' | 'staging_deploy' | 'production_deploy';
  };

  const message = String(body.message ?? '').trim();
  if (!message) {
    return NextResponse.json({ error: 'message is required' }, { status: 400 });
  }

  try {
    const payload = await processConversationTurn({
      req,
      message,
      sessionId: body.sessionId,
      mode: body.mode,
    });
    return NextResponse.json(payload);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Conversation processing failed';
    return NextResponse.json({ error: errMsg }, { status: 500 });
  }
}

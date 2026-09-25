import 'server-only';

import { randomUUID } from 'node:crypto';
import { createServiceClient } from '@/lib/supabase-server';
import { assertLocalSupabaseTargetOrExit } from './production-guard';

/**
 * Workflow #2 Phase D.1 -- synthetic, local-staging-only test data for the
 * real Gmail reply-loop certification. Every row this creates is tagged
 * with the literal marker MAGICFLUX_PHASE_D_STAGING so it can never be
 * mistaken for real data, and NONE of it reuses Workflow #1's real
 * identifiers, Sigma Plus data, production lead/customer records, or
 * WooCommerce certification data -- everything here is freshly generated.
 *
 * Guarded by assertLocalSupabaseTargetOrExit() as the very first action,
 * before any database call -- this script refuses to run against anything
 * but a recognized local Supabase instance.
 */

export const PHASE_D_STAGING_MARKER = 'MAGICFLUX_PHASE_D_STAGING';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export type StagingSeedResult = {
  userId: string;
  workflowId: string;
  executionId: string;
  conversationId: string;
  sequenceId: string;
};

/**
 * Idempotent: re-running this against the SAME local database finds and
 * reuses the existing staging fixture (matched by the marker embedded in
 * workflow name / entity_reference) rather than creating duplicates.
 */
export async function seedPhaseDStagingData(db: ReturnType<typeof createServiceClient>): Promise<StagingSeedResult> {
  const stagingEmail = `${PHASE_D_STAGING_MARKER.toLowerCase()}@magicflux.local`;

  // 1. A dedicated synthetic auth user -- never a real customer, never
  // Workflow #1's own owning user.
  let userId: string;
  const { data: existingUsers } = await db.auth.admin.listUsers();
  const existingUser = existingUsers?.users.find((u) => u.email === stagingEmail);
  if (existingUser) {
    userId = existingUser.id;
  } else {
    const { data: created, error: createUserError } = await db.auth.admin.createUser({
      email: stagingEmail,
      email_confirm: true,
      user_metadata: { marker: PHASE_D_STAGING_MARKER },
    });
    if (createUserError || !created.user) throw new Error(`Failed to create staging user: ${createUserError?.message}`);
    userId = created.user.id;
  }

  // 2. A dedicated synthetic workflow row -- distinct name, distinct owner,
  // never Workflow #1's real id.
  const workflowName = `${PHASE_D_STAGING_MARKER} -- Reply Loop Certification`;
  let workflowId: string;
  const { data: existingWorkflow } = await db.from('workflows').select('id').eq('user_id', userId).eq('name', workflowName).maybeSingle();
  if (existingWorkflow) {
    workflowId = String((existingWorkflow as { id: string }).id);
  } else {
    const { data: createdWorkflow, error: workflowError } = await db
      .from('workflows')
      .insert({ user_id: userId, name: workflowName, status: 'draft', workflow_json: { nodes: [], connections: {} } })
      .select('id')
      .single();
    if (workflowError || !createdWorkflow) throw new Error(`Failed to create staging workflow: ${workflowError?.message}`);
    workflowId = String((createdWorkflow as { id: string }).id);
  }

  // 3. A dedicated conversation, thread id left EMPTY until the real send
  // (Phase D.1 does not send yet) assigns Gmail's own thread id.
  // execution_id is a genuine uuid column (Phase A's schema) -- generated
  // fresh only when actually creating a new row, then read back from the
  // existing row on every subsequent idempotent call, never regenerated.
  const provider = 'gmail';
  const providerThreadId = `${PHASE_D_STAGING_MARKER}-pending-thread`;
  let conversationId: string;
  let executionId: string;
  const { data: existingConversation } = await db
    .from('runtime_conversations')
    .select('id, execution_id')
    .eq('workflow_id', workflowId)
    .eq('provider', provider)
    .eq('provider_thread_id', providerThreadId)
    .maybeSingle();
  if (existingConversation) {
    conversationId = String((existingConversation as { id: string }).id);
    executionId = String((existingConversation as { execution_id: string }).execution_id);
  } else {
    executionId = randomUUID();
    const { data: createdConversation, error: conversationError } = await db
      .from('runtime_conversations')
      .insert({
        user_id: userId,
        workflow_id: workflowId,
        execution_id: executionId,
        provider,
        provider_thread_id: providerThreadId,
        entity_reference: PHASE_D_STAGING_MARKER,
      })
      .select('id')
      .single();
    if (conversationError || !createdConversation) throw new Error(`Failed to create staging conversation: ${conversationError?.message}`);
    conversationId = String((createdConversation as { id: string }).id);
  }

  // 4. An active follow-up sequence for that conversation.
  let sequenceId: string;
  const { data: existingSequence } = await db.from('runtime_followup_sequences').select('id, status').eq('conversation_id', conversationId).maybeSingle();
  if (existingSequence) {
    sequenceId = String((existingSequence as { id: string }).id);
  } else {
    const { data: createdSequence, error: sequenceError } = await db
      .from('runtime_followup_sequences')
      .insert({ user_id: userId, workflow_id: workflowId, execution_id: executionId, conversation_id: conversationId, status: 'active' })
      .select('id')
      .single();
    if (sequenceError || !createdSequence) throw new Error(`Failed to create staging sequence: ${sequenceError?.message}`);
    sequenceId = String((createdSequence as { id: string }).id);
  }

  return { userId, workflowId, executionId, conversationId, sequenceId };
}

async function main() {
  assertLocalSupabaseTargetOrExit(requireEnv('NEXT_PUBLIC_SUPABASE_URL'));

  const db = createServiceClient();
  const result = await seedPhaseDStagingData(db);
  console.log(JSON.stringify({ marker: PHASE_D_STAGING_MARKER, ...result }, null, 2));
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

import 'server-only';
import { createServiceClient } from '@/lib/supabase-server';
import { ensureWebhookSecret } from '@/lib/workflow/webhook-secret';

/**
 * Phase 9.9.21 -- creates ONE disposable @magicflux.local account plus one
 * disposable, DRAFT (never active) webhook-triggered workflow shaped
 * closely like Workflow #1's Sigma Plus intake (name/email/budget/urgency/
 * purchase_intent) so the Connection Guide's field derivation has real
 * downstream references to find. Draft status is deliberate: Test
 * Connection is only ever available for a non-active workflow (see
 * lib/workflow/webhook-test-mode.ts), and this fixture must never touch or
 * resemble the real, certified, currently-active Sigma Plus production
 * workflow or its data.
 */

const EMAIL = `e2e-connect-9921-${Date.now()}@magicflux.local`;
const PASSWORD = `E2eConnect9921!${Math.random().toString(36).slice(2)}`;

const TEST_WORKFLOW_JSON = {
  name: 'E2E Connection Guide Fixture',
  nodes: [
    { id: '1', name: 'Webhook Trigger', type: 'n8n-nodes-base.webhook', parameters: { httpMethod: 'POST', path: 'e2e-connect-fixture' } },
    {
      id: '2',
      name: 'AI Classifier',
      type: 'magicflux-nodes.aiClassifier',
      parameters: { inputFields: ['budget', 'urgency', 'purchase_intent'], instruction: 'Classify as Hot, Warm, or Cold.', outputField: 'classification', allowedLabels: ['Hot', 'Warm', 'Cold'], confidenceThreshold: 0.6 },
    },
    {
      id: '3',
      name: 'Save to Airtable',
      type: 'n8n-nodes-base.airtable',
      parameters: { operation: 'create', fields: { Name: '={{$json["name"]}}', Email: '={{$json["email"]}}' } },
    },
  ],
  connections: {
    'Webhook Trigger': { main: [[{ node: 'AI Classifier', type: 'main', index: 0 }]] },
    'AI Classifier': { main: [[{ node: 'Save to Airtable', type: 'main', index: 0 }]] },
  },
};

async function main() {
  const db = createServiceClient();

  const { data: created, error } = await db.auth.admin.createUser({
    email: EMAIL,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error || !created.user) {
    console.log('ABORT: could not create test user:', error?.message);
    return;
  }
  const userId = created.user.id;

  const { data: wf, error: wfError } = await db
    .from('workflows')
    .insert({
      user_id: userId,
      name: TEST_WORKFLOW_JSON.name,
      description: 'Disposable E2E fixture for Phase 9.9.21 Connection Guide',
      prompt: 'e2e connection guide fixture',
      workflow_json: TEST_WORKFLOW_JSON,
      status: 'draft',
    })
    .select('id')
    .single();
  if (wfError || !wf) {
    console.log('ABORT: could not create test workflow:', wfError?.message);
    return;
  }

  // Pre-provision the webhook secret so the E2E spec can compute a valid
  // auth header without needing an extra authenticated round-trip first.
  const secretResult = await ensureWebhookSecret(userId, wf.id);

  console.log(JSON.stringify({ userId, email: EMAIL, password: PASSWORD, workflowId: wf.id, secret: secretResult.secret }));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

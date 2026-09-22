import 'server-only';
import { createServiceClient } from '@/lib/supabase-server';

/**
 * Phase 9.9.19 -- Part 10: creates ONE disposable @magicflux.local test
 * account plus one disposable, non-Sigma-Plus test workflow shaped like
 * the certified reference topology (webhook -> AI Classifier -> Human
 * Review -> Hot/Warm/Cold -> Airtable/Gmail/Slack/SLA) so every specialized
 * config panel (AiPolicyConfigPanel, HumanReviewConfigPanel,
 * NotificationContentConfigPanel, SlaConfigPanel) actually has a matching
 * node to render against. Never touches the real Sigma Plus workflow, its
 * deployment, or any real credential/integration.
 */

const EMAIL = `e2e-mobile-9919-${Date.now()}@magicflux.local`;
const PASSWORD = `E2eMobile9919!${Math.random().toString(36).slice(2)}`;

const TEST_WORKFLOW_JSON = {
  name: 'E2E Mobile Fixture Workflow',
  nodes: [
    { id: '1', name: 'Webhook Trigger', type: 'n8n-nodes-base.webhook', parameters: { path: 'e2e-mobile-fixture' } },
    { id: '2', name: 'AI Classifier', type: 'magicflux-nodes.aiClassifier', parameters: { inputFields: ['urgency', 'budget'], instruction: 'Classify as Hot, Warm, or Cold.', outputField: 'classification', allowedLabels: ['Hot', 'Warm', 'Cold'], confidenceThreshold: 0.6 } },
    { id: '3', name: 'Needs Review?', type: 'n8n-nodes-base.if', parameters: { conditions: { boolean: [{ value1: '={{$json["needs_review"]}}', value2: true, operation: 'equal' }] } } },
    { id: '4', name: 'Human Review', type: 'magicflux-nodes.humanReview', parameters: { instruction: 'Confirm classification.', outputField: 'classification', allowedOutcomes: ['Hot', 'Warm', 'Cold'] } },
    { id: '5', name: 'If Hot', type: 'n8n-nodes-base.if', parameters: { conditions: { string: [{ value1: '={{$json["classification"]}}', value2: 'Hot', operation: 'equal' }] } } },
    { id: '8', name: 'Save to Airtable', type: 'n8n-nodes-base.airtable', parameters: { operation: 'create' } },
    { id: '9', name: 'Send Slack Notification', type: 'n8n-nodes-base.slack', parameters: { channel: '#leads', message: 'New lead' } },
    { id: '10', name: 'Send Gmail Email', type: 'n8n-nodes-base.gmail', parameters: { to: 'test@example.com', subject: 'New lead', text: 'Body' } },
    { id: '12', name: 'Create Acknowledgment Challenge', type: 'magicflux-nodes.createAcknowledgmentChallenge', parameters: { slaMinutes: 15 } },
    { id: '13', name: 'Wait For Acknowledgment', type: 'magicflux-nodes.waitForAcknowledgment', parameters: {} },
    { id: '14', name: 'Escalation Alert', type: 'n8n-nodes-base.slack', parameters: { channel: '#leads', message: 'SLA breached' } },
  ],
  connections: {
    'Webhook Trigger': { main: [[{ node: 'AI Classifier', type: 'main', index: 0 }]] },
    'AI Classifier': { main: [[{ node: 'Needs Review?', type: 'main', index: 0 }]] },
    'Needs Review?': { main: [[{ node: 'Human Review', type: 'main', index: 0 }], [{ node: 'If Hot', type: 'main', index: 0 }]] },
    'Human Review': { main: [[{ node: 'If Hot', type: 'main', index: 0 }], [], []] },
    'If Hot': { main: [[{ node: 'Save to Airtable', type: 'main', index: 0 }, { node: 'Create Acknowledgment Challenge', type: 'main', index: 0 }], []] },
    'Create Acknowledgment Challenge': { main: [[{ node: 'Send Gmail Email', type: 'main', index: 0 }, { node: 'Send Slack Notification', type: 'main', index: 0 }]] },
    'Send Slack Notification': { main: [[{ node: 'Wait For Acknowledgment', type: 'main', index: 0 }]] },
    'Wait For Acknowledgment': { main: [[], [{ node: 'Escalation Alert', type: 'main', index: 0 }]] },
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
      description: 'Disposable E2E fixture for Phase 9.9.19 mobile certification',
      prompt: 'e2e fixture',
      workflow_json: TEST_WORKFLOW_JSON,
      status: 'draft',
    })
    .select('id')
    .single();
  if (wfError || !wf) {
    console.log('ABORT: could not create test workflow:', wfError?.message);
    return;
  }

  console.log(JSON.stringify({ userId, email: EMAIL, password: PASSWORD, workflowId: wf.id }));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

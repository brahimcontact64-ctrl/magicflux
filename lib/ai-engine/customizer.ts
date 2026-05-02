import { ParsedIntent, ModificationType, EnrichedGenerationResult } from './types';
import { AutomationTemplate } from '../templates';

interface CustomizationPatch {
  addedNodeName: string;
  nodeType: string;
  description: string;
  envAdditions: string;
  responseFragment: string;
}

const SLACK_NODE = (position: [number, number]) => ({
  parameters: {
    authentication: 'oAuth2',
    channel: '={{$env.SLACK_CHANNEL_ID}}',
    text: '={{$json.message || "Automation triggered: " + $workflow.name}}'
  },
  name: 'Slack Notification',
  type: 'n8n-nodes-base.slack',
  typeVersion: 2,
  position
});

const APPROVAL_NODE = (position: [number, number]) => ({
  parameters: {
    options: {},
    resume: 'webhook',
    webhookSuffix: 'approval'
  },
  name: 'Approval Step',
  type: 'n8n-nodes-base.wait',
  typeVersion: 1,
  position
});

const SHEETS_NODE = (position: [number, number]) => ({
  parameters: {
    operation: 'append',
    documentId: { value: '={{$env.GOOGLE_SHEET_ID}}' },
    sheetName: 'Automation Log',
    columns: { mappingMode: 'autoMapInputData' }
  },
  name: 'Log to Google Sheets',
  type: 'n8n-nodes-base.googleSheets',
  typeVersion: 4,
  position
});

const SMS_NODE = (position: [number, number]) => ({
  parameters: {
    from: '={{$env.TWILIO_FROM_NUMBER}}',
    to: '={{$json.phone || $env.MANAGER_PHONE}}',
    message: '={{$json.sms_message || "Automation notification from " + $workflow.name}}'
  },
  name: 'SMS Notification',
  type: 'n8n-nodes-base.twilio',
  typeVersion: 1,
  position
});

const ERROR_NODE = (position: [number, number]) => ({
  parameters: {
    fromEmail: '={{$env.FROM_EMAIL}}',
    toEmail: '={{$env.ERROR_NOTIFICATION_EMAIL}}',
    subject: 'Automation Error: {{$workflow.name}}',
    emailType: 'html',
    message: '<h2>Workflow Error</h2><p>An error occurred at: {{$execution.id}}</p><pre>{{$json.error}}</pre>'
  },
  name: 'Error Handler',
  type: 'n8n-nodes-base.emailSend',
  typeVersion: 2,
  position
});

const PATCHES: Partial<Record<ModificationType, (lastPos: [number, number]) => {
  node: object;
  name: string;
  envAdditions: string;
  responseFragment: string;
}>> = {
  add_slack: (p) => ({
    node: SLACK_NODE([p[0] + 200, p[1] - 100]),
    name: 'Slack Notification',
    envAdditions: '\n# ── Slack Integration ────────────────────────────────\nSLACK_BOT_TOKEN=xoxb-your-slack-bot-token\nSLACK_CHANNEL_ID=C0XXXXXXXXX\n',
    responseFragment: 'I\'ve added a **Slack Notification** node that fires after each trigger. Install the Slack Bot in n8n and add your `SLACK_BOT_TOKEN` and `SLACK_CHANNEL_ID` to your .env file.'
  }),
  add_approval: (p) => ({
    node: APPROVAL_NODE([p[0] + 200, p[1]]),
    name: 'Approval Step',
    envAdditions: '\n# ── Approval Webhook ─────────────────────────────────\nAPPROVAL_WEBHOOK_URL=https://your-n8n.com/webhook/approval\n',
    responseFragment: 'I\'ve inserted an **Approval Step** using n8n\'s Wait node. The workflow will pause until an approver visits the approval URL, then continue automatically.'
  }),
  add_sheets: (p) => ({
    node: SHEETS_NODE([p[0] + 200, p[1] + 100]),
    name: 'Log to Google Sheets',
    envAdditions: '\n# ── Google Sheets ────────────────────────────────────\nGOOGLE_SHEET_ID=your_google_sheet_id_here\n',
    responseFragment: 'A **Google Sheets Logger** node has been added. Every time the automation runs, it appends a row to your configured sheet. Add your `GOOGLE_SHEET_ID` to the .env.'
  }),
  add_sms: (p) => ({
    node: SMS_NODE([p[0] + 200, p[1]]),
    name: 'SMS Notification',
    envAdditions: '\n# ── Twilio SMS ────────────────────────────────────────\nTWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\nTWILIO_AUTH_TOKEN=your_twilio_auth_token\nTWILIO_FROM_NUMBER=+15551234567\nMANAGER_PHONE=+15559876543\n',
    responseFragment: 'An **SMS Notification** node (via Twilio) has been added. Add your Twilio credentials to the .env and you\'ll receive a text message for every automation event.'
  }),
  add_error_handling: (p) => ({
    node: ERROR_NODE([p[0], p[1] + 150]),
    name: 'Error Handler',
    envAdditions: '\n# ── Error Handling ───────────────────────────────────\nERROR_NOTIFICATION_EMAIL=ops@yourcompany.com\n',
    responseFragment: 'An **Error Handler** node has been added that sends an email notification if the workflow fails. Set `ERROR_NOTIFICATION_EMAIL` in your .env to receive failure alerts.'
  })
};

export function applyCustomization(
  current: EnrichedGenerationResult,
  intent: ParsedIntent
): Partial<EnrichedGenerationResult> {
  const { modificationType } = intent;

  if (!modificationType || modificationType === 'generic') {
    return {
      responseMessage: `I've noted your customization request: "${intent.rawPrompt}". This type of modification will be supported with full OpenAI integration. For now, you can manually edit the workflow JSON to apply custom changes.`,
      appliedCustomizations: [...(current.appliedCustomizations || []), intent.rawPrompt]
    };
  }

  const patch = PATCHES[modificationType];
  if (!patch) {
    return {
      responseMessage: `Customization noted. Add "${intent.rawPrompt}" to your workflow by editing the JSON directly in n8n.`,
      appliedCustomizations: [...(current.appliedCustomizations || []), intent.rawPrompt]
    };
  }

  const workflowData = current.template.workflow as Record<string, any>;
  const nodes: any[] = [...(workflowData.nodes || [])];
  const connections: Record<string, any> = { ...(workflowData.connections || {}) };

  const lastNode = [...nodes].sort((a, b) => b.position[0] - a.position[0])[0];
  const lastPos: [number, number] = lastNode?.position || [450, 300];

  const applied = patch(lastPos);
  const newNode = applied.node as any;

  nodes.push(newNode);

  const prevLastNodeName = lastNode?.name;
  if (prevLastNodeName && !connections[prevLastNodeName]) {
    connections[prevLastNodeName] = { main: [[{ node: applied.name, type: 'main', index: 0 }]] };
  }

  const updatedWorkflow = { ...workflowData, nodes, connections };

  const updatedTemplate: AutomationTemplate = {
    ...current.template,
    workflow: updatedWorkflow,
    nodeCount: current.template.nodeCount + 1,
    envConfig: current.template.envConfig + applied.envAdditions
  };

  return {
    template: updatedTemplate,
    responseMessage: applied.responseFragment,
    appliedCustomizations: [...(current.appliedCustomizations || []), intent.rawPrompt],
    workflowNodes: [...current.workflowNodes, {
      id: applied.name,
      label: applied.name,
      type: newNode.type?.split('.')?.pop() || 'utility',
      nodeType: 'messaging',
      position: newNode.position
    }]
  };
}

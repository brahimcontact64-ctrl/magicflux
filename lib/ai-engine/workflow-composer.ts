import {
  PackageScore,
  DependencyItem,
  VariableSchema,
  CredentialRequirement,
  WorkflowNode,
  WorkflowEdge,
  N8nNodeCategory
} from './types';
import { AutomationTemplate } from '../templates';
import { getTemplateEnrichment } from '../template-enrichments';

const BUSINESS_IMPACT: Record<string, number> = {
  'abandoned-cart': 9,
  'order-fulfillment': 8,
  'tenant-maintenance': 8,
  'guest-messaging': 8,
  'returns-workflow': 7,
  'rent-reminder': 7,
  'leasing-inquiry': 7,
  'checkin-checkout': 7,
  'cleaning-turnover': 6
};

const TIME_TO_ROI: Record<string, string> = {
  'abandoned-cart': '< 1 week',
  'order-fulfillment': '< 1 week',
  'tenant-maintenance': '< 2 weeks',
  'guest-messaging': '< 1 week',
  'returns-workflow': '1-2 weeks',
  'rent-reminder': '< 1 month',
  'leasing-inquiry': '< 2 weeks',
  'checkin-checkout': '< 1 week',
  'cleaning-turnover': '< 1 week'
};

export function computePackageScore(template: AutomationTemplate): PackageScore {
  const complexityMap: Record<string, number> = { beginner: 3, intermediate: 6, advanced: 9 };
  const complexity = complexityMap[template.complexity] || 5;
  const setupTime = parseInt(template.estimatedSetupTime) || 20;
  const businessImpact = BUSINESS_IMPACT[template.id] || 7;
  const nodeScore = Math.min(10, template.nodeCount * 1.5);
  const automationScore = Math.round((complexity + businessImpact + nodeScore) / 3);
  const label = automationScore >= 8 ? 'Enterprise' : automationScore >= 6 ? 'Professional' : 'Starter';

  return {
    complexity,
    setupTime,
    businessImpact,
    automationScore,
    label,
    timeToROI: TIME_TO_ROI[template.id] || '2-4 weeks'
  };
}

export function extractWorkflowNodes(workflow: Record<string, any>): WorkflowNode[] {
  const nodes: any[] = workflow.nodes || [];
  return nodes.map(node => {
    const rawType = (node.type as string).split('.').pop() || '';
    return {
      id: node.name as string,
      label: node.name as string,
      type: rawType,
      nodeType: classifyNodeType(rawType),
      position: node.position as [number, number]
    };
  });
}

export function extractWorkflowEdges(workflow: Record<string, any>): WorkflowEdge[] {
  const connections: Record<string, any> = workflow.connections || {};
  const edges: WorkflowEdge[] = [];

  for (const [source, outputs] of Object.entries(connections)) {
    const mainPorts: any[][] = outputs.main || [];
    for (const port of mainPorts) {
      if (!Array.isArray(port)) continue;
      for (const target of port) {
        if (target?.node) edges.push({ from: source, to: target.node });
      }
    }
  }
  return edges;
}

function classifyNodeType(type: string): N8nNodeCategory {
  const map: Record<string, N8nNodeCategory> = {
    webhook: 'trigger',
    scheduleTrigger: 'trigger',
    emailTrigger: 'trigger',
    code: 'transform',
    function: 'transform',
    set: 'transform',
    emailSend: 'email',
    gmail: 'email',
    airtable: 'database',
    googleSheets: 'database',
    notion: 'database',
    hubspot: 'crm',
    salesforce: 'crm',
    shopify: 'ecommerce',
    woocommerce: 'ecommerce',
    slack: 'messaging',
    twilio: 'messaging',
    telegram: 'messaging',
    googleCalendar: 'calendar',
    if: 'condition',
    switch: 'condition',
    wait: 'delay',
    httpRequest: 'utility',
    merge: 'utility'
  };
  return map[type] || 'utility';
}

export function composeCredentials(template: AutomationTemplate): CredentialRequirement[] {
  const enrichment = getTemplateEnrichment(template.id);
  return enrichment?.credentials || [];
}

export function composeDependencies(template: AutomationTemplate): DependencyItem[] {
  const enrichment = getTemplateEnrichment(template.id);
  return enrichment?.dependencies || [];
}

export function composeVariablesSchema(template: AutomationTemplate): VariableSchema[] {
  const enrichment = getTemplateEnrichment(template.id);
  return enrichment?.variables || [];
}

export function composeSuggestions(template: AutomationTemplate): string[] {
  const byIndustry: Record<string, string[]> = {
    'property-management': [
      'Add Slack notification for urgent requests',
      'Connect to Google Sheets for logging',
      'Add approval step before ticket creation',
      'Send SMS via Twilio instead of email'
    ],
    'airbnb': [
      'Add WhatsApp messages via Twilio',
      'Connect to smart lock system',
      'Add checkout review request',
      'Log events to Google Sheets'
    ],
    'shopify': [
      'Add Slack alert for each order',
      'Connect to inventory management',
      'Add SMS notification via Twilio',
      'Log orders to Google Sheets'
    ]
  };

  const base = byIndustry[template.industry] || [];
  const generic = ['Add error handling & alerts', 'Add delay / rate limiting'];
  return [...base.slice(0, 3), ...generic.slice(0, 1)];
}

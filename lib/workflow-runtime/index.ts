import vm from 'node:vm';

import type { IntegrationProvider } from '@/lib/integrations';
import type { UserIntegration } from '@/lib/user-integrations';

type RuntimeNode = {
  id?: string;
  name?: string;
  type?: string;
  parameters?: Record<string, unknown>;
};

type RuntimeConnection = {
  node: string;
  type?: string;
  index?: number;
};

type RuntimeWorkflow = {
  name?: string;
  nodes?: RuntimeNode[];
  connections?: Record<string, { main?: RuntimeConnection[][] }>;
};

type RuntimeStatus = 'success' | 'failed' | 'skipped';

type RuntimeStep = {
  nodeName: string;
  nodeType: string;
  status: RuntimeStatus;
  input: unknown;
  output: unknown;
  logs: string[];
  error?: string;
};

type RuntimePreviews = {
  emails: Array<Record<string, unknown>>;
  slackMessages: Array<Record<string, unknown>>;
  airtableRecords: Array<Record<string, unknown>>;
};

type RuntimeContext = {
  sampleData: Record<string, unknown>;
  integrations: UserIntegration[];
  previews: RuntimePreviews;
};

type ExecuteNodeResult = {
  status: RuntimeStatus;
  output: unknown;
  logs: string[];
  error?: string;
};

const MAX_NODE_EXECUTIONS = 200;

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function shallowMerge(input: unknown, patch: Record<string, unknown>) {
  return {
    ...asRecord(input),
    ...patch,
  };
}

function isLikelyUnsafeCode(code: string): boolean {
  const deniedPatterns = [
    /require\s*\(/i,
    /import\s+/i,
    /process\./i,
    /globalThis/i,
    /window\./i,
    /document\./i,
    /child_process/i,
    /fs\./i,
    /fetch\s*\(/i,
    /axios\./i,
    /eval\s*\(/i,
    /Function\s*\(/i,
  ];

  return deniedPatterns.some((pattern) => pattern.test(code));
}

function extractParameterString(node: RuntimeNode, keys: string[]): string {
  const params = node.parameters ?? {};

  for (const key of keys) {
    const val = params[key];
    if (typeof val === 'string' && val.trim().length > 0) {
      return val;
    }
  }

  return '';
}

function findStartNodes(nodes: RuntimeNode[], edges: Map<string, string[]>): string[] {
  const incoming = new Map<string, number>();
  for (const node of nodes) {
    const nodeName = String(node.name ?? node.id ?? '').trim();
    if (!nodeName) continue;
    incoming.set(nodeName, 0);
  }

  for (const targets of Array.from(edges.values())) {
    for (const target of targets) {
      incoming.set(target, (incoming.get(target) ?? 0) + 1);
    }
  }

  const triggerNodes = nodes
    .filter((node) => {
      const type = String(node.type ?? '').toLowerCase();
      return type.includes('webhook') || type.includes('trigger') || type.includes('manualtrigger');
    })
    .map((node) => String(node.name ?? node.id ?? '').trim())
    .filter(Boolean);

  if (triggerNodes.length > 0) return triggerNodes;

  const noIncoming = Array.from(incoming.entries())
    .filter(([, count]) => count === 0)
    .map(([name]) => name);

  if (noIncoming.length > 0) return noIncoming;

  const first = String(nodes[0]?.name ?? nodes[0]?.id ?? '').trim();
  return first ? [first] : [];
}

export function detectNodeProvider(node: RuntimeNode): IntegrationProvider | null {
  const type = String(node.type ?? '').toLowerCase();

  if (type.includes('shopify')) return 'shopify';
  if (type.includes('slack')) return 'slack';
  if (type.includes('airtable')) return 'airtable';
  if (type.includes('smtp') || type.includes('email') || type.includes('gmail')) return 'email';

  return null;
}

export function createSampleDataForWorkflow(workflowJson: unknown): Record<string, unknown> {
  const workflow = (workflowJson ?? {}) as RuntimeWorkflow;
  const nodes = workflow.nodes ?? [];
  const combinedText = nodes
    .map((node) => `${String(node.name ?? '')} ${String(node.type ?? '')}`.toLowerCase())
    .join(' ');

  if (combinedText.includes('shopify')) {
    return {
      order_id: '1001',
      customer_email: 'customer@example.com',
      total_price: '49.99',
      currency: 'USD',
      line_items: [
        { sku: 'SKU-001', title: 'Demo Product', quantity: 1, price: '49.99' },
      ],
    };
  }

  if (combinedText.includes('airbnb') || combinedText.includes('booking') || combinedText.includes('reservation')) {
    return {
      guest_name: 'Brahim Test',
      guest_email: 'guest@example.com',
      confirmation_code: 'ABC123',
      check_in_date: '2026-06-01',
      check_out_date: '2026-06-05',
      listing_name: 'MagicFlux Demo Apartment',
    };
  }

  return {
    name: 'Test User',
    email: 'test@example.com',
    message: 'This is a test event',
  };
}

export function executeNode(node: RuntimeNode, inputData: unknown, context: RuntimeContext): ExecuteNodeResult {
  const nodeName = String(node.name ?? node.id ?? 'Unnamed node');
  const nodeType = String(node.type ?? '').toLowerCase();
  const logs: string[] = [];

  if (nodeType.includes('webhook') || nodeType.includes('shopify') && nodeType.includes('trigger')) {
    logs.push('Trigger node executed using sample payload.');
    return {
      status: 'success',
      output: context.sampleData,
      logs,
    };
  }

  if (nodeType.includes('wait')) {
    logs.push('Wait skipped in test mode.');
    return {
      status: 'skipped',
      output: inputData,
      logs,
    };
  }

  if (nodeType.includes('code')) {
    const jsCode = extractParameterString(node, ['jsCode', 'code', 'functionCode']);

    if (!jsCode) {
      logs.push('No code provided. Input passed through.');
      return {
        status: 'success',
        output: inputData,
        logs,
      };
    }

    if (isLikelyUnsafeCode(jsCode) || jsCode.length > 2500) {
      logs.push('Unsafe or complex code detected. Transformation simulated in test mode.');
      return {
        status: 'success',
        output: shallowMerge(inputData, { simulated_transformation: true }),
        logs,
      };
    }

    try {
      const sandbox = {
        input: inputData,
        output: inputData,
      } as { input: unknown; output: unknown };

      const script = new vm.Script(
        `'use strict';\n(() => { ${jsCode}\n; return typeof output === 'undefined' ? input : output; })()`
      );
      const result = script.runInNewContext(sandbox, { timeout: 120 });

      logs.push('Code node executed safely in sandbox.');
      return {
        status: 'success',
        output: result,
        logs,
      };
    } catch (error) {
      return {
        status: 'failed',
        output: inputData,
        logs,
        error: error instanceof Error ? error.message : 'Code execution failed',
      };
    }
  }

  if (nodeType.includes('email')) {
    const to = extractParameterString(node, ['to', 'emailTo', 'recipient']) || String(asRecord(inputData).email ?? 'test@example.com');
    const subject = extractParameterString(node, ['subject']) || `Test Email from ${nodeName}`;
    const body = extractParameterString(node, ['text', 'message', 'html']) || 'Generated in MagicFlux test mode.';

    const preview = { nodeName, to, subject, body };
    context.previews.emails.push(preview);
    logs.push('Email send simulated. Preview generated.');

    return {
      status: 'success',
      output: shallowMerge(inputData, { email_preview: preview }),
      logs,
    };
  }

  if (nodeType.includes('slack')) {
    const channel = extractParameterString(node, ['channel']) || '#general';
    const text = extractParameterString(node, ['text', 'message']) || String(asRecord(inputData).message ?? 'MagicFlux test notification');

    const preview = { nodeName, channel, text };
    context.previews.slackMessages.push(preview);
    logs.push('Slack message simulated. Preview generated.');

    return {
      status: 'success',
      output: shallowMerge(inputData, { slack_preview: preview }),
      logs,
    };
  }

  if (nodeType.includes('airtable')) {
    const table = extractParameterString(node, ['table', 'tableName']) || 'Table 1';
    const record = {
      ...asRecord(inputData),
      source: 'MagicFlux test engine',
    };

    const preview = { nodeName, table, record };
    context.previews.airtableRecords.push(preview);
    logs.push('Airtable insert simulated. Preview generated.');

    return {
      status: 'success',
      output: shallowMerge(inputData, { airtable_preview: preview }),
      logs,
    };
  }

  logs.push(`Node type ${node.type ?? 'unknown'} is not explicitly supported. Passed through in simulation mode.`);
  return {
    status: 'success',
    output: inputData,
    logs,
  };
}

export function runWorkflowTest(
  workflowJson: unknown,
  sampleData: Record<string, unknown> | undefined,
  integrations: UserIntegration[]
) {
  const workflow = (workflowJson ?? {}) as RuntimeWorkflow;
  const nodes = workflow.nodes ?? [];
  const connections = workflow.connections ?? {};

  if (nodes.length === 0) {
    return {
      success: true,
      status: 'failed' as const,
      steps: [] as RuntimeStep[],
      finalOutput: null,
      previews: {
        emails: [],
        slackMessages: [],
        airtableRecords: [],
      },
      error: 'Workflow has no nodes',
    };
  }

  const previews: RuntimePreviews = {
    emails: [],
    slackMessages: [],
    airtableRecords: [],
  };

  const context: RuntimeContext = {
    sampleData: sampleData ?? createSampleDataForWorkflow(workflowJson),
    integrations,
    previews,
  };

  const nodeByName = new Map<string, RuntimeNode>();
  const edges = new Map<string, string[]>();

  for (const node of nodes) {
    const nodeName = String(node.name ?? node.id ?? '').trim();
    if (!nodeName) continue;
    nodeByName.set(nodeName, node);
    edges.set(nodeName, []);
  }

  for (const [source, value] of Object.entries(connections)) {
    const mains = value?.main ?? [];
    const targets: string[] = [];
    for (const outputChannel of mains) {
      for (const connection of outputChannel ?? []) {
        if (connection?.node) {
          targets.push(connection.node);
        }
      }
    }
    if (!edges.has(source)) edges.set(source, []);
    edges.get(source)?.push(...targets);
  }

  const queue: Array<{ name: string; input: unknown }> = findStartNodes(nodes, edges).map((name) => ({
    name,
    input: context.sampleData,
  }));

  const steps: RuntimeStep[] = [];
  let finalOutput: unknown = context.sampleData;
  let executions = 0;

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;

    const node = nodeByName.get(next.name);
    if (!node) continue;

    executions += 1;
    if (executions > MAX_NODE_EXECUTIONS) {
      steps.push({
        nodeName: next.name,
        nodeType: String(node.type ?? 'unknown'),
        status: 'failed',
        input: next.input,
        output: next.input,
        logs: ['Execution halted to avoid infinite loops.'],
        error: 'Execution limit reached',
      });

      return {
        success: true,
        status: 'failed' as const,
        steps,
        finalOutput,
        previews,
        error: 'Execution limit reached',
      };
    }

    const result = executeNode(node, next.input, context);
    const step: RuntimeStep = {
      nodeName: String(node.name ?? node.id ?? 'Unnamed node'),
      nodeType: String(node.type ?? 'unknown'),
      status: result.status,
      input: next.input,
      output: result.output,
      logs: result.logs,
      ...(result.error ? { error: result.error } : {}),
    };

    steps.push(step);
    finalOutput = result.output;

    if (result.status === 'failed') {
      return {
        success: true,
        status: 'failed' as const,
        steps,
        finalOutput,
        previews,
        error: result.error ?? `Node ${step.nodeName} failed`,
      };
    }

    const targets = edges.get(step.nodeName) ?? [];
    for (const target of targets) {
      queue.push({ name: target, input: result.output });
    }
  }

  return {
    success: true,
    status: 'success' as const,
    steps,
    finalOutput,
    previews,
  };
}

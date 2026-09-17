import { AI_CLASSIFIER_NODE_TYPE, isConditionalNodeType } from '@/lib/workflow-runtime/node-capabilities';

/**
 * Phase 9.9.16/9.9.16A -- Part I: the pure computation behind
 * components/workflows/BranchOverviewPanel.tsx, extracted so it can be
 * unit-tested directly (this codebase has no React component-rendering
 * test harness -- every other test here is at the lib/API level, so this
 * follows that same established pattern rather than introducing a new one).
 *
 * A read-only, best-effort structural summary of what each classification
 * branch actually does ("does Hot get Airtable/Gmail/Slack/SLA"), never a
 * validator -- activation's own guards remain the authority on correctness.
 */

const AIRTABLE_SUBSTRING = 'airtable';
const ACK_NODE_TYPES = ['magicflux-nodes.waitforacknowledgment', 'magicflux-nodes.createacknowledgmentchallenge'];

function isEmail(type: string): boolean {
  const t = type.toLowerCase();
  return t.includes('email') || t.includes('gmail');
}
function isSlack(type: string): boolean {
  return type.toLowerCase().includes('slack');
}
function isAirtable(type: string): boolean {
  return type.toLowerCase().includes(AIRTABLE_SUBSTRING);
}
function isSla(type: string): boolean {
  return ACK_NODE_TYPES.includes(type.toLowerCase());
}

type PortEntry = { node?: unknown };
export type Connections = Record<string, { main?: unknown }>;

function flattenPort(port: unknown): string[] {
  if (!Array.isArray(port)) return [];
  return port.map((e) => (e as PortEntry)?.node).filter((n): n is string => typeof n === 'string' && n.length > 0);
}

export type BranchSummaryEntry = { label: string; airtable: boolean; gmail: boolean; slack: boolean; sla: boolean };
export type BranchOverview = { branches: BranchSummaryEntry[]; labelsMatch: boolean } | null;

export function computeBranchOverview(nodes: Record<string, unknown>[], connections: Connections): BranchOverview {
  // Connections are keyed by NODE NAME, never id (the same convention
  // lib/agent/sla-acknowledgment-gating-guard.ts's own `n.name ?? n.id`
  // uses) -- this was the real bug a live browser check found: `byId` was
  // previously keyed `id ?? name`, so any node with both set (the normal
  // case) could never be found via a connections lookup, silently making
  // this panel appear to find nothing on every realistic workflow.
  const byId = new Map<string, Record<string, unknown>>();
  for (const n of nodes) byId.set(String(n.name ?? n.id ?? ''), n);

  const classifier = nodes.find((n) => String(n.type ?? '').toLowerCase() === AI_CLASSIFIER_NODE_TYPE.toLowerCase());
  if (!classifier) return null;
  const allowedLabels = Array.isArray((classifier.parameters as Record<string, unknown> | undefined)?.allowedLabels)
    ? ((classifier.parameters as Record<string, unknown>).allowedLabels as string[])
    : [];
  const classifierId = String(classifier.name ?? classifier.id ?? '');

  // Find the first genuinely branch-deciding node reachable downstream of
  // the classifier, using the SAME authoritative isConditionalNodeType()
  // every generation/activation guard already shares (an IF/switch node,
  // Human Review, or waitForAcknowledgment all qualify -- each is a real
  // branch point per node-capabilities.ts, not just a plain IF node).
  // Bounded BFS, shallow -- this is a summary aid, not a full graph solver.
  let conditionalNode: Record<string, unknown> | null = null;
  {
    const seen = new Set<string>([classifierId]);
    let frontier = flattenPort((connections[classifierId]?.main as unknown[] | undefined)?.[0]);
    let depth = 0;
    while (frontier.length > 0 && depth < 6 && !conditionalNode) {
      const next: string[] = [];
      for (const id of frontier) {
        if (seen.has(id)) continue;
        seen.add(id);
        const n = byId.get(id);
        if (!n) continue;
        if (isConditionalNodeType(String(n.type ?? ''))) { conditionalNode = n; break; }
        const outs = (connections[id]?.main as unknown[] | undefined) ?? [];
        for (const p of outs) next.push(...flattenPort(p));
      }
      frontier = next;
      depth++;
    }
  }
  if (!conditionalNode) return null;

  const condId = String(conditionalNode.name ?? conditionalNode.id ?? '');
  const ports = (connections[condId]?.main as unknown[] | undefined) ?? [];
  if (ports.length === 0) return null;
  const labelsMatch = allowedLabels.length === ports.length;

  const branches = ports.map((port, idx) => {
    const label = labelsMatch ? allowedLabels[idx] : `Branch ${idx + 1}`;
    const seen = new Set<string>();
    let frontier = flattenPort(port);
    let depth = 0;
    const found = { airtable: false, gmail: false, slack: false, sla: false };
    while (frontier.length > 0 && depth < 8) {
      const next: string[] = [];
      for (const id of frontier) {
        if (seen.has(id)) continue;
        seen.add(id);
        const n = byId.get(id);
        if (!n) continue;
        const t = String(n.type ?? '');
        if (isAirtable(t)) found.airtable = true;
        if (isEmail(t)) found.gmail = true;
        if (isSlack(t)) found.slack = true;
        if (isSla(t)) found.sla = true;
        const outs = (connections[id]?.main as unknown[] | undefined) ?? [];
        for (const p of outs) next.push(...flattenPort(p));
      }
      frontier = next;
      depth++;
    }
    return { label, ...found };
  });

  return { branches, labelsMatch };
}

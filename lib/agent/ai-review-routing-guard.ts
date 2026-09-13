/**
 * Phase 9.9.3.1 -- AI Classifier -> Human Review routing, product-truth guard.
 *
 * Root cause this exists to prevent (the exact Phase 9.9.4 acceptance
 * finding): a generated graph wired magicflux-nodes.aiClassifier directly to
 * BOTH a downstream action node and magicflux-nodes.humanReview, as if the
 * classifier itself could decide which port fires. It cannot --
 * aiClassifierHandler (lib/workflow-runtime/node-handlers/ai-classifier.ts)
 * never sets _conditionBranch, it only ever computes a `needs_review`
 * boolean field. lib/agent/branch-connection-guard.ts's inverse check
 * already rejects a MULTI-port wiring straight from the classifier, but a
 * single port wired directly to Human Review is structurally "valid"
 * (exactly one output port) while still being product-false: it would send
 * every input to human review, or never route low-confidence cases there at
 * all depending on which single target was chosen -- neither matches "route
 * low-confidence cases to review, keep confident ones flowing". The
 * required shape is always:
 *
 *   AI Classifier -> IF needs_review -> [true: Human Review] / [false: ...]
 *
 * This guard rejects generation whenever an aiClassifier node's own output
 * connects directly to a humanReview node (any port, any position), and
 * separately requires that when a workflow contains both node types, a real
 * conditional (isConditionalNodeType) node reading "needs_review" sits
 * between them.
 */

import {
  AI_CLASSIFIER_NODE_TYPE,
  HUMAN_REVIEW_NODE_TYPE,
  isConditionalNodeType,
} from '@/lib/workflow-runtime/node-capabilities';

export type AiReviewRoutingValidation = { ok: true } | { ok: false; reason: string; node?: string };

export const DIRECT_CLASSIFIER_TO_REVIEW_MESSAGE =
  'AI Classifier is a non-branching node -- it can never decide which downstream port fires -- but it is wired ' +
  'directly to Human Review. Low-confidence routing must go through a real IF node reading the classifier\'s ' +
  'own "needs_review" field (={{$json["needs_review"]}}), with Human Review reachable only on that IF\'s true branch.';

export const MISSING_NEEDS_REVIEW_GATE_MESSAGE =
  'This workflow contains both an AI Classifier and a Human Review node, but no real branch gate (an IF node ' +
  'reading "needs_review") sits between them. Human Review must be reached through an explicit confidence gate, ' +
  'not connected as if the classifier itself could route to it.';

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

type PortsShape = { main?: unknown };

function flattenTargets(main: unknown): string[] {
  if (!Array.isArray(main)) return [];
  const targets: string[] = [];
  for (const port of main) {
    if (!Array.isArray(port)) continue;
    for (const entry of port) {
      const target = (entry as { node?: unknown } | null | undefined)?.node;
      if (typeof target === 'string' && target.trim()) targets.push(target.trim());
    }
  }
  return targets;
}

/** References "needs_review" anywhere in a node's parameters -- narrow but deterministic (matches the exact field aiClassifierHandler writes). */
function readsNeedsReview(parameters: unknown): boolean {
  try {
    return JSON.stringify(parameters ?? {}).toLowerCase().includes('needs_review');
  } catch {
    return false;
  }
}

/**
 * Validates that no magicflux-nodes.aiClassifier node connects directly to a
 * magicflux-nodes.humanReview node, and that whenever both node types exist
 * in the same graph, a real needs_review-reading conditional node sits
 * between them. A graph with neither node type, or with an aiClassifier that
 * never reaches a humanReview node at all, always passes.
 */
export function validateAiReviewRoutingContract(nodes: unknown[], connections: unknown): AiReviewRoutingValidation {
  const nodeArray = Array.isArray(nodes) ? nodes : [];
  const connRecord = connections && typeof connections === 'object' && !Array.isArray(connections)
    ? (connections as Record<string, PortsShape>)
    : {};

  type NodeInfo = { name: string; type: string; parameters: unknown };
  const infos: NodeInfo[] = [];
  for (const raw of nodeArray) {
    if (!raw || typeof raw !== 'object') continue;
    const n = raw as Record<string, unknown>;
    const name = String(n.name ?? n.id ?? '').trim();
    if (!name) continue;
    infos.push({ name, type: String(n.type ?? ''), parameters: n.parameters });
  }

  const byName = new Map(infos.map((n) => [n.name, n]));
  const classifiers = infos.filter((n) => n.type.toLowerCase() === AI_CLASSIFIER_NODE_TYPE.toLowerCase());
  const reviewNodes = infos.filter((n) => n.type.toLowerCase() === HUMAN_REVIEW_NODE_TYPE.toLowerCase());

  if (classifiers.length === 0 || reviewNodes.length === 0) return { ok: true };
  const reviewNames = new Set(reviewNodes.map((n) => n.name));

  for (const classifier of classifiers) {
    const directTargets = flattenTargets(connRecord[classifier.name]?.main);

    // 1. Never a direct edge from the classifier straight to Human Review,
    // regardless of how many ports/targets the classifier has (the
    // multi-port case is also caught structurally by
    // branch-connection-guard.ts's inverse check -- this catches the
    // single-port case too, which is structurally "valid" but still wrong).
    if (directTargets.some((t) => reviewNames.has(t))) {
      return { ok: false, node: classifier.name, reason: DIRECT_CLASSIFIER_TO_REVIEW_MESSAGE };
    }

    // 2. If this classifier reaches a Human Review node at all (even
    // indirectly), a real conditional node reading needs_review must be the
    // immediate next hop -- Human Review cannot simply be "somewhere
    // downstream" of an ungated classifier.
    const reachesReview = (() => {
      const seen = new Set<string>();
      const stack = [...directTargets];
      while (stack.length > 0) {
        const cur = stack.pop()!;
        if (seen.has(cur)) continue;
        seen.add(cur);
        if (reviewNames.has(cur)) return true;
        stack.push(...flattenTargets(connRecord[cur]?.main));
      }
      return false;
    })();

    if (!reachesReview) continue;

    const hasGate = directTargets.some((t) => {
      const targetNode = byName.get(t);
      return targetNode ? isConditionalNodeType(targetNode.type) && readsNeedsReview(targetNode.parameters) : false;
    });

    if (!hasGate) {
      return { ok: false, node: classifier.name, reason: MISSING_NEEDS_REVIEW_GATE_MESSAGE };
    }
  }

  return { ok: true };
}

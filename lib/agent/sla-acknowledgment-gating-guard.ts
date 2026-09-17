/**
 * Phase 9.9.13 -- Part J: SLA acknowledgment gating guard.
 *
 * Product-truth problem this guards against: a generated graph where an
 * upstream magicflux-nodes.aiClassifier can produce MULTIPLE labels (e.g.
 * "Hot"/"Warm"/"Cold"), but a magicflux-nodes.createAcknowledgmentChallenge
 * or magicflux-nodes.waitForAcknowledgment node downstream is reachable
 * UNCONDITIONALLY -- i.e. via at least one path that never passes through
 * any conditional node checking the classifier's own output field. That
 * shape would create a durable SLA acknowledgment row (and, once wired,
 * escalation side effects) for EVERY classification outcome, not just the
 * one(s) the request actually asked to guarantee ownership for -- e.g. a
 * "Warm" or "Cold" lead silently getting the same SLA treatment as "Hot".
 *
 * Mirrors human-review-routing-guard.ts's own backward-predecessor-trace
 * style (same helpers: isConditionalNodeType, referencesJsonField) and, like
 * that guard, is deliberately narrow: it proves "this SLA node is reachable
 * ONLY through at least one gate checking the classifier's field", not
 * "...through a gate checking specifically the label X" -- verifying the
 * exact label a condition compares against would require parsing n8n IF-node
 * operand semantics generically, which no existing guard in this codebase
 * attempts either. This still catches the concrete failure mode described
 * above: an SLA node wired unconditionally, with no gate at all.
 *
 * A graph with no createAcknowledgmentChallenge/waitForAcknowledgment node,
 * or one with no upstream multi-label aiClassifier at all, always passes --
 * this never forces gating onto a workflow that doesn't have a classifier
 * whose output could vary.
 */

import {
  AI_CLASSIFIER_NODE_TYPE,
  CREATE_ACKNOWLEDGMENT_CHALLENGE_NODE_TYPE,
  WAIT_FOR_ACKNOWLEDGMENT_NODE_TYPE,
  isConditionalNodeType,
} from '@/lib/workflow-runtime/node-capabilities';
import { referencesJsonField } from '@/lib/workflow-runtime/node-handlers/json-field-reference';

export type SlaAcknowledgmentGatingValidation = { ok: true } | { ok: false; reason: string; node: string };

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
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

export function validateSlaAcknowledgmentGating(nodes: unknown[], connections: unknown): SlaAcknowledgmentGatingValidation {
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

  const forwardTargets = new Map<string, string[]>();
  const predecessors = new Map<string, string[]>();
  for (const [source, ports] of Object.entries(connRecord)) {
    const targets = flattenTargets(ports?.main);
    forwardTargets.set(source, targets);
    for (const target of targets) {
      const list = predecessors.get(target) ?? [];
      list.push(source);
      predecessors.set(target, list);
    }
  }

  const slaNodes = infos.filter(
    (n) =>
      n.type.toLowerCase() === CREATE_ACKNOWLEDGMENT_CHALLENGE_NODE_TYPE.toLowerCase() ||
      n.type.toLowerCase() === WAIT_FOR_ACKNOWLEDGMENT_NODE_TYPE.toLowerCase()
  );
  if (slaNodes.length === 0) return { ok: true };

  for (const slaNode of slaNodes) {
    // Backward trace: nearest upstream aiClassifier feeding this SLA node.
    let classifierName: string | null = null;
    let classifierOutputField: string | null = null;
    let classifierLabels: string[] = [];
    const seenBack = new Set<string>();
    const backStack = [...(predecessors.get(slaNode.name) ?? [])];
    while (backStack.length > 0 && !classifierName) {
      const cur = backStack.pop()!;
      if (seenBack.has(cur)) continue;
      seenBack.add(cur);
      const curNode = byName.get(cur);
      if (curNode && curNode.type.toLowerCase() === AI_CLASSIFIER_NODE_TYPE.toLowerCase()) {
        const curParams = asRecord(curNode.parameters);
        classifierName = cur;
        const rawOutputField = curParams.outputField;
        classifierOutputField = typeof rawOutputField === 'string' && rawOutputField.trim() ? rawOutputField.trim() : 'classification';
        classifierLabels = stringArray(curParams.allowedLabels);
        break;
      }
      backStack.push(...(predecessors.get(cur) ?? []));
    }

    // No upstream classifier, or the classifier can only ever produce one
    // label anyway (nothing to gate against) -- always safe.
    if (!classifierName || !classifierOutputField || classifierLabels.length <= 1) continue;

    // Forward reachability WITHOUT ever passing a qualifying gate: explore
    // from the classifier, but never continue past a conditional node that
    // references the classifier's own output field (crossing one such node
    // makes that path "gated" from then on, so it does not count towards an
    // ungated route). If the SLA node is still reachable this way, at least
    // one fully-ungated path exists.
    const ungatedReachable = new Set<string>();
    const fwdStack = [classifierName];
    while (fwdStack.length > 0) {
      const cur = fwdStack.pop()!;
      if (ungatedReachable.has(cur)) continue;
      ungatedReachable.add(cur);
      const curNode = byName.get(cur);
      const isGate = cur !== classifierName && curNode && isConditionalNodeType(curNode.type) && referencesJsonField(curNode.parameters, classifierOutputField);
      if (isGate) continue; // do not propagate "ungated" status past a real gate
      for (const next of forwardTargets.get(cur) ?? []) fwdStack.push(next);
    }

    if (ungatedReachable.has(slaNode.name)) {
      return {
        ok: false,
        node: slaNode.name,
        reason:
          `"${slaNode.name}" is reachable from AI Classifier "${classifierName}" (labels: ${classifierLabels.join('/')}) ` +
          `WITHOUT passing through any conditional node that checks "${classifierOutputField}" first -- it would create a durable ` +
          'SLA acknowledgment row for every classification outcome, not just the one(s) the request asked to guarantee ownership ' +
          `for. Gate "${slaNode.name}" behind an "If ${classifierOutputField} == <label>"-style node on only the branch(es) that ` +
          'genuinely need an SLA acknowledgment.',
      };
    }
  }

  return { ok: true };
}

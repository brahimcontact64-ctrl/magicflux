/**
 * Phase 9.9.9 -- Part G: notification product-truth guard.
 *
 * A generated Email/Slack notification must be built ONLY from an
 * allowlisted set of real business fields -- never the workflow's internal
 * routing/execution bookkeeping (`_conditionBranch`, `_conditionResult`),
 * never a credential/secret/token-shaped field, and never a raw dump of the
 * whole `$json` object (already impossible via the supported template
 * grammar -- see json-field-reference.ts -- since a bare `$json` with no
 * `["field"]`/`.field` accessor is rejected by template-expression-guard.ts
 * as unsupported syntax; this guard closes the remaining gap of a message
 * that references a SPECIFIC field which is itself internal/sensitive by
 * name).
 *
 * Deterministic, fail-closed, and generic: the denylist is a name-pattern
 * test, never a workflow-specific field list, so it applies identically to
 * any generated workflow's Email/Slack nodes -- nothing here is lead- or
 * Sigma-Plus-specific.
 */

import { extractReferencedFields } from '@/lib/workflow-runtime/node-handlers/json-field-reference';
import { isDenylistedFieldName } from '@/lib/security/field-denylist';

export type NotificationContentValidation = { ok: true } | { ok: false; reason: string; node: string };

const MESSAGE_PARAM_KEYS = ['subject', 'text', 'html', 'message', 'body'];

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

const NOTIFICATION_NODE_TYPES = new Set([
  'n8n-nodes-base.gmail',
  'n8n-nodes-base.email',
  'n8n-nodes-base.slack',
]);

/**
 * Rejects any Email/Slack node whose message-style parameters reference an
 * internal-metadata or credential/secret-shaped field name. A node with no
 * such parameters, a non-notification node type, or only business-field
 * references always passes.
 */
export function validateNotificationFieldAllowlist(nodes: unknown[]): NotificationContentValidation {
  for (const raw of Array.isArray(nodes) ? nodes : []) {
    if (!raw || typeof raw !== 'object') continue;
    const node = raw as Record<string, unknown>;
    const type = String(node.type ?? '').toLowerCase();
    if (!NOTIFICATION_NODE_TYPES.has(type)) continue;

    const name = String(node.name ?? node.id ?? '').trim();
    const params = asRecord(node.parameters);

    for (const key of MESSAGE_PARAM_KEYS) {
      const val = params[key];
      if (typeof val !== 'string') continue;

      for (const field of extractReferencedFields(val)) {
        if (isDenylistedFieldName(field)) {
          return {
            ok: false,
            node: name,
            reason:
              `Node "${name}" parameter "${key}" references "${field}", which is an internal/execution-metadata ` +
              'or credential-shaped field name and must never appear in a notification sent to a human recipient. ' +
              'Use only real business fields from the workflow\'s input data.',
          };
        }
      }
    }
  }

  return { ok: true };
}

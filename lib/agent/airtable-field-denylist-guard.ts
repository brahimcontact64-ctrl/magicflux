/**
 * Phase 9.9.13A Part B -- Airtable field-mapping denylist guard.
 *
 * Root cause this closes: notification-content-guard.ts already rejects a
 * generated Gmail/Slack node that references an internal/execution-metadata
 * or credential-shaped field name (`_conditionBranch`, `_conditionResult`,
 * anything token/secret/credential-shaped -- see lib/security/field-denylist.ts),
 * but NOTHING equivalent existed for an Airtable "fields" mapping VALUE --
 * a generated Airtable node could reference `={{$json["_qualificationDecisionId"]}}`
 * (or any other denylisted name) and nothing would catch it before save.
 * This is the exact same check, generalized to whichever internal field a
 * future capability introduces, not hardcoded to any one field name -- the
 * denylist itself (lib/security/field-denylist.ts) is the single source of
 * truth both guards share.
 *
 * A workflow with no Airtable node, or one whose "fields" mapping only
 * references real business fields, always passes.
 */

import { isDenylistedFieldName } from '@/lib/security/field-denylist';
import { extractReferencedFields } from '@/lib/workflow-runtime/node-handlers/json-field-reference';

export type AirtableFieldDenylistValidation = { ok: true } | { ok: false; reason: string; node: string };

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function isAirtableWriteNode(type: string): boolean {
  return type.toLowerCase().includes('airtable');
}

export function validateAirtableFieldDenylist(nodes: unknown[]): AirtableFieldDenylistValidation {
  for (const raw of Array.isArray(nodes) ? nodes : []) {
    if (!raw || typeof raw !== 'object') continue;
    const node = raw as Record<string, unknown>;
    if (!isAirtableWriteNode(String(node.type ?? ''))) continue;

    const name = String(node.name ?? node.id ?? '').trim();
    const params = asRecord(node.parameters);
    const fields = asRecord(params.fields);

    for (const [destKey, rawValue] of Object.entries(fields)) {
      if (typeof rawValue !== 'string') continue;
      for (const field of extractReferencedFields(rawValue)) {
        if (isDenylistedFieldName(field)) {
          return {
            ok: false,
            node: name,
            reason:
              `Airtable node "${name}" field "${destKey}" references "${field}", which is an internal/execution-metadata ` +
              'or credential-shaped field name and must never be written into a business record. ' +
              'Use only real business fields from the workflow\'s input data.',
          };
        }
      }
    }
  }

  return { ok: true };
}

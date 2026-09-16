/**
 * Phase 9.9.8 -- pure status computation for one Airtable action node's
 * Builder configuration card. Extracted out of the React component
 * (components/builder/airtable-node-config-panel.tsx) so the four states
 * the product spec requires (Unconfigured / Configured / Schema changed /
 * Credential missing) are testable without rendering anything, and so the
 * exact same rule can never drift between wherever it's called from.
 */
export type AirtableNodeConfigStatus = 'unconfigured' | 'configured' | 'schema_changed' | 'credential_missing';

export function computeAirtableNodeStatus(params: {
  airtableConnected: boolean;
  baseId: string;
  tableId: string;
  fieldKeys: string[];
  /**
   * Real field names Airtable's live schema currently has for this table,
   * or null when that check could not be completed (network/API error).
   * A failed check is never silently treated as "still fine" -- it fails
   * toward "needs attention", the same way the pre-activation gate
   * (lib/workflow/lifecycle.ts) already fails closed when it can't verify.
   */
  liveFieldNames: string[] | null;
}): AirtableNodeConfigStatus {
  if (!params.airtableConnected) return 'credential_missing';
  if (!params.baseId || !params.tableId) return 'unconfigured';
  if (params.liveFieldNames === null) return 'schema_changed';

  const live = new Set(params.liveFieldNames);
  const stillValid = params.fieldKeys.length > 0 && params.fieldKeys.every((key) => live.has(key));
  return stillValid ? 'configured' : 'schema_changed';
}

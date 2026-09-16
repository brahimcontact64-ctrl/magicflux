import type { EngineNode, NodeHandlerContext, NodeHandlerResult } from '../types';
import { redactText } from '@/lib/security/redact';
import { extractAirtableNodeConfig } from '@/lib/airtable/node-params';
import { resolveFieldMapping } from './json-field-reference';
import { fetchWithOutcome, indeterminateFailure } from './provider-outcome';
import { parseAirtableDedupePolicy, buildIdentityFilterFormula } from './airtable-dedupe';

function getParam(node: EngineNode, keys: string[]): string {
  const params = node.parameters ?? {};
  for (const key of keys) {
    const val = params[key];
    if (typeof val === 'string' && val.trim()) return val;
  }
  return '';
}

function asRecord(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

type AirtableOperation = 'list' | 'get' | 'create' | 'update' | 'delete';

function getOperation(node: EngineNode): AirtableOperation {
  const op = getParam(node, ['operation']).toLowerCase();
  if (op === 'list' || op === 'get' || op === 'create' || op === 'update' || op === 'delete') return op;
  return 'create';
}

export async function airtableHandler(
  node: EngineNode,
  inputData: unknown,
  context: NodeHandlerContext
): Promise<NodeHandlerResult> {
  const logs: string[] = [];
  const data = asRecord(inputData);
  const operation = getOperation(node);

  // Phase 9.9.3 -- canonical parameters are baseId/tableId (what
  // generation now emits and what the Builder's Airtable configuration
  // step verifies and writes), read via the one shared helper
  // (lib/airtable/node-params.ts) so this handler and the pre-activation
  // gate can never disagree about which alias keys count.
  // 'base'/'table'/'tableName' and 'application'/'applicationId' are
  // READ-ONLY aliases kept for backward compatibility with
  // already-persisted workflows generated before this phase (which
  // emitted the dead, never-canonical 'application'/'applicationId' keys
  // this handler never used to read at all) -- generation no longer
  // produces any of these going forward.
  const nodeConfig = extractAirtableNodeConfig(node);
  const table = nodeConfig.tableId || String(data.table_name ?? 'Table 1');
  const baseId = nodeConfig.baseId || String(data.base_id ?? '');
  const recordId = getParam(node, ['recordId']) || String(data.record_id ?? data.airtable_id ?? '');

  // Phase 9.9.4A -- the record written to Airtable comes STRICTLY from the
  // node's own configured "fields" mapping (destination Airtable column ->
  // literal value or ={{$json["..."]}}/embedded {{$json["..."]}} reference),
  // never from the raw upstream execution data. Only create/update actually
  // write anything, so only they resolve a mapping; a mapped reference that
  // can't be resolved fails the node closed rather than silently omitting
  // the field or sending an unmapped, unrelated one.
  let record: Record<string, unknown> = {};
  if (operation === 'create' || operation === 'update') {
    const fieldsParam = asRecord(node.parameters).fields;
    const mappingResult = resolveFieldMapping(asRecord(fieldsParam), data);
    if (!mappingResult.ok) {
      const error = `Airtable ${operation}: ${mappingResult.reason}`;
      logs.push(error);
      return { status: 'failed', outputData: null, logs, error };
    }
    record = mappingResult.record;
  }

  const preview = { nodeName: node.name ?? node.id, operation, table, recordId: recordId || undefined, record };

  if (context.mode === 'test') {
    context.previews?.airtableRecords.push(preview);
    logs.push(`Airtable ${operation} simulated in test mode — preview generated.`);
    return { status: 'simulated_success', outputData: { ...data, airtable_preview: preview }, logs };
  }

  const airtableIntegration = context.integrations.find((i) => i.provider === 'airtable');
  if (!airtableIntegration?.credentials) {
    logs.push('Airtable integration not configured.');
    return { status: 'failed', outputData: null, logs, error: 'Airtable integration not configured' };
  }

  const creds = airtableIntegration.credentials as Record<string, unknown>;
  // personal_access_token is the field name used by lib/credentials/provider-registry.ts.
  // airtable_token/api_key are kept as fallbacks for integrations connected before that rename.
  const apiKey = (creds.personal_access_token ?? creds.airtable_token ?? creds.api_key) as string | undefined;
  const integrationBaseId = creds.base_id as string | undefined;
  const integrationTableName = creds.table_name as string | undefined;
  const finalBaseId = baseId || integrationBaseId;
  const finalTable = table || integrationTableName || 'Table 1';

  if (!apiKey || !finalBaseId || !finalTable) {
    logs.push('Airtable token/base/table missing.');
    return { status: 'failed', outputData: null, logs, error: 'Airtable credentials incomplete' };
  }

  if ((operation === 'get' || operation === 'update' || operation === 'delete') && !recordId) {
    logs.push(`Airtable ${operation} requires a record ID.`);
    return { status: 'failed', outputData: null, logs, error: 'Airtable record ID missing' };
  }

  const baseUrl = `https://api.airtable.com/v0/${encodeURIComponent(finalBaseId)}/${encodeURIComponent(finalTable)}`;
  const authHeaders = { Authorization: `Bearer ${apiKey}` };

  // Phase 9.9.11 -- Part E/H: Airtable's API has no caller-supplied
  // idempotency mechanism for any of these operations. A response actually
  // received from Airtable (any status) means Airtable explicitly accepted
  // or rejected the request -- trustworthy, safe to retry on a real
  // rejection. A thrown fetch() error (timeout/connection reset/DNS
  // failure) means the request may already have been processed before the
  // response was lost -- classified indeterminate and never auto-retried,
  // so a create's timeout can never silently become two rows.
  try {
    switch (operation) {
      case 'list': {
        const url = new URL(baseUrl);
        const filterFormula = getParam(node, ['filterFormula']);
        if (filterFormula) url.searchParams.set('filterByFormula', filterFormula);
        const fieldsParam = getParam(node, ['fields']);
        if (fieldsParam) {
          for (const f of fieldsParam.split(',').map((s) => s.trim()).filter(Boolean)) {
            url.searchParams.append('fields[]', f);
          }
        }

        const attempt = await fetchWithOutcome(url.toString(), { headers: authHeaders });
        if (attempt.kind === 'indeterminate') {
          logs.push(`Airtable list: ${attempt.message}`);
          return { status: 'failed', outputData: null, logs, ...indeterminateFailure('Airtable list', attempt.message) };
        }
        const res = attempt.response;
        if (!res.ok) throw new Error(`Airtable returned ${res.status}: ${redactText((await res.text().catch(() => '')).slice(0, 200))}`);
        const body = await res.json() as { records?: unknown[] };
        logs.push(`Airtable listed ${body.records?.length ?? 0} record(s).`);
        return { status: 'success', outputData: { ...data, airtable_records: body.records ?? [] }, logs };
      }

      case 'get': {
        const attempt = await fetchWithOutcome(`${baseUrl}/${encodeURIComponent(recordId)}`, { headers: authHeaders });
        if (attempt.kind === 'indeterminate') {
          logs.push(`Airtable get: ${attempt.message}`);
          return { status: 'failed', outputData: null, logs, ...indeterminateFailure('Airtable get', attempt.message) };
        }
        const res = attempt.response;
        if (!res.ok) throw new Error(`Airtable returned ${res.status}: ${redactText((await res.text().catch(() => '')).slice(0, 200))}`);
        const record = await res.json() as Record<string, unknown>;
        logs.push(`Airtable record fetched: ${recordId}.`);
        return { status: 'success', outputData: { ...data, airtable_record: record }, logs };
      }

      case 'update': {
        const attempt = await fetchWithOutcome(`${baseUrl}/${encodeURIComponent(recordId)}`, {
          method: 'PATCH',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: record }),
        });
        if (attempt.kind === 'indeterminate') {
          logs.push(`Airtable update: ${attempt.message}`);
          return { status: 'failed', outputData: null, logs, ...indeterminateFailure('Airtable update', attempt.message) };
        }
        const res = attempt.response;
        if (!res.ok) throw new Error(`Airtable returned ${res.status}: ${redactText((await res.text().catch(() => '')).slice(0, 200))}`);
        const updated = await res.json() as Record<string, unknown>;
        logs.push(`Airtable record updated: ${recordId}.`);
        return { status: 'success', outputData: { ...data, airtable_id: updated.id }, logs };
      }

      case 'delete': {
        const attempt = await fetchWithOutcome(`${baseUrl}/${encodeURIComponent(recordId)}`, {
          method: 'DELETE',
          headers: authHeaders,
        });
        if (attempt.kind === 'indeterminate') {
          logs.push(`Airtable delete: ${attempt.message}`);
          return { status: 'failed', outputData: null, logs, ...indeterminateFailure('Airtable delete', attempt.message) };
        }
        const res = attempt.response;
        if (!res.ok) throw new Error(`Airtable returned ${res.status}: ${redactText((await res.text().catch(() => '')).slice(0, 200))}`);
        logs.push(`Airtable record deleted: ${recordId}.`);
        return { status: 'success', outputData: { ...data, airtable_deleted_id: recordId }, logs };
      }

      case 'create':
      default: {
        // Phase 9.9.11 -- Part F: OPTIONAL, additive business (CRM)
        // deduplication -- entirely separate from the technical/transport
        // idempotency above. A node with no "dedupe" parameter configured
        // (every existing, already-certified workflow) always creates,
        // exactly as before (Part K -- no silent behavior change).
        const dedupePolicy = parseAirtableDedupePolicy(asRecord(node.parameters).dedupe);
        let matchedRecordId: string | null = null;

        if (dedupePolicy) {
          const formula = buildIdentityFilterFormula(dedupePolicy, record);
          if (formula) {
            const searchUrl = new URL(baseUrl);
            searchUrl.searchParams.set('filterByFormula', formula);
            searchUrl.searchParams.set('maxRecords', '1');
            const searchAttempt = await fetchWithOutcome(searchUrl.toString(), { headers: authHeaders });
            if (searchAttempt.kind === 'indeterminate') {
              // Cannot safely proceed without knowing whether a duplicate
              // lead/contact already exists -- fail closed rather than
              // risk creating a business-duplicate record.
              logs.push(`Airtable dedupe lookup: ${searchAttempt.message}`);
              return { status: 'failed', outputData: null, logs, ...indeterminateFailure('Airtable dedupe lookup', searchAttempt.message) };
            }
            const searchRes = searchAttempt.response;
            if (!searchRes.ok) throw new Error(`Airtable dedupe lookup returned ${searchRes.status}: ${redactText((await searchRes.text().catch(() => '')).slice(0, 200))}`);
            const searchBody = await searchRes.json() as { records?: Array<{ id: string }> };
            matchedRecordId = searchBody.records?.[0]?.id ?? null;
            if (matchedRecordId) {
              logs.push(`Airtable dedupe: found an existing record (${matchedRecordId}) matching this lead's identity -- applying onMatch:"${dedupePolicy.onMatch}".`);
            }
          }
        }

        if (matchedRecordId && dedupePolicy?.onMatch === 'update') {
          const updateAttempt = await fetchWithOutcome(`${baseUrl}/${encodeURIComponent(matchedRecordId)}`, {
            method: 'PATCH',
            headers: { ...authHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: record }),
          });
          if (updateAttempt.kind === 'indeterminate') {
            logs.push(`Airtable dedupe update: ${updateAttempt.message}`);
            return { status: 'failed', outputData: null, logs, ...indeterminateFailure('Airtable dedupe update', updateAttempt.message) };
          }
          const updateRes = updateAttempt.response;
          if (!updateRes.ok) throw new Error(`Airtable returned ${updateRes.status}: ${redactText((await updateRes.text().catch(() => '')).slice(0, 200))}`);
          const updated = await updateRes.json() as Record<string, unknown>;
          logs.push(`Airtable record updated (business dedupe match): ${matchedRecordId}.`);
          return { status: 'success', outputData: { ...data, airtable_id: updated.id, airtable_dedupe_matched: true, airtable_dedupe_action: 'update' }, logs };
        }

        // No match, or onMatch is 'create'/'append' -- 'append' is
        // intentionally NOT yet a distinct linked-record behavior (that
        // requires knowing the base's own link-field schema, which this
        // handler has no way to discover safely) -- it creates a new
        // interaction record exactly like 'create' rather than guessing at
        // a schema that might not exist, and is logged as such so this is
        // never silently mistaken for a real linked-append.
        if (matchedRecordId && dedupePolicy?.onMatch === 'append') {
          logs.push(`Airtable dedupe: onMatch:"append" is not yet a distinct linked-record behavior -- creating a new interaction record instead of guessing at unknown link-field schema.`);
        }

        // The one operation a duplicate blind retry is most damaging for --
        // a real, extra lead row in the founder's CRM. See the module-level
        // comment above for the classification this depends on.
        const attempt = await fetchWithOutcome(baseUrl, {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: record }),
        });
        if (attempt.kind === 'indeterminate') {
          logs.push(`Airtable create: ${attempt.message}`);
          return { status: 'failed', outputData: null, logs, ...indeterminateFailure('Airtable create', attempt.message) };
        }
        const res = attempt.response;
        if (!res.ok) throw new Error(`Airtable returned ${res.status}: ${redactText((await res.text().catch(() => '')).slice(0, 200))}`);
        const created = await res.json() as Record<string, unknown>;
        logs.push(`Airtable record created: ${String(created.id ?? 'unknown')}.`);
        return {
          status: 'success',
          outputData: {
            ...data,
            airtable_id: created.id,
            ...(dedupePolicy ? { airtable_dedupe_matched: false, airtable_dedupe_action: 'create' } : {}),
          },
          logs,
        };
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logs.push(`Airtable ${operation} failed: ${msg}`);
    return { status: 'failed', outputData: null, logs, error: msg };
  }
}

import type { EngineNode, NodeHandlerContext, NodeHandlerResult } from '../types';

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

  const table = getParam(node, ['tableId', 'table', 'tableName']) || String(data.table_name ?? 'Table 1');
  const baseId = getParam(node, ['baseId', 'base']) || String(data.base_id ?? '');
  const recordId = getParam(node, ['recordId']) || String(data.record_id ?? data.airtable_id ?? '');
  const record = { ...data, _source: 'magicflux' };

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

        const res = await fetch(url, { headers: authHeaders });
        if (!res.ok) throw new Error(`Airtable returned ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
        const body = await res.json() as { records?: unknown[] };
        logs.push(`Airtable listed ${body.records?.length ?? 0} record(s).`);
        return { status: 'success', outputData: { ...data, airtable_records: body.records ?? [] }, logs };
      }

      case 'get': {
        const res = await fetch(`${baseUrl}/${encodeURIComponent(recordId)}`, { headers: authHeaders });
        if (!res.ok) throw new Error(`Airtable returned ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
        const record = await res.json() as Record<string, unknown>;
        logs.push(`Airtable record fetched: ${recordId}.`);
        return { status: 'success', outputData: { ...data, airtable_record: record }, logs };
      }

      case 'update': {
        const res = await fetch(`${baseUrl}/${encodeURIComponent(recordId)}`, {
          method: 'PATCH',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: record }),
        });
        if (!res.ok) throw new Error(`Airtable returned ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
        const updated = await res.json() as Record<string, unknown>;
        logs.push(`Airtable record updated: ${recordId}.`);
        return { status: 'success', outputData: { ...data, airtable_id: updated.id }, logs };
      }

      case 'delete': {
        const res = await fetch(`${baseUrl}/${encodeURIComponent(recordId)}`, {
          method: 'DELETE',
          headers: authHeaders,
        });
        if (!res.ok) throw new Error(`Airtable returned ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
        logs.push(`Airtable record deleted: ${recordId}.`);
        return { status: 'success', outputData: { ...data, airtable_deleted_id: recordId }, logs };
      }

      case 'create':
      default: {
        const res = await fetch(baseUrl, {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: record }),
        });
        if (!res.ok) throw new Error(`Airtable returned ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
        const created = await res.json() as Record<string, unknown>;
        logs.push(`Airtable record created: ${String(created.id ?? 'unknown')}.`);
        return { status: 'success', outputData: { ...data, airtable_id: created.id }, logs };
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logs.push(`Airtable ${operation} failed: ${msg}`);
    return { status: 'failed', outputData: null, logs, error: msg };
  }
}

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

export async function airtableHandler(
  node: EngineNode,
  inputData: unknown,
  context: NodeHandlerContext
): Promise<NodeHandlerResult> {
  const logs: string[] = [];
  const data = asRecord(inputData);

  const table = getParam(node, ['table', 'tableName']) || String(data.table_name ?? 'Table 1');
  const baseId = getParam(node, ['baseId', 'base']) || String(data.base_id ?? '');
  const record = { ...data, _source: 'magicflux' };

  const preview = { nodeName: node.name ?? node.id, table, record };

  if (context.mode === 'test') {
    context.previews?.airtableRecords.push(preview);
    logs.push('Airtable insert simulated in test mode — preview generated.');
    return { status: 'simulated_success', outputData: { ...data, airtable_preview: preview }, logs };
  }

  const airtableIntegration = context.integrations.find((i) => i.provider === 'airtable');
  if (!airtableIntegration?.credentials) {
    logs.push('Airtable integration not configured.');
    return { status: 'failed', outputData: null, logs, error: 'Airtable integration not configured' };
  }

  const apiKey = (airtableIntegration.credentials as Record<string, unknown>).airtable_token as string | undefined;
  const integrationBaseId = (airtableIntegration.credentials as Record<string, unknown>).base_id as string | undefined;
  const integrationTableName = (airtableIntegration.credentials as Record<string, unknown>).table_name as string | undefined;
  const finalBaseId = baseId || integrationBaseId;
  const finalTable = table || integrationTableName || 'Table 1';

  if (!apiKey || !finalBaseId || !finalTable) {
    logs.push('Airtable token/base/table missing.');
    return { status: 'failed', outputData: null, logs, error: 'Airtable credentials incomplete' };
  }

  try {
    const url = `https://api.airtable.com/v0/${encodeURIComponent(finalBaseId)}/${encodeURIComponent(finalTable)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields: record }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Airtable returned ${res.status}: ${errBody.slice(0, 200)}`);
    }

    const created = await res.json() as Record<string, unknown>;
    logs.push(`Airtable record created: ${String(created.id ?? 'unknown')}`);
    return { status: 'success', outputData: { ...data, airtable_id: created.id }, logs };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logs.push(`Airtable insert failed: ${msg}`);
    return { status: 'failed', outputData: null, logs, error: msg };
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest, createServiceClient } from '@/lib/supabase-server';
import { getDecryptedProviderCredentials } from '@/lib/credentials/storage';
import { validateAirtableMapping } from '@/lib/airtable/schema';
import { loadWorkflow } from '@/lib/workflow/lifecycle';
import { classifyError } from '@/lib/security/safe-error';

type Ctx = { params: { id: string } };

type AirtableConfigBody = {
  nodeId?: unknown;
  baseId?: unknown;
  tableId?: unknown;
  /** Maps the node's EXISTING semantic field key -> the real Airtable field name/id chosen for it. */
  fieldMapping?: unknown;
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * PATCH /api/workflows/[id]/airtable-config
 * Body: { nodeId, baseId, tableId, fieldMapping: { [existingFieldKey]: realFieldName } }
 *
 * The Builder-side "configure a real Airtable base/table/field mapping"
 * step (Phase 9.9.3): re-verifies the proposed mapping against Airtable's
 * REAL live schema server-side (never trusts client-supplied claims, even
 * though the browser already fetched this from our own discovery routes --
 * a stale/tampered request must not be able to persist an unverified
 * mapping) before ever writing it into the workflow's persisted JSON.
 * Only a workflow this exact user owns can be touched.
 */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({})) as AirtableConfigBody;
  const nodeId = typeof body.nodeId === 'string' ? body.nodeId.trim() : '';
  const baseId = typeof body.baseId === 'string' ? body.baseId.trim() : '';
  const tableId = typeof body.tableId === 'string' ? body.tableId.trim() : '';
  const fieldMapping = asRecord(body.fieldMapping);

  if (!nodeId || !baseId || !tableId) {
    return NextResponse.json({ error: 'nodeId, baseId, and tableId are all required' }, { status: 400 });
  }

  const workflow = await loadWorkflow(user.id, params.id);
  if (!workflow) return NextResponse.json({ error: 'Workflow not found' }, { status: 404 });

  const workflowJson = asRecord(workflow.workflow_json);
  const nodes = Array.isArray(workflowJson.nodes) ? (workflowJson.nodes as Record<string, unknown>[]) : [];
  const nodeIndex = nodes.findIndex((n) => String(n.id ?? n.name ?? '') === nodeId);
  if (nodeIndex === -1) return NextResponse.json({ error: `Node "${nodeId}" was not found in this workflow.` }, { status: 404 });

  const node = nodes[nodeIndex];
  const nodeType = String(node.type ?? '').toLowerCase();
  if (!nodeType.includes('airtable')) {
    return NextResponse.json({ error: `Node "${nodeId}" is not an Airtable node.` }, { status: 400 });
  }

  const creds = await getDecryptedProviderCredentials(user.id, 'airtable');
  const token = creds.personal_access_token;
  if (!token) return NextResponse.json({ error: 'Airtable is not connected for this account.' }, { status: 409 });

  const realFieldNames = Object.values(fieldMapping).map((v) => String(v));

  let validation;
  try {
    validation = await validateAirtableMapping(token, baseId, tableId, realFieldNames);
  } catch (err) {
    const safe = classifyError(err);
    return NextResponse.json({ error: safe.message }, { status: safe.httpStatus });
  }

  if (!validation.ok) {
    return NextResponse.json({ error: validation.reason, unknownFields: validation.unknownFields, readonlyFields: validation.readonlyFields }, { status: 400 });
  }

  // Rebuild the node's fields with REAL field names as keys, preserving
  // each existing value expression (e.g. ={{$json["name"]}}) unchanged --
  // only the target field identity changes, never the mapped data itself.
  const existingFields = asRecord(node.parameters).fields;
  const existingFieldsRecord = asRecord(existingFields);
  const newFields: Record<string, unknown> = {};
  for (const [existingKey, realFieldName] of Object.entries(fieldMapping)) {
    newFields[String(realFieldName)] = existingFieldsRecord[existingKey];
  }

  const updatedNode = {
    ...node,
    parameters: {
      ...asRecord(node.parameters),
      baseId,
      tableId,
      fields: newFields,
      // Canonical parameters only from here on -- dead aliases from an
      // earlier, unverified generation are dropped now that a real,
      // verified mapping has replaced them.
      application: undefined,
      applicationId: undefined,
      base: undefined,
      table: undefined,
      tableName: undefined,
    },
  };
  delete (updatedNode.parameters as Record<string, unknown>).application;
  delete (updatedNode.parameters as Record<string, unknown>).applicationId;
  delete (updatedNode.parameters as Record<string, unknown>).base;
  delete (updatedNode.parameters as Record<string, unknown>).table;
  delete (updatedNode.parameters as Record<string, unknown>).tableName;

  const updatedNodes = [...nodes];
  updatedNodes[nodeIndex] = updatedNode;
  const updatedWorkflowJson = { ...workflowJson, nodes: updatedNodes };

  const db = createServiceClient();
  const { error: updateError } = await db
    .from('workflows')
    .update({ workflow_json: updatedWorkflowJson, updated_at: new Date().toISOString() })
    .eq('id', params.id)
    .eq('user_id', user.id);

  if (updateError) {
    const safe = classifyError(updateError);
    return NextResponse.json({ error: safe.message }, { status: safe.httpStatus });
  }

  return NextResponse.json({ ok: true, node: updatedNode, table: validation.table });
}

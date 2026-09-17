import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase-server';
import { patchWorkflowNode, asConfigRecord } from '@/lib/workflow/node-config-save';

type Ctx = { params: { id: string } };

function isEmailNodeType(type: string): boolean {
  const t = type.toLowerCase();
  return (t.includes('email') || t.includes('gmail')) && !t.includes('trigger');
}

function isSlackNodeType(type: string): boolean {
  const t = type.toLowerCase();
  return t.includes('slack') && !t.includes('trigger');
}

const EMAIL_FIELDS = new Set(['subject', 'body']);
const SLACK_FIELDS = new Set(['message']);

/**
 * PATCH /api/workflows/[id]/notification-content
 *
 * Phase 9.9.16 -- Part F/G. Body: { nodeId, expectedUpdatedAt, field: 'subject'|'body'|'message', value }.
 *
 * `value` is the FINAL rendered template string (e.g. containing
 * `{{$json["name"]}}` or `{{?field}}...{{/field}}`) -- the UI is
 * responsible for composing it via safe field-insertion (never free-typed
 * eval/expression syntax), but this route is the actual authority: it never
 * trusts the client's composition tool, it re-validates the resulting node
 * set through the exact same lib/agent/template-expression-guard.ts and
 * lib/agent/notification-content-guard.ts checks activation already runs
 * (via patchWorkflowNode), so a value that smuggles unsupported syntax or
 * references a denylisted field is rejected here exactly as it would be at
 * activation -- Phase 9.9.9's guards are never weakened for this new path.
 */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });

  const { nodeId, expectedUpdatedAt, field, value } = body as Record<string, unknown>;
  if (typeof nodeId !== 'string' || !nodeId.trim()) return NextResponse.json({ error: 'nodeId is required' }, { status: 400 });
  if (typeof expectedUpdatedAt !== 'string' || !expectedUpdatedAt.trim()) {
    return NextResponse.json({ error: 'expectedUpdatedAt is required -- pass back the value this editor most recently loaded.' }, { status: 400 });
  }
  if (typeof field !== 'string' || !field.trim()) return NextResponse.json({ error: 'field is required' }, { status: 400 });
  if (typeof value !== 'string') return NextResponse.json({ error: 'value must be a string' }, { status: 400 });

  const result = await patchWorkflowNode({
    userId: user.id,
    workflowId: params.id,
    nodeId,
    expectedUpdatedAt,
    mutate: (node) => {
      const type = String(node.type ?? '');
      const isEmail = isEmailNodeType(type);
      const isSlack = isSlackNodeType(type);
      if (!isEmail && !isSlack) return { ok: false, error: `Node "${nodeId}" is not an email or Slack notification node.` };
      const allowed = isEmail ? EMAIL_FIELDS : SLACK_FIELDS;
      if (!allowed.has(field)) {
        return { ok: false, error: `"${field}" is not editable on this node -- ${isEmail ? '"subject" or "body"' : '"message"'} expected.` };
      }
      const existingParams = asConfigRecord(node.parameters);
      return { ok: true, node: { ...node, parameters: { ...existingParams, [field]: value } } };
    },
  });

  if (!result.ok) return NextResponse.json({ error: result.error, ...(result.status === 409 ? { latestUpdatedAt: result.latestUpdatedAt } : {}) }, { status: result.status });
  return NextResponse.json({ ok: true, node: result.node, updatedAt: result.updatedAt });
}

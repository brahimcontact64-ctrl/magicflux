import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase-server';
import { patchWorkflowNode, asConfigRecord } from '@/lib/workflow/node-config-save';
import { HUMAN_REVIEW_NODE_TYPE } from '@/lib/workflow-runtime/node-capabilities';

type Ctx = { params: { id: string } };

/**
 * PATCH /api/workflows/[id]/human-review-config
 *
 * Phase 9.9.16 -- Part E. Body: { nodeId, expectedUpdatedAt, instruction?, allowedOutcomes?, outputField? }.
 *
 * `allowedOutcomes` deliberately only allows RENAMING an existing outcome in
 * place or APPENDING a new one at the end -- never removing or reordering
 * an existing entry. Root cause: the runtime engine picks the downstream
 * branch by POSITION (`allowedOutcomes.indexOf(decision) -> output port N`,
 * lib/workflow-runtime/node-handlers/human-review.ts), and which real
 * Airtable/Gmail/Slack/SLA nodes sit behind port N is wired by the AI
 * generator's own graph edges, which THIS route never touches. Removing or
 * reordering an outcome here would silently repoint an existing edge at a
 * different meaning without moving it -- a correctness bug this route must
 * never be able to cause. Renaming (same length, same order) and appending
 * (new, as-yet-unwired port) are both safe: neither changes what any
 * EXISTING index means. Rewiring which node sits behind an outcome remains
 * a Builder canvas / regeneration operation, out of scope here (Part I:
 * "does not necessarily require an arbitrary visual BPM editor").
 */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });

  const { nodeId, expectedUpdatedAt, instruction, allowedOutcomes, outputField } = body as Record<string, unknown>;
  if (typeof nodeId !== 'string' || !nodeId.trim()) return NextResponse.json({ error: 'nodeId is required' }, { status: 400 });
  if (typeof expectedUpdatedAt !== 'string' || !expectedUpdatedAt.trim()) {
    return NextResponse.json({ error: 'expectedUpdatedAt is required -- pass back the value this editor most recently loaded.' }, { status: 400 });
  }
  if (instruction !== undefined && (typeof instruction !== 'string' || !instruction.trim())) {
    return NextResponse.json({ error: 'instruction must be a non-empty string' }, { status: 400 });
  }
  if (outputField !== undefined && (typeof outputField !== 'string' || !outputField.trim())) {
    return NextResponse.json({ error: 'outputField must be a non-empty string' }, { status: 400 });
  }

  let normalizedOutcomes: string[] | undefined;
  if (allowedOutcomes !== undefined) {
    if (!Array.isArray(allowedOutcomes) || allowedOutcomes.length === 0) {
      return NextResponse.json({ error: 'allowedOutcomes must be a non-empty array' }, { status: 400 });
    }
    normalizedOutcomes = allowedOutcomes.map((o) => String(o).trim());
    if (normalizedOutcomes.some((o) => !o)) return NextResponse.json({ error: 'Every outcome name must be non-empty' }, { status: 400 });
    if (new Set(normalizedOutcomes).size !== normalizedOutcomes.length) {
      return NextResponse.json({ error: 'Outcome names must be unique' }, { status: 400 });
    }
  }

  const result = await patchWorkflowNode({
    userId: user.id,
    workflowId: params.id,
    nodeId,
    expectedUpdatedAt,
    mutate: (node) => {
      if (String(node.type ?? '').toLowerCase() !== HUMAN_REVIEW_NODE_TYPE.toLowerCase()) {
        return { ok: false, error: `Node "${nodeId}" is not a Human Review node.` };
      }
      const existingParams = asConfigRecord(node.parameters);
      const existingOutcomes = Array.isArray(existingParams.allowedOutcomes)
        ? existingParams.allowedOutcomes.map((o) => String(o).trim())
        : ['approve', 'reject'];

      // Positional identity must be preserved -- only the label at each
      // existing index may change (a rename); new entries may only be
      // appended after it, never inserted before or in between.
      if (normalizedOutcomes !== undefined && normalizedOutcomes.length < existingOutcomes.length) {
        return { ok: false, error: 'Outcomes can only be renamed or appended here, never removed -- removing one would silently repoint an already-wired branch. Use the workflow builder to rewire branches first.' };
      }

      const nextParams: Record<string, unknown> = { ...existingParams };
      if (instruction !== undefined) nextParams.instruction = (instruction as string).trim();
      if (outputField !== undefined) nextParams.outputField = (outputField as string).trim();
      if (normalizedOutcomes !== undefined) nextParams.allowedOutcomes = normalizedOutcomes;
      return { ok: true, node: { ...node, parameters: nextParams } };
    },
  });

  if (!result.ok) return NextResponse.json({ error: result.error, ...(result.status === 409 ? { latestUpdatedAt: result.latestUpdatedAt } : {}) }, { status: result.status });
  return NextResponse.json({ ok: true, node: result.node, updatedAt: result.updatedAt });
}

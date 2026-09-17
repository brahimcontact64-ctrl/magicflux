import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase-server';
import { patchWorkflowNode, asConfigRecord } from '@/lib/workflow/node-config-save';
import { parseQualificationPolicy, type QualificationFieldRule, type QualificationContradictionRule } from '@/lib/workflow-runtime/node-handlers/qualification-policy';
import { AI_CLASSIFIER_NODE_TYPE } from '@/lib/workflow-runtime/node-capabilities';
import { isDenylistedFieldName } from '@/lib/security/field-denylist';

type Ctx = { params: { id: string } };

/**
 * PATCH /api/workflows/[id]/qualification-policy
 *
 * Phase 9.9.16 -- Part C/D: the AI Qualification Policy Editor's save path.
 * Body: {
 *   nodeId, expectedUpdatedAt,
 *   instruction?, allowedLabels?, confidenceThreshold?,
 *   qualificationPolicy?: QualificationPolicyInput | null   // null clears it
 * }
 * A field omitted entirely is left unchanged; `qualificationPolicy: null`
 * explicitly removes the policy (the node then runs exactly as it did
 * before Phase 9.9.10 -- pure LLM judgment, no deterministic gate).
 *
 * Every denylisted/internal field name is rejected here with a precise
 * per-field message -- never silently dropped -- before the same
 * parseQualificationPolicy()/validateQualificationPolicyShape() the
 * generator and activation gate already use gets the final say (Part D:
 * client-side validation is UX only, server-side guards stay authoritative).
 */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });

  const { nodeId, expectedUpdatedAt, instruction, allowedLabels, confidenceThreshold, qualificationPolicy } = body as Record<string, unknown>;
  if (typeof nodeId !== 'string' || !nodeId.trim()) return NextResponse.json({ error: 'nodeId is required' }, { status: 400 });
  if (typeof expectedUpdatedAt !== 'string' || !expectedUpdatedAt.trim()) {
    return NextResponse.json({ error: 'expectedUpdatedAt is required -- pass back the value this editor most recently loaded, so a concurrent edit elsewhere can be detected.' }, { status: 400 });
  }

  if (instruction !== undefined && (typeof instruction !== 'string' || !instruction.trim())) {
    return NextResponse.json({ error: 'instruction must be a non-empty string' }, { status: 400 });
  }

  let normalizedAllowedLabels: string[] | undefined;
  if (allowedLabels !== undefined) {
    if (!Array.isArray(allowedLabels) || allowedLabels.length === 0) {
      return NextResponse.json({ error: 'allowedLabels must be a non-empty array of classification names' }, { status: 400 });
    }
    normalizedAllowedLabels = Array.from(new Set(allowedLabels.map((l) => String(l).trim()).filter(Boolean)));
    if (normalizedAllowedLabels.length === 0) {
      return NextResponse.json({ error: 'allowedLabels must contain at least one non-empty classification name' }, { status: 400 });
    }
  }

  if (confidenceThreshold !== undefined) {
    if (typeof confidenceThreshold !== 'number' || !Number.isFinite(confidenceThreshold) || confidenceThreshold < 0 || confidenceThreshold > 1) {
      return NextResponse.json({ error: 'confidenceThreshold must be a number between 0 and 1' }, { status: 400 });
    }
  }

  let normalizedPolicy: ReturnType<typeof parseQualificationPolicy> | undefined;
  if (qualificationPolicy !== undefined) {
    if (qualificationPolicy === null) {
      normalizedPolicy = null;
    } else {
      const raw = asConfigRecord(qualificationPolicy);
      const allowedInputFields = Array.isArray(raw.allowedInputFields) ? raw.allowedInputFields.map((f) => String(f).trim()).filter(Boolean) : [];
      for (const f of allowedInputFields) {
        if (isDenylistedFieldName(f)) {
          return NextResponse.json({ error: `"${f}" is an internal or credential-shaped field name and can never be used as a qualification input.` }, { status: 400 });
        }
      }

      const fieldsRaw = Array.isArray(raw.fields) ? raw.fields : [];
      for (const fr of fieldsRaw) {
        const rec = asConfigRecord(fr);
        const fieldName = String(rec.field ?? '').trim();
        if (!fieldName) return NextResponse.json({ error: 'Every qualification field rule needs a field name.' }, { status: 400 });
        if (isDenylistedFieldName(fieldName)) {
          return NextResponse.json({ error: `"${fieldName}" is an internal or credential-shaped field name and can never be a qualification input.` }, { status: 400 });
        }
        if (!allowedInputFields.includes(fieldName)) {
          return NextResponse.json({ error: `"${fieldName}" must also be listed in the allowed input fields.` }, { status: 400 });
        }
        if (rec.kind !== 'numeric' && rec.kind !== 'enum' && rec.kind !== 'text') {
          return NextResponse.json({ error: `"${fieldName}": kind must be "numeric", "enum", or "text".` }, { status: 400 });
        }
        if (rec.kind === 'enum' && !Array.isArray(rec.positiveValues) && !Array.isArray(rec.negativeValues)) {
          return NextResponse.json({ error: `"${fieldName}" is an enum rule but declares no positive or negative values -- it would never match anything.` }, { status: 400 });
        }
        if (rec.kind === 'numeric' && rec.positiveMin === undefined && rec.negativeMax === undefined) {
          return NextResponse.json({ error: `"${fieldName}" is a numeric rule but declares no positive-min or negative-max threshold -- it would never match anything.` }, { status: 400 });
        }
      }

      const contradictionsRaw = Array.isArray(raw.contradictions) ? raw.contradictions : [];
      const fieldNames = new Set(fieldsRaw.map((f) => String(asConfigRecord(f).field ?? '').trim()));
      for (const cr of contradictionsRaw) {
        const rec = asConfigRecord(cr);
        const pos = String(rec.positiveField ?? '').trim();
        const neg = String(rec.negativeField ?? '').trim();
        if (!fieldNames.has(pos) || !fieldNames.has(neg)) {
          return NextResponse.json({ error: 'Each contradiction rule must reference two field names that are both already defined above.' }, { status: 400 });
        }
      }

      const candidate = { version: 1 as const, allowedInputFields, fields: fieldsRaw as QualificationFieldRule[], contradictions: contradictionsRaw as QualificationContradictionRule[] };
      const parsed = parseQualificationPolicy(candidate);
      if (!parsed) {
        return NextResponse.json({ error: 'This qualification policy is not structurally valid -- check that every rule has a supported "kind" and at least one threshold/value list.' }, { status: 400 });
      }
      normalizedPolicy = parsed;
    }
  }

  const result = await patchWorkflowNode({
    userId: user.id,
    workflowId: params.id,
    nodeId,
    expectedUpdatedAt,
    mutate: (node) => {
      if (String(node.type ?? '').toLowerCase() !== AI_CLASSIFIER_NODE_TYPE.toLowerCase()) {
        return { ok: false, error: `Node "${nodeId}" is not an AI Classifier node.` };
      }
      const existingParams = asConfigRecord(node.parameters);
      const nextParams: Record<string, unknown> = { ...existingParams };
      if (instruction !== undefined) nextParams.instruction = (instruction as string).trim();
      if (normalizedAllowedLabels !== undefined) nextParams.allowedLabels = normalizedAllowedLabels;
      if (confidenceThreshold !== undefined) nextParams.confidenceThreshold = confidenceThreshold;
      if (normalizedPolicy !== undefined) {
        if (normalizedPolicy === null) delete nextParams.qualificationPolicy;
        else nextParams.qualificationPolicy = normalizedPolicy;
      }
      return { ok: true, node: { ...node, parameters: nextParams } };
    },
  });

  if (!result.ok) return NextResponse.json({ error: result.error, ...(result.status === 409 ? { latestUpdatedAt: result.latestUpdatedAt } : {}) }, { status: result.status });
  return NextResponse.json({ ok: true, node: result.node, updatedAt: result.updatedAt });
}

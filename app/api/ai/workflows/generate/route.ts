import { NextRequest, NextResponse } from 'next/server';

import { getUserFromRequest } from '@/lib/supabase-server';
import { generateWorkflow }   from '@/lib/ai-workflows/workflow-generator';
import { validateWorkflow }   from '@/lib/workflow-validator';

const MAX_PROMPT_LENGTH = 1_000;

/**
 * POST /api/ai/workflows/generate
 *
 * Generates a validated workflow JSON from a natural-language prompt.
 *
 * Security contract:
 *  - Requires authenticated user (401 if absent).
 *  - Rejects empty or oversized prompt (400).
 *  - Never executes the workflow — generation only.
 *  - Never saves to the database — caller must POST to /api/workflows if desired.
 *  - Never returns integration credentials (examplesUsed is stripped to safe fields).
 *  - The generator is fully deterministic: no external AI API calls.
 */
export async function POST(req: NextRequest) {
  // ── Auth ────────────────────────────────────────────────────────────────────
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // ── Parse body ───────────────────────────────────────────────────────────────
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';

  if (!prompt) {
    return NextResponse.json(
      { error: 'prompt is required and must be a non-empty string.' },
      { status: 400 },
    );
  }

  if (prompt.length > MAX_PROMPT_LENGTH) {
    return NextResponse.json(
      { error: `prompt must be ${MAX_PROMPT_LENGTH} characters or fewer.` },
      { status: 400 },
    );
  }

  // ── Generate ─────────────────────────────────────────────────────────────────
  const result = generateWorkflow(prompt);

  // ── Re-validate returned workflow ────────────────────────────────────────────
  // The generator already validates internally, but we perform an explicit second
  // pass here so the API surface is independent of the generator's internals.
  const check = validateWorkflow(result.workflow);

  if (!check.valid) {
    return NextResponse.json(
      {
        error:   'Generated workflow did not pass validation.',
        errors:  check.errors,
        warnings: check.warnings,
      },
      { status: 422 },
    );
  }

  // ── Strip sensitive fields from examplesUsed ─────────────────────────────────
  // Training pairs contain full WorkflowJson objects — never return raw credentials.
  const safeExamples = result.examplesUsed.map(({ id, naturalLanguage, intent, tags }) => ({
    id,
    naturalLanguage,
    intent,
    tags,
  }));

  return NextResponse.json({
    workflow:       result.workflow,
    valid:          true,
    examplesUsed:   safeExamples,
    repairApplied:  result.repairApplied,
  });
}

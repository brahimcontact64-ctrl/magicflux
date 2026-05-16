import { NextRequest, NextResponse } from 'next/server';

import { runProPlanner } from '@/lib/ai-engine/pro-planner';
import {
  assessPromptIntent,
  buildClarificationError,
  buildClarificationFromMissing,
  buildIncompleteIntentError,
  buildUnsupportedRequirementsError,
} from '@/lib/intent-validator';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { prompt } = body as { prompt?: string };

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 3) {
    return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
  }

  const intentCheck = assessPromptIntent(prompt.trim());

  if (intentCheck.unsupportedProviders.length > 0) {
    return NextResponse.json(
      buildUnsupportedRequirementsError(intentCheck.unsupportedProviders),
      { status: 422 }
    );
  }

  if (intentCheck.missing.length > 0) {
    const clarification = buildClarificationFromMissing(intentCheck.missing);
    return NextResponse.json(
      {
        ...buildIncompleteIntentError(intentCheck.missing),
        mode: clarification.mode,
        questions: clarification.questions,
        suggestions: clarification.suggestions,
        examples: clarification.examples,
      },
      { status: 422 }
    );
  }

  if (intentCheck.confidence < 85) {
    return NextResponse.json(
      { error: 'CLARIFICATION_REQUIRED', ...buildClarificationError() },
      { status: 422 }
    );
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const mode = process.env.AI_PLANNER_MODE === 'openai' && apiKey ? 'openai' : 'deterministic';

  try {
    const planned = await runProPlanner(prompt, {
      mode,
      apiKey: apiKey ?? undefined,
    });

    return NextResponse.json({
      success: true,
      result: planned.plannerResult,
      plannerModeUsed: planned.plannerResult.plan.plannerModeUsed ?? mode,
      generationAdjusted: planned.generationAdjusted,
      generationWarning: planned.generationWarning,
      proPlanner: planned.proPlanner,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Planner failed';
    if (message.includes('Unable to generate accurate workflow')) {
      return NextResponse.json({ error: 'CLARIFICATION_REQUIRED', message }, { status: 422 });
    }
    if (message.startsWith('INCOMPLETE_INTENT:')) {
      return NextResponse.json(
        {
          error: 'INCOMPLETE_INTENT',
          message: message.replace('INCOMPLETE_INTENT:', '').trim(),
          suggestions: [
            'When I receive an email, send a Slack message',
            'When a Shopify order is created, save it in Airtable',
            'Every morning at 9am, send a summary email',
          ],
        },
        { status: 422 }
      );
    }
    if (message.startsWith('UNSUPPORTED_REQUIREMENTS:')) {
      return NextResponse.json(
        {
          error: 'UNSUPPORTED_REQUIREMENTS',
          message: message.replace('UNSUPPORTED_REQUIREMENTS:', '').trim(),
        },
        { status: 422 }
      );
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}

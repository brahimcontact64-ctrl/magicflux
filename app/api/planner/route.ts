import { NextRequest, NextResponse } from 'next/server';
import { BLOCKS } from '@/lib/blocks';
import { buildOpenAIPlannerSchema, assemblePlannerResult, createAutomationPlan } from '@/lib/planner';

const SYSTEM_PROMPT = `You are an automation architect for a no-code workflow builder called MagicFlux.

Your job is to convert a natural language prompt into a structured automation plan using ONLY the approved block registry below.

STRICT RULES:
1. Every blockId you choose MUST come from the approved_blocks list. Do not invent block IDs.
2. Every trigger.type must be one of: webhook, schedule, shopify_order, shopify_cart, email, manual.
3. Every step.type must be one of the approved action types.
4. Do not hallucinate integrations that don't exist in the registry.
5. Always include a code_transform step after the trigger for data normalization.
6. If the request requires something not in the registry (e.g. WhatsApp, voice cloning, bank payments, Airbnb native API), list it in unsupportedRequirements and still produce a best-effort plan using available blocks.
7. Set confidence low (30-50) when requirements are partially unsupported.
8. Be specific in assumptions — explain what you inferred from ambiguous phrasing.
9. requiredCredentials should list human-readable service names (e.g. "Shopify API", "Slack API", "SMTP").
10. planReasoning should explain why you chose this trigger and these steps.

WORKFLOW DESIGN PRINCIPLES:
- Shopify order automations use shopify_order_trigger → code_transform (context: shopify_order) → actions
- Schedule automations start with schedule_trigger and typically fetch data then send reports
- Approval workflows use approval_node (wait/resume pattern — the workflow pauses until a human visits a URL)
- Use slack_message for team notifications, send_email_smtp for customer notifications
- Keep workflows focused: 3-6 nodes is ideal, 7-10 is complex but acceptable
- Runtime-compatible: all blocks map to real n8n nodes, no fake credentials

For truly unsupported requests (WhatsApp Business API, voice cloning, cryptocurrency, etc.), set unsupportedRequirements clearly, keep confidence ≤ 40, and show what partial automation IS possible.`;

function buildUserMessage(prompt: string, blockIds: string[]): string {
  const blockList = blockIds.map(id => {
    const b = BLOCKS[id];
    return `  - ${id}: ${b?.name} (${b?.category}) — ${b?.description}`;
  }).join('\n');

  return `User prompt: "${prompt}"

Approved blocks (use ONLY these blockIds):
${blockList}

Return a structured automation plan. Every blockId must match exactly one of the IDs above.`;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { prompt } = body as { prompt?: string };

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 3) {
    return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const mode = process.env.AI_PLANNER_MODE ?? 'deterministic';

  // If not configured for OpenAI, return deterministic result immediately
  if (!apiKey || mode !== 'openai') {
    const result = createAutomationPlan(prompt, 'deterministic');
    return NextResponse.json({ success: true, result, plannerModeUsed: 'deterministic' });
  }

  const blockIds = Object.keys(BLOCKS);
  const schema = buildOpenAIPlannerSchema(blockIds);

  try {
    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-2024-08-06',
        temperature: 0.2,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserMessage(prompt, blockIds) }
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'automation_plan',
            strict: true,
            schema
          }
        }
      })
    });

    if (!openaiRes.ok) {
      const errText = await openaiRes.text().catch(() => '');
      throw new Error(`OpenAI API error ${openaiRes.status}: ${errText}`);
    }

    const openaiData = await openaiRes.json();
    const content = openaiData.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error('OpenAI returned empty response');
    }

    let rawPlan: Record<string, unknown>;
    try {
      rawPlan = JSON.parse(content);
    } catch {
      throw new Error('OpenAI returned non-JSON content');
    }

    // Validate all block IDs against registry before assembling
    const blockIdSet = new Set(blockIds);
    const triggerBlockId = (rawPlan.trigger as Record<string, unknown>)?.blockId as string;
    if (triggerBlockId && !blockIdSet.has(triggerBlockId)) {
      throw new Error(`OpenAI returned unknown trigger blockId: "${triggerBlockId}"`);
    }
    const steps = (rawPlan.steps as Array<Record<string, unknown>>) ?? [];
    for (const step of steps) {
      if (step.blockId && !blockIdSet.has(step.blockId as string)) {
        throw new Error(`OpenAI returned unknown step blockId: "${step.blockId}"`);
      }
    }

    // Assemble full PlannerResult using existing composer/validator
    const result = assemblePlannerResult(rawPlan as Parameters<typeof assemblePlannerResult>[0]);

    return NextResponse.json({ success: true, result, plannerModeUsed: 'openai' });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[/api/planner] OpenAI error, falling back to deterministic:', message);

    // Graceful fallback — deterministic planner, mode flagged as fallback
    const result = createAutomationPlan(prompt, 'deterministic_fallback');
    return NextResponse.json({
      success: true,
      result,
      plannerModeUsed: 'deterministic_fallback',
      fallbackReason: message
    });
  }
}

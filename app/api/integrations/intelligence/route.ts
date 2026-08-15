import { NextRequest, NextResponse } from 'next/server';
import { getBearerToken, getUserFromAccessToken } from '@/lib/supabase-server';
import { analyzeAutomationRequirements } from '@/lib/credentials/intelligence';

/**
 * GET /api/integrations/intelligence?prompt=<text>
 * POST /api/integrations/intelligence  { "prompt": "<text>" }
 *
 * Parses the automation prompt, detects required providers, and returns their
 * current connection/credential state for the authenticated user.
 *
 * Response:
 *   {
 *     integrations: IntegrationRequirement[],
 *     allReady: boolean,
 *     blockers: string[]
 *   }
 */
export async function GET(req: NextRequest) {
  const token = getBearerToken(req);
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const user = await getUserFromAccessToken(token);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const prompt = req.nextUrl.searchParams.get('prompt') ?? '';
  if (!prompt.trim()) {
    return NextResponse.json({ error: 'prompt query parameter is required' }, { status: 400 });
  }

  try {
    const result = await analyzeAutomationRequirements(prompt, user.id);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Intelligence analysis failed' },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  const token = getBearerToken(req);
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const user = await getUserFromAccessToken(token);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({})) as { prompt?: string };
  const prompt = String(body.prompt ?? '').trim();

  if (!prompt) {
    return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
  }

  try {
    const result = await analyzeAutomationRequirements(prompt, user.id);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Intelligence analysis failed' },
      { status: 500 }
    );
  }
}

import { NextRequest, NextResponse } from 'next/server';

import { runSelfHeal } from '@/lib/runtime/self-healer';

type SelfHealBody = {
  orphanStaleMinutes?: number;
  jobStaleMinutes?: number;
  windowMinutes?: number;
  limit?: number;
};

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: 'CRON_SECRET environment variable is not configured' },
      { status: 500 }
    );
  }

  const authHeader = req.headers.get('authorization') ?? '';
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  if (!provided || provided !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => ({})) as SelfHealBody;

  const orphanStaleMinutes = Number.isFinite(Number(body.orphanStaleMinutes))
    ? Math.max(1, Number(body.orphanStaleMinutes))
    : undefined;
  const jobStaleMinutes = Number.isFinite(Number(body.jobStaleMinutes))
    ? Math.max(1, Number(body.jobStaleMinutes))
    : undefined;
  const windowMinutes = Number.isFinite(Number(body.windowMinutes))
    ? Math.min(Math.max(1, Number(body.windowMinutes)), 1440)
    : undefined;
  const limit = Number.isFinite(Number(body.limit))
    ? Math.min(Math.max(1, Number(body.limit)), 500)
    : undefined;

  try {
    const report = await runSelfHeal({ orphanStaleMinutes, jobStaleMinutes, windowMinutes, limit });
    return NextResponse.json({ success: true, report });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Self-heal failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

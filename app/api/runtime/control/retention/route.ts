import { NextRequest, NextResponse } from 'next/server';

import { createServiceClient } from '@/lib/supabase-server';

type RetentionResult = {
  runtime_metrics_deleted: number;
  runtime_cost_records_deleted: number;
  runtime_execution_events_marked_archivable: number;
  ran_at: string;
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

  const db = createServiceClient();

  const { data, error } = await db.rpc('run_retention_policies');

  if (error) {
    return NextResponse.json(
      { error: 'Retention run failed', detail: error.message },
      { status: 500 }
    );
  }

  const result = data as RetentionResult;

  return NextResponse.json({
    success: true,
    report: {
      runtime_metrics_deleted: result.runtime_metrics_deleted,
      runtime_cost_records_deleted: result.runtime_cost_records_deleted,
      runtime_execution_events_marked_archivable: result.runtime_execution_events_marked_archivable,
      ran_at: result.ran_at,
    },
  });
}

import { NextRequest, NextResponse } from 'next/server';

import { getUserFromRequest } from '@/lib/supabase-server';
import { verifyReplayIntegrity } from '@/lib/runtime/replay-integrity';

type Ctx = { params: { executionId: string } };

// GET — run a full deterministic replay integrity check on an execution.
//
// Optional query parameters:
//   ?expected_checksum=<hex>   — compare the computed checksum against a known-good value
//
// Response fields:
//   checksum                   — SHA-256 of the ordered event stream
//   sequenceGaps               — any missing sequence numbers
//   fencingViolations          — non-monotonic or split-brain fencing token issues
//   snapshotCompatible         — whether the snapshot version fits within the event stream
//   deterministicReplayVerdict — clean | no_events | gaps_detected | fencing_violations | snapshot_mismatch
export async function GET(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const executionId = params.executionId.trim();
  if (!executionId) return NextResponse.json({ error: 'executionId is required' }, { status: 400 });

  const sp               = req.nextUrl.searchParams;
  const expectedChecksum = sp.get('expected_checksum') ?? undefined;

  const startMs = Date.now();
  const report = await verifyReplayIntegrity({
    executionId,
    userId:           user.id,
    expectedChecksum,
  });
  const elapsedMs = Date.now() - startMs;

  return NextResponse.json({
    ...report,
    metrics: { elapsed_ms: elapsedMs },
  });
}

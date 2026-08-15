import { NextRequest } from 'next/server';

import { getUserFromRequest, createServiceClient } from '@/lib/supabase-server';
import { getUserPermissions } from '@/lib/runtime/rbac';
import { listActiveIncidents } from '@/lib/runtime/incident-manager';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type StreamPayload = {
  incidents:      unknown[];
  workers:        unknown[];
  commandBacklog: Record<string, number>;
  healthScore:    number | null;
  ts:             string;
};

async function fetchRuntimeState(
  db: ReturnType<typeof createServiceClient>,
  scopedUserId?: string
): Promise<StreamPayload> {
  const staleWorkerCutoff = new Date(Date.now() - 90_000).toISOString();

  let commandsQ = db
    .from('runtime_execution_commands')
    .select('status')
    .in('status', ['pending', 'processing', 'failed', 'dead_letter'])
    .limit(1000);
  if (scopedUserId) commandsQ = commandsQ.eq('user_id', scopedUserId);

  const [incidentsData, workersRes, commandsRes] = await Promise.all([
    listActiveIncidents({ limit: 20, userId: scopedUserId }),
    db
      .from('runtime_workers')
      .select('worker_id, status, concurrency, cpu_load, memory_mb, heartbeat_at')
      .gte('heartbeat_at', staleWorkerCutoff)
      .order('heartbeat_at', { ascending: false })
      .limit(50),
    commandsQ,
  ]);

  const commands = (commandsRes.data ?? []) as Array<{ status: string }>;
  const commandBacklog = commands.reduce<Record<string, number>>((acc, c) => {
    const s = String(c.status ?? 'unknown');
    acc[s] = (acc[s] ?? 0) + 1;
    return acc;
  }, {});

  // Most recent health snapshot for the score
  const { data: snapshots } = await db
    .from('runtime_health_score_snapshots')
    .select('overall_score')
    .order('computed_at', { ascending: false })
    .limit(1);

  const healthScore = snapshots?.[0]?.overall_score ?? null;

  return {
    incidents:      incidentsData,
    workers:        workersRes.data ?? [],
    commandBacklog,
    healthScore,
    ts:             new Date().toISOString(),
  };
}

export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const perms = await getUserPermissions(user.id).catch(() => null);
  if (!perms) {
    return new Response(JSON.stringify({ error: 'Authorization service unavailable' }), { status: 503 });
  }
  if (!perms.includes('view_runtime') && !perms.includes('admin_runtime')) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
  }

  const isAdmin = perms.includes('admin_runtime');
  const scopedUserId = isAdmin ? undefined : user.id;

  const db = createServiceClient();
  const encoder = new TextEncoder();

  let heartbeatId: ReturnType<typeof setInterval> | null = null;
  let pollId:      ReturnType<typeof setInterval> | null = null;
  // Tracks disconnect that arrives while start() is still awaiting fetchRuntimeState.
  // Without this flag, intervals set up after the cancel would never be cleared.
  let cancelled = false;

  function cleanup() {
    cancelled = true;
    if (heartbeatId !== null) { clearInterval(heartbeatId); heartbeatId = null; }
    if (pollId      !== null) { clearInterval(pollId);      pollId      = null; }
  }

  const stream = new ReadableStream({
    async start(controller) {
      const send = (eventName: string, data: unknown): boolean => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`)
          );
          return true;
        } catch {
          return false;
        }
      };

      // Push initial state immediately
      try {
        const state = await fetchRuntimeState(db, scopedUserId);
        // Client may have disconnected while we were fetching — check before proceeding.
        if (cancelled) return;
        send('runtime_update', state);
      } catch {
        // Non-fatal — continue with heartbeats and polling
      }

      // Guard again: client may have disconnected during the initial fetch.
      if (cancelled) return;

      // Heartbeat every 15 s to keep the connection alive
      heartbeatId = setInterval(() => {
        const ok = send('heartbeat', { ts: new Date().toISOString() });
        if (!ok) { cleanup(); try { controller.close(); } catch { /* already closed */ } }
      }, 15_000);

      // State push every 5 s
      pollId = setInterval(async () => {
        try {
          const state = await fetchRuntimeState(db, scopedUserId);
          const ok = send('runtime_update', state);
          if (!ok) { cleanup(); try { controller.close(); } catch { /* already closed */ } }
        } catch {
          // DB error — skip this tick
        }
      }, 5_000);
    },

    cancel() {
      cleanup();
    },
  });

  req.signal.addEventListener('abort', () => {
    cleanup();
  });

  return new Response(stream, {
    headers: {
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache, no-transform',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

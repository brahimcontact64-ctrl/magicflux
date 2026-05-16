'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Activity, ArrowLeft, Loader2, RefreshCw, ShieldAlert, Zap } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme-toggle';
import { useAuth } from '@/lib/auth-context';
import { apiRequest } from '@/lib/api/client';
import { supabase } from '@/lib/supabase-client';
import { toast } from 'sonner';

type RuntimeSummary = {
  events: number;
  queues: number;
  traces: number;
  spans: number;
  workers: number;
  replays: number;
  deadLetters: number;
  queueByStatus: Record<string, number>;
  traceByStatus: Record<string, number>;
  replayByStatus: Record<string, number>;
};

type RuntimeEvent = {
  event_id: string;
  event_type: string;
  severity: 'debug' | 'info' | 'warning' | 'error' | 'critical';
  timestamp: string;
  correlation_id: string;
  trace_id?: string | null;
  session_id?: string | null;
  execution_id?: string | null;
  payload?: Record<string, unknown>;
};

type RuntimeQueueJob = {
  job_id: string;
  queue_name: string;
  task_type: string;
  status: string;
  attempts: number;
  max_attempts: number;
  trace_id?: string | null;
  correlation_id: string;
  queued_at?: string | null;
  completed_at?: string | null;
  error_message?: string | null;
};

type RuntimeTrace = {
  trace_id: string;
  correlation_id: string;
  status: string;
  root_agent?: string | null;
  started_at: string;
  completed_at?: string | null;
};

type RuntimeWorker = {
  worker_id: string;
  status: string;
  hostname?: string | null;
  pid?: number | null;
  heartbeat_at: string;
  jobs_processed: number;
  last_error?: string | null;
};

type RuntimeReplay = {
  id: string;
  replay_type: string;
  status: string;
  replay_trace_id?: string | null;
  requested_at: string;
  error_message?: string | null;
};

type RuntimeDeadLetter = {
  id: string;
  queue_name: string;
  task_type: string;
  trace_id?: string | null;
  execution_id?: string | null;
  error_message?: string | null;
  failed_at: string;
  replay_status?: string | null;
};

type RuntimeOverviewResponse = {
  success: boolean;
  summary: RuntimeSummary;
  events: RuntimeEvent[];
  queues: RuntimeQueueJob[];
  traces: RuntimeTrace[];
  workers: RuntimeWorker[];
  replays: RuntimeReplay[];
  deadLetters: RuntimeDeadLetter[];
};

function formatTime(value?: string | null): string {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

function severityClass(severity: RuntimeEvent['severity']) {
  if (severity === 'critical' || severity === 'error') return 'text-red-300';
  if (severity === 'warning') return 'text-amber-300';
  if (severity === 'info') return 'text-emerald-300';
  return 'text-muted-foreground';
}

export default function RuntimePage() {
  const router = useRouter();
  const { user, session, loading: authLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [replayLoadingId, setReplayLoadingId] = useState<string | null>(null);
  const [summary, setSummary] = useState<RuntimeSummary | null>(null);
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [queues, setQueues] = useState<RuntimeQueueJob[]>([]);
  const [traces, setTraces] = useState<RuntimeTrace[]>([]);
  const [workers, setWorkers] = useState<RuntimeWorker[]>([]);
  const [replays, setReplays] = useState<RuntimeReplay[]>([]);
  const [deadLetters, setDeadLetters] = useState<RuntimeDeadLetter[]>([]);

  useEffect(() => {
    if (!authLoading && !user) router.replace('/login');
  }, [authLoading, user, router]);

  const withAuthHeaders = useCallback(async (): Promise<HeadersInit | null> => {
    const token = session?.access_token;
    if (!token) {
      toast.error('Session expired. Please sign in again.');
      return null;
    }
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };
  }, [session?.access_token]);

  const loadOverview = useCallback(async (asRefresh = false) => {
    if (!session?.access_token) return;

    if (asRefresh) setRefreshing(true);
    else setLoading(true);

    try {
      const headers = await withAuthHeaders();
      if (!headers) return;

      const payload = await apiRequest<RuntimeOverviewResponse>(
        '/api/agent/runtime/overview?limit=120',
        { headers, cache: 'no-store' },
        'Failed to load runtime overview'
      );

      setSummary(payload.summary);
      setEvents(payload.events ?? []);
      setQueues(payload.queues ?? []);
      setTraces(payload.traces ?? []);
      setWorkers(payload.workers ?? []);
      setReplays(payload.replays ?? []);
      setDeadLetters(payload.deadLetters ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load runtime overview');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [session?.access_token, withAuthHeaders]);

  useEffect(() => {
    void loadOverview(false);
  }, [loadOverview]);

  useEffect(() => {
    if (!user?.id) return;

    const channel = supabase
      .channel(`runtime-events-${user.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'runtime_events',
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          const next = payload.new as RuntimeEvent;
          setEvents((prev) => [next, ...prev].slice(0, 120));
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [user?.id]);

  useEffect(() => {
    if (!session?.access_token) return;
    const timer = setInterval(() => {
      void loadOverview(true);
    }, 30000);

    return () => clearInterval(timer);
  }, [session?.access_token, loadOverview]);

  const handleReplayDlq = useCallback(async (dlqId: string) => {
    setReplayLoadingId(dlqId);
    try {
      const headers = await withAuthHeaders();
      if (!headers) return;

      await apiRequest<{ success: boolean }>(
        '/api/agent/runtime/replay',
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ type: 'dlq', id: dlqId, reason: 'manual replay from runtime dashboard' }),
        },
        'Replay request failed'
      );

      toast.success('DLQ replay queued');
      await loadOverview(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Replay failed');
    } finally {
      setReplayLoadingId(null);
    }
  }, [loadOverview, withAuthHeaders]);

  const liveWorkerCount = useMemo(
    () => workers.filter((worker) => worker.status === 'healthy').length,
    [workers]
  );

  if (authLoading || loading) {
    return (
      <div className='min-h-screen bg-background flex items-center justify-center text-sm text-muted-foreground gap-2'>
        <Loader2 className='h-4 w-4 animate-spin' /> Loading runtime...
      </div>
    );
  }

  return (
    <div className='min-h-screen bg-background'>
      <header className='sticky top-0 z-10 flex h-14 items-center gap-4 border-b border-border bg-card/60 px-6 backdrop-blur'>
        <Link href='/' className='group flex items-center gap-2'>
          <div className='flex h-7 w-7 items-center justify-center rounded-md bg-primary transition-transform group-hover:scale-105'>
            <Zap className='h-3.5 w-3.5 text-primary-foreground' fill='currentColor' />
          </div>
          <span className='text-sm font-semibold'>MagicFlux Runtime</span>
        </Link>
        <div className='h-4 w-px bg-border' />
        <span className='text-xs text-muted-foreground'>Live execution control plane</span>
        <div className='flex-1' />
        <Button variant='ghost' size='sm' className='gap-1.5 text-xs text-muted-foreground' onClick={() => void loadOverview(true)} disabled={refreshing}>
          <RefreshCw className={refreshing ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
          Refresh
        </Button>
        <ThemeToggle />
        <Link href='/dashboard'>
          <Button variant='ghost' size='sm' className='gap-2 text-muted-foreground'>
            <ArrowLeft className='h-3.5 w-3.5' /> Dashboard
          </Button>
        </Link>
      </header>

      <main className='mx-auto max-w-7xl space-y-6 px-6 py-8'>
        <div className='grid gap-4 sm:grid-cols-2 xl:grid-cols-4'>
          <div className='rounded-xl border border-border bg-card p-4'>
            <p className='text-xs text-muted-foreground'>Runtime Events</p>
            <p className='mt-1 text-2xl font-semibold'>{summary?.events ?? 0}</p>
          </div>
          <div className='rounded-xl border border-border bg-card p-4'>
            <p className='text-xs text-muted-foreground'>Queue Jobs</p>
            <p className='mt-1 text-2xl font-semibold'>{summary?.queues ?? 0}</p>
          </div>
          <div className='rounded-xl border border-border bg-card p-4'>
            <p className='text-xs text-muted-foreground'>Active Traces</p>
            <p className='mt-1 text-2xl font-semibold'>{summary?.traceByStatus?.running ?? 0}</p>
          </div>
          <div className='rounded-xl border border-border bg-card p-4'>
            <p className='text-xs text-muted-foreground'>Healthy Workers</p>
            <p className='mt-1 text-2xl font-semibold'>{liveWorkerCount}</p>
          </div>
        </div>

        <div className='grid gap-6 lg:grid-cols-2'>
          <section className='rounded-xl border border-border bg-card p-4'>
            <div className='mb-3 flex items-center justify-between'>
              <h2 className='text-sm font-semibold'>Realtime Event Stream</h2>
              <Activity className='h-4 w-4 text-emerald-300' />
            </div>
            <div className='max-h-[420px] space-y-2 overflow-auto pr-1'>
              {events.length === 0 ? (
                <p className='text-xs text-muted-foreground'>No runtime events yet.</p>
              ) : events.slice(0, 80).map((event) => (
                <div key={event.event_id} className='rounded-lg border border-border bg-muted/20 p-3 text-xs'>
                  <div className='flex flex-wrap items-center justify-between gap-2'>
                    <p className='font-medium'>{event.event_type}</p>
                    <span className={severityClass(event.severity)}>{event.severity}</span>
                  </div>
                  <p className='mt-1 text-muted-foreground'>{formatTime(event.timestamp)}</p>
                  <div className='mt-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground'>
                    <span>Trace: {event.trace_id ?? '-'}</span>
                    <span>Exec: {event.execution_id ?? '-'}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className='rounded-xl border border-border bg-card p-4'>
            <div className='mb-3 flex items-center justify-between'>
              <h2 className='text-sm font-semibold'>Worker Registry</h2>
              <span className='text-xs text-muted-foreground'>{workers.length} workers</span>
            </div>
            <div className='space-y-2'>
              {workers.length === 0 ? (
                <p className='text-xs text-muted-foreground'>No workers registered.</p>
              ) : workers.slice(0, 20).map((worker) => (
                <div key={worker.worker_id} className='rounded-lg border border-border bg-muted/20 p-3 text-xs'>
                  <div className='flex items-center justify-between gap-2'>
                    <p className='font-medium truncate'>{worker.worker_id}</p>
                    <span className={worker.status === 'healthy' ? 'text-emerald-300' : 'text-amber-300'}>{worker.status}</span>
                  </div>
                  <div className='mt-1 text-muted-foreground'>
                    {worker.hostname ?? 'unknown-host'}:{worker.pid ?? 'n/a'}
                  </div>
                  <div className='mt-1 text-muted-foreground'>
                    heartbeat {formatTime(worker.heartbeat_at)} • jobs {worker.jobs_processed ?? 0}
                  </div>
                  {worker.last_error ? <p className='mt-1 text-red-300'>{worker.last_error}</p> : null}
                </div>
              ))}
            </div>
          </section>
        </div>

        <div className='grid gap-6 lg:grid-cols-2'>
          <section className='rounded-xl border border-border bg-card p-4'>
            <h2 className='mb-3 text-sm font-semibold'>Queue Failures (DLQ)</h2>
            <div className='space-y-2'>
              {deadLetters.length === 0 ? (
                <p className='text-xs text-muted-foreground'>No dead-letter jobs.</p>
              ) : deadLetters.slice(0, 30).map((row) => (
                <div key={row.id} className='rounded-lg border border-border bg-muted/20 p-3 text-xs'>
                  <div className='flex flex-wrap items-center justify-between gap-2'>
                    <p className='font-medium'>{row.queue_name} / {row.task_type}</p>
                    <span className='text-amber-300'>{row.replay_status ?? 'pending'}</span>
                  </div>
                  <p className='mt-1 text-muted-foreground'>Failed {formatTime(row.failed_at)}</p>
                  <p className='mt-1 text-red-300 line-clamp-2'>{row.error_message ?? 'Unknown error'}</p>
                  <div className='mt-2'>
                    <Button size='sm' variant='outline' className='h-7 text-[11px]' onClick={() => void handleReplayDlq(row.id)} disabled={replayLoadingId === row.id}>
                      {replayLoadingId === row.id ? <Loader2 className='mr-1 h-3 w-3 animate-spin' /> : null}
                      Replay
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className='rounded-xl border border-border bg-card p-4'>
            <h2 className='mb-3 text-sm font-semibold'>Trace and Replay Status</h2>
            <div className='space-y-2'>
              {traces.length === 0 ? (
                <p className='text-xs text-muted-foreground'>No traces captured yet.</p>
              ) : traces.slice(0, 20).map((trace) => (
                <div key={trace.trace_id} className='rounded-lg border border-border bg-muted/20 p-3 text-xs'>
                  <div className='flex items-center justify-between gap-2'>
                    <p className='font-medium truncate'>{trace.trace_id}</p>
                    <span className={trace.status === 'running' ? 'text-emerald-300' : 'text-muted-foreground'}>{trace.status}</span>
                  </div>
                  <p className='mt-1 text-muted-foreground'>Start {formatTime(trace.started_at)}</p>
                  <p className='text-muted-foreground'>Correlation {trace.correlation_id}</p>
                </div>
              ))}

              {replays.slice(0, 10).map((replay) => (
                <div key={replay.id} className='rounded-lg border border-border bg-black/10 p-3 text-xs'>
                  <div className='flex items-center justify-between gap-2'>
                    <p className='font-medium'>Replay {replay.replay_type}</p>
                    <span className={replay.status === 'failed' ? 'text-red-300' : 'text-emerald-300'}>{replay.status}</span>
                  </div>
                  <p className='mt-1 text-muted-foreground'>Requested {formatTime(replay.requested_at)}</p>
                  {replay.error_message ? <p className='mt-1 text-red-300'>{replay.error_message}</p> : null}
                </div>
              ))}
            </div>
          </section>
        </div>

        <section className='rounded-xl border border-border bg-card p-4'>
          <h2 className='mb-3 text-sm font-semibold'>Queue Throughput Snapshot</h2>
          {queues.length === 0 ? (
            <p className='text-xs text-muted-foreground'>No queued jobs yet.</p>
          ) : (
            <div className='overflow-auto'>
              <table className='w-full min-w-[820px] text-xs'>
                <thead>
                  <tr className='border-b border-border text-left text-muted-foreground'>
                    <th className='py-2 pr-3 font-medium'>Queue</th>
                    <th className='py-2 pr-3 font-medium'>Task</th>
                    <th className='py-2 pr-3 font-medium'>Status</th>
                    <th className='py-2 pr-3 font-medium'>Attempts</th>
                    <th className='py-2 pr-3 font-medium'>Trace</th>
                    <th className='py-2 pr-3 font-medium'>Queued</th>
                    <th className='py-2 pr-3 font-medium'>Completed</th>
                    <th className='py-2 pr-3 font-medium'>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {queues.slice(0, 60).map((job) => (
                    <tr key={`${job.job_id}-${job.queue_name}`} className='border-b border-border/60 align-top'>
                      <td className='py-2 pr-3'>{job.queue_name}</td>
                      <td className='py-2 pr-3'>{job.task_type}</td>
                      <td className='py-2 pr-3'>{job.status}</td>
                      <td className='py-2 pr-3'>{job.attempts}/{job.max_attempts}</td>
                      <td className='py-2 pr-3 max-w-[220px] truncate'>{job.trace_id ?? '-'}</td>
                      <td className='py-2 pr-3'>{formatTime(job.queued_at)}</td>
                      <td className='py-2 pr-3'>{formatTime(job.completed_at)}</td>
                      <td className='py-2 pr-3 max-w-[260px] text-red-300 truncate'>{job.error_message ?? '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {summary && summary.deadLetters > 0 && (
          <div className='rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-xs text-amber-200'>
            <p className='flex items-center gap-2 font-medium'>
              <ShieldAlert className='h-4 w-4' />
              Dead-letter queue contains {summary.deadLetters} item(s). Use replay controls only after checking upstream causes.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}

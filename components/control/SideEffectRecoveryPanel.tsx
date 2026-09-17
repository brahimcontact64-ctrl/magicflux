'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { useControlApi } from './use-control-api';
import { useAutoRefresh } from './use-auto-refresh';

/**
 * Phase 9.9.14 -- Part H/I: the recovery control plane for a genuinely
 * indeterminate external side effect. Deliberately minimal: this is NOT a
 * generic "retry" button (Part H forbids that for an indeterminate outcome
 * -- it could duplicate a real Airtable row/Slack message/email). An
 * operator must state what they ALREADY confirmed by checking the
 * provider directly before either action is enabled.
 */

type SideEffect = {
  id: string;
  execution_id: string;
  workflow_id: string;
  node_id: string;
  effect_key: string;
  effect_type: string;
  status: string;
  attempts: number;
  provider_ref: unknown;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type SideEffectsResponse = { sideEffects: SideEffect[]; count: number };

function fmt(ts?: string | null) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

export function SideEffectRecoveryPanel() {
  const { get, post } = useControlApi();
  const [items, setItems] = useState<SideEffect[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [acting, setActing] = useState<string | null>(null);

  const load = useCallback(async (asRefresh = false) => {
    if (asRefresh) setRefreshing(true); else setLoading(true);
    const res = await get<SideEffectsResponse>('/api/runtime/control/side-effects');
    if (res) setItems(res.sideEffects ?? []);
    setLoading(false);
    setRefreshing(false);
  }, [get]);

  useEffect(() => { void load(); }, [load]);
  useAutoRefresh(() => void load(true), 20_000);

  const verify = useCallback(async (item: SideEffect, action: 'verify_succeeded' | 'verify_failed') => {
    const note = (notes[item.id] ?? '').trim();
    if (!note) {
      toast.error('Describe what you confirmed with the provider first (e.g. "checked Airtable, no duplicate record exists").');
      return;
    }
    setActing(item.id);
    const res = await post('/api/runtime/control/side-effects', {
      action,
      executionId: item.execution_id,
      nodeId: item.node_id,
      effectKey: item.effect_key,
      note,
    });
    setActing(null);
    if (res) {
      toast.success(action === 'verify_succeeded' ? 'Marked as succeeded.' : 'Marked as failed -- it can now be retried through the normal resume action.');
      void load(true);
    }
  }, [notes, post, load]);

  if (loading) {
    return <div className="space-y-2"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Side effects MagicFlux could not prove the outcome of (a network failure after the provider may have already
          received the request). Never retried automatically to avoid a duplicate -- resolve each one by checking the
          provider directly first.
        </p>
        <Button size="sm" variant="ghost" onClick={() => load(true)} disabled={refreshing}>
          <RefreshCw className={refreshing ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
        </Button>
      </div>

      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
          <p className="text-sm">No indeterminate side effects right now.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <div key={item.id} className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    {item.effect_type} · node {item.node_id}
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    execution {item.execution_id.slice(0, 8)} · {item.attempts} attempt(s) · last touched {fmt(item.updated_at)}
                  </p>
                  {item.last_error ? <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{item.last_error}</p> : null}
                </div>
              </div>
              <Textarea
                placeholder='What did you confirm directly with the provider? (required)'
                className="text-xs min-h-[50px]"
                value={notes[item.id] ?? ''}
                onChange={(e) => setNotes((prev) => ({ ...prev, [item.id]: e.target.value }))}
              />
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={acting === item.id} onClick={() => verify(item, 'verify_succeeded')}>
                  {acting === item.id ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
                  Mark verified succeeded
                </Button>
                <Button size="sm" variant="outline" disabled={acting === item.id} onClick={() => verify(item, 'verify_failed')}>
                  {acting === item.id ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
                  Mark verified failed (allow retry)
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

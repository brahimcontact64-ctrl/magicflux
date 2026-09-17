'use client';

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, XCircle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { supabase } from '@/lib/supabase-client';

type ReadinessCheck = { key: string; label: string; ok: boolean; messages: string[] };
type ReadinessSummary = { ready: boolean; checks: ReadinessCheck[] };

/**
 * Phase 9.9.16 -- Part M: a human-readable readiness summary shown before
 * Activate, reusing the exact checks activation itself runs (Part D --
 * server-side guards remain authoritative; this is a preview of them, not
 * a second implementation of them).
 */
export function ReadinessSummaryPanel({ workflowId, refreshToken }: { workflowId: string; refreshToken?: number }) {
  const [summary, setSummary] = useState<ReadinessSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) return;
      const res = await fetch(`/api/workflows/${workflowId}/readiness`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      if (res.ok) setSummary(await res.json());
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => { void load(); }, [load, refreshToken]);

  if (loading && !summary) return null;
  if (!summary) return null;

  return (
    <section className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Readiness</h2>
          <p className="text-xs text-muted-foreground mt-0.5">What Activate will check, before you click it.</p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => void load()} aria-label="Refresh readiness"><RefreshCw className={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} /></Button>
      </div>
      <div className="space-y-1.5">
        {summary.checks.map((c) => (
          <div key={c.key} className="text-xs">
            <div className="flex items-center gap-1.5">
              {c.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" /> : <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />}
              <span className={c.ok ? '' : 'font-medium'}>{c.label}</span>
            </div>
            {!c.ok && c.messages.length > 0 && (
              <ul className="ml-5 mt-0.5 list-disc text-[11px] text-muted-foreground">
                {c.messages.map((m, i) => <li key={i}>{m}</li>)}
              </ul>
            )}
          </div>
        ))}
      </div>
      {summary.ready ? (
        <p className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">Ready to activate.</p>
      ) : (
        <p className="text-xs text-muted-foreground">Resolve the items above, then Activate.</p>
      )}
    </section>
  );
}

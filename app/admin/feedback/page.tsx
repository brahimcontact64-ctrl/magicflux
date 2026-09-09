'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Loader2, MessageSquare, Star, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme-toggle';
import { supabase } from '@/lib/supabase-client';
import { cn } from '@/lib/utils';

type AccessState = 'checking' | 'allowed' | 'forbidden' | 'unauthorized' | 'not_configured';

type FeedbackRow = {
  id: string;
  user_id: string | null;
  category: 'general' | 'bug' | 'feature_request';
  rating: number | null;
  comment: string | null;
  page_path: string | null;
  app_version: string | null;
  status: 'new' | 'reviewed' | 'resolved' | 'archived';
  created_at: string;
};

const STATUS_OPTIONS: FeedbackRow['status'][] = ['new', 'reviewed', 'resolved', 'archived'];

export default function AdminFeedbackPage() {
  const [state, setState] = useState<AccessState>('checking');
  const [rows, setRows] = useState<FeedbackRow[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return setState('unauthorized');

    const res = await fetch('/api/admin/feedback', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
    if (res.status === 401) return setState('unauthorized');
    if (res.status === 403) return setState('forbidden');
    if (res.status === 503) return setState('not_configured');

    const payload = await res.json().catch(() => ({})) as { rows?: FeedbackRow[] };
    setRows(payload.rows ?? []);
    setState('allowed');
  }, []);

  useEffect(() => { load(); }, [load]);

  async function updateStatus(id: string, status: FeedbackRow['status']) {
    setBusyId(id);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) return;
      await fetch('/api/admin/feedback', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ id, status }),
      });
      setRows((prev) => prev.map((r) => (r.id === id ? { ...r, status } : r)));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="flex h-14 items-center gap-4 border-b border-border bg-card/50 px-6">
        <Link href="/" className="group flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary transition-transform group-hover:scale-105">
            <Zap className="h-3.5 w-3.5 text-primary-foreground" fill="currentColor" />
          </div>
          <span className="text-sm font-semibold">MagicFlux</span>
        </Link>
        <div className="h-4 w-px bg-border" />
        <span className="text-xs text-muted-foreground">Feedback Inbox</span>
        <div className="flex-1" />
        <ThemeToggle />
        <Link href="/admin">
          <Button variant="ghost" size="sm" className="gap-2 text-muted-foreground">
            <ArrowLeft className="h-3.5 w-3.5" />
            Back
          </Button>
        </Link>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-10">
        {state === 'checking' && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking admin access...
          </div>
        )}
        {state === 'unauthorized' && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-6">
            <p className="text-sm font-semibold text-amber-300">Sign-in required</p>
          </div>
        )}
        {state === 'forbidden' && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-6">
            <p className="text-sm font-semibold text-red-300">Admin access denied</p>
          </div>
        )}
        {state === 'not_configured' && (
          <div className="rounded-xl border border-border bg-card p-6">
            <p className="text-sm font-semibold">Feedback isn&apos;t configured yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              The product_feedback migration hasn&apos;t been applied to this database yet.
            </p>
          </div>
        )}

        {state === 'allowed' && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-primary" />
              <h1 className="text-lg font-semibold">Feedback ({rows.length})</h1>
            </div>

            {rows.length === 0 && <p className="text-sm text-muted-foreground">No feedback submitted yet.</p>}

            {rows.map((row) => (
              <div key={row.id} className="rounded-xl border border-border bg-card p-4">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="rounded-full border border-border px-2 py-0.5 uppercase tracking-wide">{row.category.replace('_', ' ')}</span>
                  {row.rating != null && (
                    <span className="flex items-center gap-0.5">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <Star key={i} className={cn('h-3 w-3', i < row.rating! ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/40')} />
                      ))}
                    </span>
                  )}
                  <span>{new Date(row.created_at).toLocaleString()}</span>
                  {row.page_path && <span className="truncate">· {row.page_path}</span>}
                </div>
                {row.comment && <p className="mt-2 text-sm">{row.comment}</p>}
                <div className="mt-3 flex items-center gap-1.5">
                  {STATUS_OPTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => updateStatus(row.id, s)}
                      disabled={busyId === row.id}
                      className={cn(
                        'rounded-md border px-2 py-1 text-[11px] transition-colors',
                        row.status === s ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted/40',
                      )}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Zap, ArrowLeft, Inbox, RefreshCw, ChevronDown, Mail, Clock, CircleCheck as CheckCircle2, CircleAlert as AlertCircle, Circle as XCircle, ExternalLink, Search, Filter } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme-toggle';
import { supabase } from '@/lib/supabase-client';
import { cn } from '@/lib/utils';

type RequestStatus = 'open' | 'in_progress' | 'resolved' | 'cancelled';

interface ManagedRequest {
  id: string;
  template_id: string | null;
  template_name: string | null;
  request_type: string;
  description: string;
  contact_email: string;
  status: RequestStatus;
  created_at: string;
  resolution_notes: string | null;
}

const STATUS_CONFIG: Record<RequestStatus, { label: string; icon: React.ElementType; color: string; bg: string }> = {
  open: { label: 'New', icon: Inbox, color: 'text-blue-400', bg: 'bg-blue-500/10 border-blue-500/20' },
  in_progress: { label: 'In Progress', icon: Clock, color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/20' },
  resolved: { label: 'Delivered', icon: CheckCircle2, color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20' },
  cancelled: { label: 'Cancelled', icon: XCircle, color: 'text-muted-foreground', bg: 'bg-muted/30 border-border' },
};

const STATUS_ORDER: RequestStatus[] = ['open', 'in_progress', 'resolved', 'cancelled'];

function StatusBadge({ status }: { status: RequestStatus }) {
  const cfg = STATUS_CONFIG[status];
  const Icon = cfg.icon;
  return (
    <span className={cn('inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-xs font-medium', cfg.bg, cfg.color)}>
      <Icon className="w-3 h-3" />
      {cfg.label}
    </span>
  );
}

function StatusDropdown({ current, onChange }: { current: RequestStatus; onChange: (s: RequestStatus) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronDown className="w-3 h-3" />
        Change
      </button>
      {open && (
        <div className="absolute right-0 top-6 z-10 w-36 rounded-lg border border-border bg-card shadow-lg shadow-black/20 overflow-hidden">
          {STATUS_ORDER.map(s => {
            const SCfg = STATUS_CONFIG[s];
            const SIcon = SCfg.icon;
            return (
              <button
                key={s}
                onClick={() => { onChange(s); setOpen(false); }}
                className={cn(
                  'w-full text-left px-3 py-2 text-xs hover:bg-muted/50 transition-colors flex items-center gap-2',
                  s === current && 'bg-muted/30'
                )}
              >
                <SIcon className={cn('w-3 h-3', SCfg.color)} />
                {SCfg.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function formatDate(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return 'Just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function RequestsDashboard() {
  const [requests, setRequests] = useState<ManagedRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState<RequestStatus | 'all'>('all');
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('managed_requests')
      .select('id, template_id, template_name, request_type, description, contact_email, status, created_at, resolution_notes')
      .order('created_at', { ascending: false });
    setRequests((data as ManagedRequest[]) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  async function updateStatus(id: string, status: RequestStatus) {
    setUpdatingId(id);
    await supabase.from('managed_requests').update({ status }).eq('id', id);
    setRequests(prev => prev.map(r => r.id === id ? { ...r, status } : r));
    setUpdatingId(null);
  }

  const filtered = requests.filter(r => {
    const matchStatus = filterStatus === 'all' || r.status === filterStatus;
    const q = search.toLowerCase();
    const matchSearch = !q || r.contact_email.toLowerCase().includes(q) || (r.template_name ?? '').toLowerCase().includes(q) || r.description.toLowerCase().includes(q);
    return matchStatus && matchSearch;
  });

  const counts = STATUS_ORDER.reduce((acc, s) => ({ ...acc, [s]: requests.filter(r => r.status === s).length }), {} as Record<RequestStatus, number>);

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="h-14 border-b border-border bg-card/50 backdrop-blur sticky top-0 z-10 flex items-center px-6 gap-4">
        <Link href="/" className="flex items-center gap-2 group">
          <div className="w-7 h-7 rounded-md bg-primary flex items-center justify-center group-hover:scale-105 transition-transform">
            <Zap className="w-3.5 h-3.5 text-primary-foreground" fill="currentColor" />
          </div>
          <span className="font-semibold text-sm">MagicFlux</span>
        </Link>
        <div className="w-px h-4 bg-border" />
        <Link href="/admin" className="text-xs text-muted-foreground hover:text-foreground transition-colors">Admin</Link>
        <span className="text-xs text-muted-foreground">/</span>
        <span className="text-xs font-medium">Requests</span>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={fetchRequests} disabled={loading} className="gap-1.5 text-xs text-muted-foreground">
          <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
          Refresh
        </Button>
        <ThemeToggle />
        <Link href="/admin">
          <Button variant="ghost" size="sm" className="gap-2 text-muted-foreground">
            <ArrowLeft className="w-3.5 h-3.5" />
            Back
          </Button>
        </Link>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-8">
        {/* Page title */}
        <div className="mb-6">
          <h1 className="text-xl font-bold">Managed Requests</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{requests.length} total requests</p>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          {STATUS_ORDER.map(s => {
            const cfg = STATUS_CONFIG[s];
            const Icon = cfg.icon;
            return (
              <button
                key={s}
                onClick={() => setFilterStatus(filterStatus === s ? 'all' : s)}
                className={cn(
                  'rounded-xl border p-3 text-left transition-all hover:-translate-y-0.5',
                  filterStatus === s ? cfg.bg : 'border-border bg-card hover:border-primary/20'
                )}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <Icon className={cn('w-4 h-4', cfg.color)} />
                  <span className="text-lg font-bold">{counts[s] ?? 0}</span>
                </div>
                <p className="text-xs text-muted-foreground">{cfg.label}</p>
              </button>
            );
          })}
        </div>

        {/* Filters */}
        <div className="flex gap-3 mb-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search by email, template, or description..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-border bg-background focus:outline-none focus:border-primary transition-colors"
            />
          </div>
          {filterStatus !== 'all' && (
            <Button variant="outline" size="sm" onClick={() => setFilterStatus('all')} className="gap-1.5 text-xs">
              <Filter className="w-3.5 h-3.5" />
              Clear filter
            </Button>
          )}
        </div>

        {/* Request list */}
        {loading ? (
          <div className="space-y-3">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-20 rounded-xl border border-border bg-card animate-pulse" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-12 text-center">
            <Inbox className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm font-medium">No requests found</p>
            <p className="text-xs text-muted-foreground mt-1">
              {requests.length === 0 ? 'Requests will appear here once customers submit them.' : 'Try clearing your search or filter.'}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map(req => {
              const isExpanded = expandedId === req.id;
              const isUpdating = updatingId === req.id;
              return (
                <div
                  key={req.id}
                  className={cn(
                    'rounded-xl border bg-card overflow-hidden transition-all duration-200',
                    isExpanded ? 'border-primary/30' : 'border-border hover:border-primary/20'
                  )}
                >
                  {/* Row */}
                  <div
                    className="flex items-center gap-4 px-4 py-3 cursor-pointer"
                    onClick={() => setExpandedId(isExpanded ? null : req.id)}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <p className="text-sm font-medium truncate">{req.template_name ?? req.template_id ?? 'Custom request'}</p>
                        <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded font-mono flex-shrink-0">
                          {req.request_type}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Mail className="w-3 h-3" />
                          {req.contact_email}
                        </span>
                        <span>{formatDate(req.created_at)}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      <StatusBadge status={req.status} />
                      <div onClick={e => e.stopPropagation()}>
                        <StatusDropdown
                          current={req.status}
                          onChange={s => updateStatus(req.id, s)}
                        />
                      </div>
                      {isUpdating && <RefreshCw className="w-3 h-3 text-muted-foreground animate-spin" />}
                    </div>
                  </div>

                  {/* Expanded detail */}
                  {isExpanded && (
                    <div className="border-t border-border bg-muted/20 px-4 py-4 space-y-3">
                      <div>
                        <p className="text-xs font-medium text-muted-foreground mb-1 uppercase tracking-wider">Description</p>
                        <p className="text-sm leading-relaxed">{req.description}</p>
                      </div>
                      <div className="grid grid-cols-2 gap-4 text-xs">
                        <div>
                          <p className="text-muted-foreground mb-0.5">Request ID</p>
                          <p className="font-mono text-foreground">{req.id}</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground mb-0.5">Submitted</p>
                          <p className="text-foreground">{new Date(req.created_at).toLocaleString()}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 pt-1">
                        <a
                          href={`mailto:${req.contact_email}?subject=Your ${req.template_name ?? 'automation'} request — update`}
                          className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
                        >
                          <Mail className="w-3 h-3" />
                          Email customer
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

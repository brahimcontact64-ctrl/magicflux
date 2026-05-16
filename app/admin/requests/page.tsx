'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Zap,
  ArrowLeft,
  Inbox,
  RefreshCw,
  Mail,
  ExternalLink,
  Search,
  Eye,
  Loader2,
  Sparkles,
  Rocket,
  CircleCheck as CheckCircle2,
  CircleDot,
  CircleDashed,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme-toggle';
import { supabase } from '@/lib/supabase-client';
import { cn } from '@/lib/utils';
import { apiRequest } from '@/lib/api/client';

type RequestStatus = 'new' | 'generated' | 'deployed';

type ManagedRequest = {
  id: string;
  user_id: string | null;
  template_id: string | null;
  template_name: string | null;
  request_type: string;
  description: string;
  contact_email: string;
  status: RequestStatus;
  created_at: string;
  workflow_json: Record<string, unknown> | null;
  workflow_id: string | null;
  required_integrations?: string[];
  missing_integrations?: string[];
};

type ActionState = {
  generating: boolean;
  deploying: boolean;
};

const STATUS_CONFIG: Record<RequestStatus, { label: string; icon: React.ElementType; color: string; bg: string }> = {
  new: {
    label: 'New',
    icon: CircleDot,
    color: 'text-blue-400',
    bg: 'bg-blue-500/10 border-blue-500/20',
  },
  generated: {
    label: 'Generated',
    icon: CircleDashed,
    color: 'text-amber-400',
    bg: 'bg-amber-500/10 border-amber-500/20',
  },
  deployed: {
    label: 'Deployed',
    icon: CheckCircle2,
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/10 border-emerald-500/20',
  },
};

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
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [previewRequestId, setPreviewRequestId] = useState<string | null>(null);
  const [actionState, setActionState] = useState<Record<string, ActionState>>({});

  const withAuthHeaders = useCallback(async (): Promise<HeadersInit | null> => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) {
      toast.error('Session expired. Please sign in again.');
      return null;
    }

    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };
  }, []);

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    try {
      const headers = await withAuthHeaders();
      if (!headers) {
        setLoading(false);
        return;
      }

      const payload = await apiRequest<{ requests?: ManagedRequest[] }>(
        '/api/admin/requests',
        {
        method: 'GET',
        headers,
        cache: 'no-store',
        },
        'Failed to fetch requests'
      );

      setRequests(payload?.requests ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to fetch requests');
    } finally {
      setLoading(false);
    }
  }, [withAuthHeaders]);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  const setRequestAction = useCallback((requestId: string, patch: Partial<ActionState>) => {
    setActionState(prev => ({
      ...prev,
      [requestId]: {
        generating: prev[requestId]?.generating ?? false,
        deploying: prev[requestId]?.deploying ?? false,
        ...patch,
      },
    }));
  }, []);

  const handleGenerate = useCallback(async (requestId: string) => {
    setRequestAction(requestId, { generating: true });

    try {
      const headers = await withAuthHeaders();
      if (!headers) return;

      const payload = await apiRequest<{
        workflow_json?: Record<string, unknown>;
        status?: RequestStatus;
        missingIntegrations?: string[];
      }>(
        '/api/admin/generate',
        {
        method: 'POST',
        headers,
        body: JSON.stringify({ requestId }),
        },
        'AI generation failed'
      );

      setRequests(prev => prev.map(r => (
        r.id === requestId
          ? {
              ...r,
              status: payload?.status ?? 'generated',
              workflow_json: payload?.workflow_json ?? r.workflow_json,
              missing_integrations: payload?.missingIntegrations ?? r.missing_integrations,
            }
          : r
      )));

      toast.success('Workflow draft generated successfully');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'AI generation failed');
    } finally {
      setRequestAction(requestId, { generating: false });
    }
  }, [setRequestAction, withAuthHeaders]);

  const handleDeploy = useCallback(async (requestId: string) => {
    setRequestAction(requestId, { deploying: true });

    try {
      const headers = await withAuthHeaders();
      if (!headers) return;

      const payload = await apiRequest<{
        workflow_id?: string;
        status?: RequestStatus;
      }>(
        '/api/admin/deploy',
        {
        method: 'POST',
        headers,
        body: JSON.stringify({ requestId }),
        },
        'Deployment failed'
      );

      setRequests(prev => prev.map(r => (
        r.id === requestId
          ? {
              ...r,
              status: payload?.status ?? 'deployed',
              workflow_id: payload?.workflow_id ?? r.workflow_id,
            }
          : r
      )));

      toast.success('Workflow deployed to n8n');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Deployment failed');
    } finally {
      setRequestAction(requestId, { deploying: false });
    }
  }, [setRequestAction, withAuthHeaders]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return requests;
    return requests.filter(r => (
      r.contact_email.toLowerCase().includes(q)
      || (r.template_name ?? '').toLowerCase().includes(q)
      || r.description.toLowerCase().includes(q)
      || r.status.toLowerCase().includes(q)
    ));
  }, [requests, search]);

  const previewRequest = useMemo(
    () => requests.find(r => r.id === previewRequestId) ?? null,
    [previewRequestId, requests]
  );

  return (
    <div className="min-h-screen bg-background">
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
        <div className="mb-6">
          <h1 className="text-xl font-bold">Managed Requests</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{requests.length} total requests</p>
        </div>

        <div className="flex gap-3 mb-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search by email, template, description, or status..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-border bg-background focus:outline-none focus:border-primary transition-colors"
            />
          </div>
        </div>

        {loading ? (
          <div className="space-y-3">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-24 rounded-xl border border-border bg-card animate-pulse" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-12 text-center">
            <Inbox className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm font-medium">No requests found</p>
            <p className="text-xs text-muted-foreground mt-1">
              {requests.length === 0 ? 'Requests will appear here once customers submit them.' : 'Try adjusting your search.'}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map(req => {
              const isExpanded = expandedId === req.id;
              const state = actionState[req.id] ?? { generating: false, deploying: false };
              const missingIntegrations = req.missing_integrations ?? [];
              const canPreview = !!req.workflow_json;
              const canDeploy = req.status === 'generated' && !!req.workflow_json && !state.generating && missingIntegrations.length === 0;

              return (
                <div
                  key={req.id}
                  className={cn(
                    'rounded-xl border bg-card overflow-hidden transition-all duration-200',
                    isExpanded ? 'border-primary/30' : 'border-border hover:border-primary/20'
                  )}
                >
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
                        {req.workflow_id && (
                          <span className="text-emerald-400 font-mono">n8n: {req.workflow_id}</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <StatusBadge status={req.status} />
                      {(state.generating || state.deploying) && <Loader2 className="w-3 h-3 text-muted-foreground animate-spin" />}
                    </div>
                  </div>

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

                      <div className="flex flex-wrap gap-2 pt-1">
                        <Button
                          size="sm"
                          className="h-8 gap-1.5"
                          onClick={() => handleGenerate(req.id)}
                          disabled={state.generating || state.deploying}
                        >
                          {state.generating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                          Generate workflow draft
                        </Button>

                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 gap-1.5"
                          onClick={() => setPreviewRequestId(req.id)}
                          disabled={!canPreview || state.generating || state.deploying}
                        >
                          <Eye className="w-3.5 h-3.5" />
                          Preview workflow JSON
                        </Button>

                        <Button
                          size="sm"
                          variant="secondary"
                          className="h-8 gap-1.5"
                          onClick={() => handleDeploy(req.id)}
                          disabled={!canDeploy || state.deploying}
                        >
                          {state.deploying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Rocket className="w-3.5 h-3.5" />}
                          Deploy to n8n
                        </Button>

                        {missingIntegrations.length > 0 && (
                          <Link href="/settings/integrations" className="inline-flex items-center gap-1.5 text-xs text-amber-400 hover:text-amber-300 transition-colors px-2">
                            Deploy only after customer integrations are connected: {missingIntegrations.join(', ')}
                          </Link>
                        )}

                        <a
                          href={`mailto:${req.contact_email}?subject=Your ${req.template_name ?? 'automation'} request — update`}
                          className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline px-2"
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

      {previewRequest && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-4xl max-h-[85vh] rounded-2xl border border-border bg-card overflow-hidden flex flex-col">
            <div className="h-12 px-4 border-b border-border flex items-center justify-between">
              <div className="text-sm font-medium">Workflow Preview JSON</div>
              <Button variant="ghost" size="sm" onClick={() => setPreviewRequestId(null)}>Close</Button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              <pre className="text-xs leading-relaxed whitespace-pre-wrap break-words bg-muted/30 border border-border rounded-lg p-3">
                {JSON.stringify(previewRequest.workflow_json, null, 2)}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

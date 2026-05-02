'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Zap, Activity, CircleCheck as CheckCircle2, Circle as XCircle, Clock, RefreshCw, ArrowLeft, Play, Pause, Trash2, ExternalLink, ChevronDown, Brain, Layers, ChartBar as BarChart3, Plus, TriangleAlert as AlertTriangle, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme-toggle';
import { supabase } from '@/lib/supabase-client';
import { cn } from '@/lib/utils';

interface WorkflowExecution {
  id: string;
  plan_id: string | null;
  session_id: string;
  n8n_workflow_id: string;
  n8n_instance_url: string;
  status: 'pending' | 'deploying' | 'active' | 'paused' | 'failed' | 'deleted';
  workflow_name: string;
  error_message: string | null;
  deployed_at: string | null;
  activated_at: string | null;
  created_at: string;
}

interface AutomationPlanRecord {
  id: string;
  prompt: string;
  pattern: string;
  trigger_type: string;
  complexity: string;
  estimated_nodes: number;
  confidence: number;
  validation_score: number;
  is_valid: boolean;
  integrations: string[];
  created_at: string;
}

const STATUS_CONFIG = {
  pending:   { label: 'Draft — Setup Required', color: 'text-amber-400',         bg: 'bg-amber-500/10 border-amber-500/20',    icon: Clock },
  deploying: { label: 'Deploying',              color: 'text-amber-400',         bg: 'bg-amber-500/10 border-amber-500/20',    icon: RefreshCw },
  active:    { label: 'Active',                 color: 'text-emerald-400',       bg: 'bg-emerald-500/10 border-emerald-500/20', icon: CheckCircle2 },
  paused:    { label: 'Paused',                 color: 'text-amber-400',         bg: 'bg-amber-500/10 border-amber-500/20',    icon: Pause },
  failed:    { label: 'Failed',                 color: 'text-red-400',           bg: 'bg-red-500/10 border-red-500/20',        icon: XCircle },
  deleted:   { label: 'Deleted',               color: 'text-muted-foreground',  bg: 'bg-muted/30 border-border',              icon: Trash2 }
} as const;

const LIFECYCLE_STAGES: Array<{ key: string; label: string; activeColor: string }> = [
  { key: 'draft',                label: 'Draft',         activeColor: 'text-blue-400 bg-blue-500/20 border-blue-500/30' },
  { key: 'credentials_required', label: 'Credentials',  activeColor: 'text-amber-400 bg-amber-500/20 border-amber-500/30' },
  { key: 'ready',                label: 'Ready',         activeColor: 'text-cyan-400 bg-cyan-500/20 border-cyan-500/30' },
  { key: 'active',               label: 'Active',        activeColor: 'text-emerald-400 bg-emerald-500/20 border-emerald-500/30' },
];

const COMPLEXITY_COLORS: Record<string, string> = {
  simple:   'text-emerald-400',
  moderate: 'text-amber-400',
  complex:  'text-red-400'
};

function formatDate(iso: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return 'Just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function StatusBadge({ status }: { status: WorkflowExecution['status'] }) {
  const cfg = STATUS_CONFIG[status];
  const Icon = cfg.icon;
  return (
    <span className={cn('inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-xs font-medium', cfg.bg, cfg.color)}>
      <Icon className={cn('w-3 h-3', status === 'deploying' && 'animate-spin')} />
      {cfg.label}
    </span>
  );
}

export default function DashboardPage() {
  const [executions, setExecutions] = useState<WorkflowExecution[]>([]);
  const [plans, setPlans] = useState<AutomationPlanRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'deployments' | 'plans'>('deployments');
  const [n8nConfigured, setN8nConfigured] = useState<boolean | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);

    // Check n8n configuration status via API
    const n8nCheck = fetch('/api/n8n?action=list').then(r => r.json()).catch(() => ({ configured: false }));

    const [execRes, planRes, n8nStatus] = await Promise.all([
      supabase
        .from('workflow_executions')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50),
      supabase
        .from('automation_plans')
        .select('id, prompt, pattern, trigger_type, complexity, estimated_nodes, confidence, validation_score, is_valid, integrations, created_at')
        .order('created_at', { ascending: false })
        .limit(50),
      n8nCheck
    ]);

    setN8nConfigured(n8nStatus?.configured !== false);
    setExecutions((execRes.data as WorkflowExecution[]) ?? []);
    setPlans((planRes.data as AutomationPlanRecord[]) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Only count n8n-confirmed active workflows — not pending/draft
  const activeCount = executions.filter(e => e.status === 'active').length;
  const draftCount = executions.filter(e => e.status === 'pending').length;
  const failedCount = executions.filter(e => e.status === 'failed').length;
  const totalPlans = plans.length;

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
        <span className="text-xs font-medium text-muted-foreground">Execution Dashboard</span>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={fetchData} disabled={loading} className="gap-1.5 text-xs text-muted-foreground">
          <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
          Refresh
        </Button>
        <ThemeToggle />
        <Link href="/builder">
          <Button size="sm" className="gap-1.5 text-xs">
            <Plus className="w-3.5 h-3.5" />
            New Workflow
          </Button>
        </Link>
        <Link href="/">
          <Button variant="ghost" size="sm" className="gap-2 text-muted-foreground">
            <ArrowLeft className="w-3.5 h-3.5" />
            Home
          </Button>
        </Link>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-8">
        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
          {[
            { label: 'Total Plans', value: totalPlans, icon: Brain, color: 'text-primary' },
            { label: 'Drafts', value: draftCount, icon: Clock, color: 'text-amber-400' },
            { label: 'Active (n8n confirmed)', value: activeCount, icon: CheckCircle2, color: 'text-emerald-400' },
            { label: 'Failed', value: failedCount, icon: XCircle, color: 'text-red-400' }
          ].map(stat => {
            const Icon = stat.icon;
            return (
              <div key={stat.label} className="rounded-xl border border-border bg-card p-4">
                <div className="flex items-center justify-between mb-2">
                  <Icon className={cn('w-4 h-4', stat.color)} />
                  <span className="text-2xl font-bold">{stat.value}</span>
                </div>
                <p className="text-xs text-muted-foreground">{stat.label}</p>
              </div>
            );
          })}
        </div>

        {/* Tab bar */}
        <div className="flex gap-1 p-1 rounded-lg bg-muted/20 border border-border mb-6 w-fit">
          <button
            onClick={() => setActiveTab('deployments')}
            className={cn(
              'px-4 py-1.5 rounded-md text-sm font-medium transition-colors',
              activeTab === 'deployments' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            Deployments
          </button>
          <button
            onClick={() => setActiveTab('plans')}
            className={cn(
              'px-4 py-1.5 rounded-md text-sm font-medium transition-colors',
              activeTab === 'plans' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            Generated Plans
          </button>
        </div>

        {/* Deployments tab */}
        {activeTab === 'deployments' && (
          loading ? (
            <div className="space-y-3">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="h-20 rounded-xl border border-border bg-card animate-pulse" />
              ))}
            </div>
          ) : executions.length === 0 ? (
            n8nConfigured === false ? (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-12 text-center">
                <Settings className="w-8 h-8 text-amber-400 mx-auto mb-3" />
                <p className="text-sm font-semibold text-amber-400 mb-1">n8n not configured</p>
                <p className="text-xs text-muted-foreground mb-2 max-w-sm mx-auto">
                  Deployment tracking requires a connected n8n instance. Set <code className="font-mono text-xs bg-muted px-1 rounded">N8N_API_URL</code> and <code className="font-mono text-xs bg-muted px-1 rounded">N8N_API_KEY</code> in your environment to enable live deployments.
                </p>
                <p className="text-xs text-muted-foreground mb-4">
                  You can still generate and download workflow packages from the builder.
                </p>
                <Link href="/builder">
                  <Button size="sm" variant="outline" className="gap-1.5">
                    <Plus className="w-3.5 h-3.5" />
                    Build a Workflow
                  </Button>
                </Link>
              </div>
            ) : (
              <div className="rounded-xl border border-border bg-card p-12 text-center">
                <Activity className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
                <p className="text-sm font-medium mb-1">No deployments yet</p>
                <p className="text-xs text-muted-foreground mb-4">
                  Deploy your first workflow from the builder to see it here.
                </p>
                <Link href="/builder">
                  <Button size="sm" className="gap-1.5">
                    <Plus className="w-3.5 h-3.5" />
                    Build a Workflow
                  </Button>
                </Link>
              </div>
            )
          ) : (
            <div className="space-y-3">
              {executions.map(exec => {
                const cfg = STATUS_CONFIG[exec.status];
                // Determine lifecycle stage from stored status
                const lifecycleStage: string =
                  exec.status === 'active' ? 'active' :
                  exec.status === 'failed' ? 'failed' :
                  exec.status === 'pending' ? 'draft' :
                  exec.status === 'paused' ? 'ready' :
                  'draft';

                return (
                  <div key={exec.id} className="rounded-xl border border-border bg-card p-4">
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <p className="text-sm font-medium truncate">{exec.workflow_name || 'Unnamed Workflow'}</p>
                          <StatusBadge status={exec.status} />
                        </div>
                        <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                          {exec.n8n_workflow_id && (
                            <span className="font-mono">ID: {exec.n8n_workflow_id.slice(0, 8)}…</span>
                          )}
                          <span>Created {formatDate(exec.created_at)}</span>
                          {exec.activated_at && (
                            <span className="text-emerald-400">Active since {formatDate(exec.activated_at)}</span>
                          )}
                        </div>
                        {exec.error_message && (
                          <p className="text-xs text-red-400 mt-1 flex items-center gap-1">
                            <AlertTriangle className="w-3 h-3" />
                            {exec.error_message}
                          </p>
                        )}
                      </div>
                      {exec.n8n_workflow_id && exec.n8n_instance_url && (
                        <a
                          href={`${exec.n8n_instance_url}/workflow/${exec.n8n_workflow_id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors flex-shrink-0"
                          title="Open in n8n"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      )}
                    </div>

                    {/* Lifecycle progress bar — only for non-deleted/failed */}
                    {exec.status !== 'deleted' && exec.status !== 'failed' && (
                      <div className="flex items-center gap-1">
                        {LIFECYCLE_STAGES.map((stage, i) => {
                          const stageOrder = ['draft', 'credentials_required', 'ready', 'active'];
                          const currentIdx = stageOrder.indexOf(lifecycleStage);
                          const stageIdx = stageOrder.indexOf(stage.key);
                          const isDone = stageIdx < currentIdx;
                          const isCurrent = stage.key === lifecycleStage;

                          return (
                            <div key={stage.key} className="flex items-center gap-1 flex-1">
                              <div className={cn(
                                'flex-1 text-center text-[10px] px-1.5 py-1 rounded border font-medium transition-colors',
                                isDone
                                  ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                                  : isCurrent
                                  ? stage.activeColor
                                  : 'bg-muted/20 border-border text-muted-foreground/40'
                              )}>
                                {isDone ? '✓ ' : ''}{stage.label}
                              </div>
                              {i < LIFECYCLE_STAGES.length - 1 && (
                                <div className={cn('w-3 h-px flex-shrink-0', isDone ? 'bg-emerald-500/40' : 'bg-border')} />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Pending status helper text */}
                    {exec.status === 'pending' && (
                      <p className="text-[11px] text-amber-400 mt-2">
                        Deployed as inactive draft — link credentials in n8n, then activate.
                      </p>
                    )}
                    {exec.status === 'active' && (
                      <p className="text-[11px] text-emerald-400 mt-2">
                        Confirmed active by n8n — workflow is processing events.
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )
        )}

        {/* Plans tab */}
        {activeTab === 'plans' && (
          loading ? (
            <div className="space-y-3">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="h-20 rounded-xl border border-border bg-card animate-pulse" />
              ))}
            </div>
          ) : plans.length === 0 ? (
            <div className="rounded-xl border border-border bg-card p-12 text-center">
              <Brain className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm font-medium mb-1">No plans generated yet</p>
              <p className="text-xs text-muted-foreground mb-4">
                Use the builder to generate automation plans.
              </p>
              <Link href="/builder">
                <Button size="sm" className="gap-1.5">
                  <Plus className="w-3.5 h-3.5" />
                  Open Builder
                </Button>
              </Link>
            </div>
          ) : (
            <div className="space-y-3">
              {plans.map(plan => (
                <div key={plan.id} className="rounded-xl border border-border bg-card p-4">
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{plan.pattern}</p>
                      <p className="text-xs text-muted-foreground truncate mt-0.5">{plan.prompt}</p>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className={cn('text-xs font-medium', COMPLEXITY_COLORS[plan.complexity])}>
                        {plan.complexity}
                      </span>
                      {plan.is_valid ? (
                        <span className="text-xs px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                          Valid
                        </span>
                      ) : (
                        <span className="text-xs px-1.5 py-0.5 rounded-full bg-red-500/10 text-red-400 border border-red-500/20">
                          Issues
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                    <span>{plan.estimated_nodes} nodes</span>
                    <span>{plan.trigger_type} trigger</span>
                    <span>Score {plan.validation_score}/100</span>
                    <span>{plan.confidence}% confidence</span>
                    {plan.integrations.length > 0 && (
                      <span>{plan.integrations.slice(0, 2).join(', ')}{plan.integrations.length > 2 ? ` +${plan.integrations.length - 2}` : ''}</span>
                    )}
                    <span className="ml-auto">{formatDate(plan.created_at)}</span>
                  </div>
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </div>
  );
}

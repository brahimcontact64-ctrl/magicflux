'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Activity, ArrowLeft, Loader2, Plus, RefreshCw, Zap } from 'lucide-react';
import { supabase } from '@/lib/supabase-client';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { ExecutionStatusBadge } from '@/components/app/execution-status-badge';
import { UsageSummaryWidget } from '@/components/billing/usage-summary';

type Workflow = {
  id: string;
  name: string;
  description: string;
  integrations: string[];
  status: 'draft' | 'deployed';
  updated_at: string;
};

type Execution = {
  id: string;
  workflow_id: string;
  status: 'running' | 'waiting' | 'success' | 'failed' | 'cancelled';
  mode: 'test' | 'live';
  current_node_id: string | null;
  next_run_at: string | null;
  started_at: string;
  completed_at: string | null;
};

type IntegrationRow = {
  provider: string;
  status: 'connected' | 'invalid' | 'not_connected';
};

function formatDate(iso: string | null | undefined) {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleString();
}

export default function DashboardPage() {
  const [loading, setLoading] = useState(true);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationRow[]>([]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [workflowRes, executionRes, integrationRes] = await Promise.all([
        supabase
          .from('workflows')
          .select('id, name, description, integrations, status, updated_at')
          .order('updated_at', { ascending: false }),
        supabase
          .from('workflow_executions_v2')
          .select('id, workflow_id, status, mode, current_node_id, next_run_at, started_at, completed_at')
          .order('started_at', { ascending: false })
          .limit(200),
        fetch('/api/integrations', { cache: 'no-store' }),
      ]);

      setWorkflows((workflowRes.data ?? []) as Workflow[]);
      setExecutions((executionRes.data ?? []) as Execution[]);

      if (integrationRes.ok) {
        const payload = (await integrationRes.json().catch(() => ({}))) as { integrations?: IntegrationRow[] };
        setIntegrations(payload.integrations ?? []);
      } else {
        setIntegrations([]);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const connectedProviders = useMemo(
    () => new Set(integrations.filter((i) => i.status === 'connected').map((i) => i.provider)),
    [integrations]
  );

  const latestByWorkflow = useMemo(() => {
    const map = new Map<string, Execution>();
    for (const exec of executions) {
      if (!map.has(exec.workflow_id)) map.set(exec.workflow_id, exec);
    }
    return map;
  }, [executions]);

  const stats = useMemo(() => {
    const drafts = workflows.filter((w) => w.status === 'draft').length;
    const deployed = workflows.filter((w) => w.status === 'deployed').length;

    let simulatedTested = 0;
    let failed = 0;
    for (const wf of workflows) {
      const latest = latestByWorkflow.get(wf.id);
      if (!latest) continue;
      if (latest.mode === 'test' && latest.status === 'success') simulatedTested += 1;
      if (latest.status === 'failed') failed += 1;
    }

    return {
      totalWorkflows: workflows.length,
      drafts,
      deployed,
      simulatedTested,
      failed,
      integrationsUsed: connectedProviders.size,
    };
  }, [workflows, latestByWorkflow, connectedProviders]);

  return (
    <div className='min-h-screen bg-background'>
      <header className='sticky top-0 z-10 flex h-14 items-center gap-4 border-b border-border bg-card/50 px-6 backdrop-blur'>
        <Link href='/' className='group flex items-center gap-2'>
          <div className='flex h-7 w-7 items-center justify-center rounded-md bg-primary transition-transform group-hover:scale-105'>
            <Zap className='h-3.5 w-3.5 text-primary-foreground' fill='currentColor' />
          </div>
          <span className='text-sm font-semibold'>MagicFlux</span>
        </Link>
        <div className='h-4 w-px bg-border' />
        <span className='text-xs text-muted-foreground'>Dashboard</span>
        <div className='flex-1' />
        <Button variant='ghost' size='sm' onClick={loadData} className='gap-1.5 text-xs text-muted-foreground' disabled={loading}>
          <RefreshCw className={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
          Refresh
        </Button>
        <ThemeToggle />
        <Link href='/runtime'>
          <Button variant='outline' size='sm' className='gap-1.5 text-xs'>
            <Activity className='h-3.5 w-3.5' />
            Runtime
          </Button>
        </Link>
        <Link href='/builder'>
          <Button size='sm' className='gap-1.5 text-xs'>
            <Plus className='h-3.5 w-3.5' />
            New Workflow
          </Button>
        </Link>
        <Link href='/'>
          <Button variant='ghost' size='sm' className='gap-2 text-muted-foreground'>
            <ArrowLeft className='h-3.5 w-3.5' />
            Home
          </Button>
        </Link>
      </header>

      <main className='mx-auto max-w-6xl space-y-6 px-6 py-8'>
        <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-3'>
          <div className='rounded-xl border border-border bg-card p-4'>
            <p className='text-xs text-muted-foreground'>Total Workflows</p>
            <p className='mt-1 text-2xl font-semibold'>{stats.totalWorkflows}</p>
          </div>
          <div className='rounded-xl border border-border bg-card p-4'>
            <p className='text-xs text-muted-foreground'>Drafts</p>
            <p className='mt-1 text-2xl font-semibold'>{stats.drafts}</p>
          </div>
          <div className='rounded-xl border border-border bg-card p-4'>
            <p className='text-xs text-muted-foreground'>Simulated Tested</p>
            <p className='mt-1 text-2xl font-semibold'>{stats.simulatedTested}</p>
          </div>
          <div className='rounded-xl border border-border bg-card p-4'>
            <p className='text-xs text-muted-foreground'>Deployed</p>
            <p className='mt-1 text-2xl font-semibold'>{stats.deployed}</p>
          </div>
          <div className='rounded-xl border border-border bg-card p-4'>
            <p className='text-xs text-muted-foreground'>Failed</p>
            <p className='mt-1 text-2xl font-semibold'>{stats.failed}</p>
          </div>
          <div className='rounded-xl border border-border bg-card p-4'>
            <p className='text-xs text-muted-foreground'>Connected Integrations</p>
            <p className='mt-1 text-2xl font-semibold'>{stats.integrationsUsed}</p>
          </div>
        </div>

        <div className='rounded-xl border border-border bg-card p-4'>
          <UsageSummaryWidget />
        </div>

        <section className='space-y-3'>
          <h2 className='text-sm font-semibold'>Workflows</h2>
          {loading ? (
            <div className='flex items-center gap-2 text-sm text-muted-foreground'>
              <Loader2 className='h-4 w-4 animate-spin' /> Loading workflows...
            </div>
          ) : workflows.length === 0 ? (
            <p className='text-sm text-muted-foreground'>No workflows yet.</p>
          ) : (
            <div className='space-y-2'>
              {workflows.map((workflow) => {
                const latest = latestByWorkflow.get(workflow.id);
                const displayStatus = latest
                  ? latest.mode === 'test' && latest.status === 'success'
                    ? 'simulated_success'
                    : latest.status
                  : (workflow.status === 'deployed' ? 'success' : 'waiting');

                const required = workflow.integrations ?? [];
                const missing = required.filter((provider) => !connectedProviders.has(provider));

                return (
                  <Link key={workflow.id} href={`/dashboard/workflows/${workflow.id}`} className='block rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/30'>
                    <div className='flex flex-wrap items-center justify-between gap-3'>
                      <div className='min-w-0'>
                        <p className='truncate text-sm font-semibold'>{workflow.name || 'Untitled workflow'}</p>
                        <p className='mt-0.5 truncate text-xs text-muted-foreground'>{workflow.description || 'Generated workflow draft'}</p>
                      </div>
                      <ExecutionStatusBadge status={displayStatus} />
                    </div>

                    <div className='mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground'>
                      <span>Required: {required.length > 0 ? required.join(', ') : 'None'}</span>
                      {missing.length > 0 ? <span className='text-amber-300'>Missing setup: {missing.join(', ')}</span> : <span className='text-emerald-300'>Setup complete</span>}
                      {latest?.started_at ? <span>Last run: {formatDate(latest.started_at)}</span> : <span>No executions yet</span>}
                      <span>Updated: {formatDate(workflow.updated_at)}</span>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, Shield, Zap, History } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ThemeToggle } from '@/components/theme-toggle';
import { useAuth } from '@/lib/auth-context';

import { OverviewPanel }        from '@/components/control/OverviewPanel';
import { CommandsPanel }        from '@/components/control/CommandsPanel';
import { ExecutionsPanel }      from '@/components/control/ExecutionsPanel';
import { WorkersPanel }         from '@/components/control/WorkersPanel';
import { IncidentsPanel }       from '@/components/control/IncidentsPanel';
import { GlobalRuntimeAlerts }  from '@/components/control/GlobalRuntimeAlerts';
import { OperatorAuditDrawer }  from '@/components/control/OperatorAuditDrawer';
import { ObservabilityPanel }   from '@/components/control/ObservabilityPanel';
import { TraceViewer }          from '@/components/control/TraceViewer';
import { ReplayVisualizer }     from '@/components/control/ReplayVisualizer';
import { SlaPanel }             from '@/components/control/SlaPanel';
import { CostPanel }            from '@/components/control/CostPanel';
import { AlertsPanel }          from '@/components/control/AlertsPanel';

export default function ControlPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [auditOpen, setAuditOpen] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) router.replace('/login');
  }, [authLoading, user, router]);

  if (authLoading) {
    return (
      <div className='flex min-h-screen items-center justify-center gap-2 text-sm text-muted-foreground'>
        <Loader2 className='h-4 w-4 animate-spin' /> Loading…
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
          <span className='text-sm font-semibold'>MagicFlux</span>
        </Link>
        <div className='h-4 w-px bg-border' />
        <div className='flex items-center gap-1.5 text-xs text-muted-foreground'>
          <Shield className='h-3.5 w-3.5' />
          Operator Control Plane
        </div>
        <div className='flex-1' />
        <Button
          variant='ghost' size='sm'
          className='gap-2 text-xs text-muted-foreground'
          onClick={() => setAuditOpen(true)}
        >
          <History className='h-3.5 w-3.5' />
          Audit Log
        </Button>
        <ThemeToggle />
        <Link href='/runtime'>
          <Button variant='ghost' size='sm' className='gap-2 text-muted-foreground'>
            <ArrowLeft className='h-3.5 w-3.5' /> Runtime
          </Button>
        </Link>
        <Link href='/dashboard'>
          <Button variant='ghost' size='sm' className='gap-2 text-muted-foreground'>
            Dashboard
          </Button>
        </Link>
      </header>

      <main className='mx-auto max-w-7xl px-6 py-8'>
        <GlobalRuntimeAlerts />

        <Tabs defaultValue='overview' className='space-y-6'>
          <TabsList className='h-9 gap-1 flex-wrap'>
            <TabsTrigger value='overview'       className='text-xs px-4'>Overview</TabsTrigger>
            <TabsTrigger value='incidents'      className='text-xs px-4'>Incidents</TabsTrigger>
            <TabsTrigger value='executions'     className='text-xs px-4'>Executions</TabsTrigger>
            <TabsTrigger value='commands'       className='text-xs px-4'>Commands</TabsTrigger>
            <TabsTrigger value='workers'        className='text-xs px-4'>Workers</TabsTrigger>
            <TabsTrigger value='observability'  className='text-xs px-4'>Observability</TabsTrigger>
            <TabsTrigger value='traces'         className='text-xs px-4'>Traces</TabsTrigger>
            <TabsTrigger value='replay'         className='text-xs px-4'>Replay</TabsTrigger>
            <TabsTrigger value='sla'            className='text-xs px-4'>SLA</TabsTrigger>
            <TabsTrigger value='cost'           className='text-xs px-4'>Cost</TabsTrigger>
            <TabsTrigger value='alerts'         className='text-xs px-4'>Alerts</TabsTrigger>
          </TabsList>

          <TabsContent value='overview'>
            <OverviewPanel />
          </TabsContent>

          <TabsContent value='incidents'>
            <div className='mb-4'>
              <h1 className='text-lg font-semibold'>Incidents</h1>
              <p className='text-xs text-muted-foreground'>Open and investigating runtime incidents. Resolve or escalate directly.</p>
            </div>
            <IncidentsPanel />
          </TabsContent>

          <TabsContent value='executions'>
            <div className='mb-4'>
              <h1 className='text-lg font-semibold'>Executions</h1>
              <p className='text-xs text-muted-foreground'>Inspect and control active workflow executions.</p>
            </div>
            <ExecutionsPanel />
          </TabsContent>

          <TabsContent value='commands'>
            <div className='mb-4'>
              <h1 className='text-lg font-semibold'>Command Bus</h1>
              <p className='text-xs text-muted-foreground'>Inspect the durable command queue. Retry or dead-letter individual commands.</p>
            </div>
            <CommandsPanel />
          </TabsContent>

          <TabsContent value='workers'>
            <div className='mb-4'>
              <h1 className='text-lg font-semibold'>Workers</h1>
              <p className='text-xs text-muted-foreground'>Live worker registry — heartbeat, status, and drain or restart controls.</p>
            </div>
            <WorkersPanel />
          </TabsContent>

          <TabsContent value='observability'>
            <div className='mb-4'>
              <h1 className='text-lg font-semibold'>Observability</h1>
              <p className='text-xs text-muted-foreground'>Real-time metrics: CPU, memory, queue depth, error rate, worker utilization, and latency.</p>
            </div>
            <ObservabilityPanel />
          </TabsContent>

          <TabsContent value='traces'>
            <div className='mb-4'>
              <h1 className='text-lg font-semibold'>Distributed Tracing</h1>
              <p className='text-xs text-muted-foreground'>Search and inspect execution traces with span-level latency breakdown.</p>
            </div>
            <TraceViewer />
          </TabsContent>

          <TabsContent value='replay'>
            <div className='mb-4'>
              <h1 className='text-lg font-semibold'>Replay Visualizer</h1>
              <p className='text-xs text-muted-foreground'>Visual inspection of execution replay history — events, snapshots, commands, and checkpoints.</p>
            </div>
            <ReplayVisualizer />
          </TabsContent>

          <TabsContent value='sla'>
            <div className='mb-4'>
              <h1 className='text-lg font-semibold'>SLA Monitoring</h1>
              <p className='text-xs text-muted-foreground'>Service Level Agreement targets, violation tracking, and compliance reporting.</p>
            </div>
            <SlaPanel />
          </TabsContent>

          <TabsContent value='cost'>
            <div className='mb-4'>
              <h1 className='text-lg font-semibold'>Cost Analytics</h1>
              <p className='text-xs text-muted-foreground'>Workflow and execution cost attribution, top spenders, and monthly budget projections.</p>
            </div>
            <CostPanel />
          </TabsContent>

          <TabsContent value='alerts'>
            <div className='mb-4'>
              <h1 className='text-lg font-semibold'>Alerting</h1>
              <p className='text-xs text-muted-foreground'>Configure alert rules for queue overload, worker crashes, incident spikes, and SLA violations. Delivers to dashboard, email, webhook, Slack, and Telegram.</p>
            </div>
            <AlertsPanel />
          </TabsContent>
        </Tabs>
      </main>

      <OperatorAuditDrawer open={auditOpen} onClose={() => setAuditOpen(false)} />
    </div>
  );
}

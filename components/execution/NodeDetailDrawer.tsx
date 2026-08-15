'use client';

import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AlertCircle } from 'lucide-react';
import { useExecutionStore } from '@/store/execution-store';
import { NodeTypeIcon } from './NodeTypeIcon';
import { StatusBadge } from './StatusBadge';
import { DurationBadge } from './DurationBadge';
import type { DrawerTab } from '@/lib/execution/types';

// ── JSON pretty-printer ───────────────────────────────────────────────────────

function JsonView({ data }: { data: unknown }) {
  if (data === null || data === undefined) {
    return (
      <div className="flex items-center justify-center h-24 text-muted-foreground text-sm">
        No data
      </div>
    );
  }

  const json = typeof data === 'string' ? data : JSON.stringify(data, null, 2);

  return (
    <pre className="text-xs font-mono leading-relaxed text-foreground whitespace-pre-wrap break-all">
      {json}
    </pre>
  );
}

// ── Logs view ─────────────────────────────────────────────────────────────────

function LogsView({ logs }: { logs: string[] }) {
  if (logs.length === 0) {
    return (
      <div className="flex items-center justify-center h-24 text-muted-foreground text-sm">
        No logs
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {logs.map((line, i) => (
        <div
          key={i}
          className="flex items-start gap-2 py-1.5 border-b border-border/50 last:border-0"
        >
          <span className="text-muted-foreground text-xs font-mono min-w-[2rem] text-right mt-0.5">
            {i + 1}
          </span>
          <span
            className={`text-xs font-mono break-all ${
              line.toLowerCase().includes('error') || line.toLowerCase().includes('fail')
                ? 'text-red-600'
                : line.toLowerCase().includes('warn')
                ? 'text-yellow-600'
                : 'text-foreground'
            }`}
          >
            {line}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Drawer ────────────────────────────────────────────────────────────────────

const TABS: { value: DrawerTab; label: string }[] = [
  { value: 'input',  label: 'Input'  },
  { value: 'output', label: 'Output' },
  { value: 'logs',   label: 'Logs'   },
  { value: 'raw',    label: 'Raw JSON' },
];

export function NodeDetailDrawer() {
  const { drawerOpen, activeStep, activeTab, closeDrawer, setTab } = useExecutionStore();

  if (!activeStep) return null;

  const rawJson = {
    id:            activeStep.id,
    node_id:       activeStep.node_id,
    node_name:     activeStep.node_name,
    node_type:     activeStep.node_type,
    status:        activeStep.status,
    attempt:       activeStep.attempt,
    started_at:    activeStep.started_at,
    completed_at:  activeStep.completed_at,
    duration_ms:   activeStep.duration_ms,
    error_message: activeStep.error_message,
    input_data:    activeStep.input_data,
    output_data:   activeStep.output_data,
    logs:          activeStep.logs,
  };

  return (
    <Sheet open={drawerOpen} onOpenChange={open => !open && closeDrawer()}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl flex flex-col p-0 gap-0"
      >
        {/* Header */}
        <SheetHeader className="px-6 py-4 border-b flex-shrink-0">
          <div className="flex items-start gap-3">
            <NodeTypeIcon nodeType={activeStep.node_type} size="lg" />
            <div className="min-w-0 flex-1">
              <SheetTitle className="text-base font-semibold truncate">
                {activeStep.node_name}
              </SheetTitle>
              <p className="text-xs text-muted-foreground truncate mt-0.5">
                {activeStep.node_type}
              </p>
              <div className="flex items-center gap-2 mt-2">
                <StatusBadge status={activeStep.status} size="sm" />
                <DurationBadge ms={activeStep.duration_ms} />
                {activeStep.attempt > 1 && (
                  <span className="text-xs text-muted-foreground">
                    · Attempt {activeStep.attempt}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Error banner */}
          {activeStep.status === 'failed' && activeStep.error_message && (
            <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2">
              <div className="flex items-start gap-1.5">
                <AlertCircle className="h-3.5 w-3.5 text-red-600 mt-0.5 flex-shrink-0" />
                <p className="text-xs text-red-700 font-medium">{activeStep.error_message}</p>
              </div>
            </div>
          )}
        </SheetHeader>

        {/* Tabbed content */}
        <Tabs
          value={activeTab}
          onValueChange={v => setTab(v as DrawerTab)}
          className="flex flex-col flex-1 min-h-0"
        >
          <TabsList className="h-10 rounded-none border-b bg-transparent px-6 justify-start gap-0 flex-shrink-0">
            {TABS.map(t => (
              <TabsTrigger
                key={t.value}
                value={t.value}
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-3 text-xs h-full"
              >
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <div className="flex-1 min-h-0">
            <TabsContent value="input" className="h-full m-0">
              <ScrollArea className="h-full px-6 py-4">
                <JsonView data={activeStep.input_data} />
              </ScrollArea>
            </TabsContent>

            <TabsContent value="output" className="h-full m-0">
              <ScrollArea className="h-full px-6 py-4">
                <JsonView data={activeStep.output_data} />
              </ScrollArea>
            </TabsContent>

            <TabsContent value="logs" className="h-full m-0">
              <ScrollArea className="h-full px-6 py-4">
                <LogsView logs={activeStep.logs} />
              </ScrollArea>
            </TabsContent>

            <TabsContent value="raw" className="h-full m-0">
              <ScrollArea className="h-full px-6 py-4">
                <JsonView data={rawJson} />
              </ScrollArea>
            </TabsContent>
          </div>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}

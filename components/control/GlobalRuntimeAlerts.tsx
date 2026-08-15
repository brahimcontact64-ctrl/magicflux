'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';

import { useControlApi } from './use-control-api';
import { useAutoRefresh } from './use-auto-refresh';
import type { OverviewResponse } from './types';

type Alert = {
  id:       string;
  level:    'critical' | 'warning';
  message:  string;
};

function deriveAlerts(data: OverviewResponse): Alert[] {
  const alerts: Alert[] = [];

  const critical = data.activeIncidents.filter(i => i.severity === 'critical').length;
  if (critical > 0) {
    alerts.push({
      id: 'critical-incidents',
      level: 'critical',
      message: `${critical} critical incident${critical > 1 ? 's' : ''} open — immediate attention required`,
    });
  }

  const stalledWorkers = data.workerSummary.statuses['crashed'] ?? 0;
  if (stalledWorkers > 0) {
    alerts.push({
      id: 'crashed-workers',
      level: 'critical',
      message: `${stalledWorkers} worker${stalledWorkers > 1 ? 's' : ''} in crashed state`,
    });
  }

  const pendingBacklog = data.commandBacklog.statusCounts['pending'] ?? 0;
  if (pendingBacklog > 200) {
    alerts.push({
      id: 'command-backlog',
      level: 'warning',
      message: `Command backlog: ${pendingBacklog.toLocaleString()} pending commands`,
    });
  }

  const dlq = data.commandBacklog.statusCounts['dead_letter'] ?? 0;
  if (dlq > 0) {
    alerts.push({
      id: 'dead-letter',
      level: 'warning',
      message: `${dlq} command${dlq > 1 ? 's' : ''} in dead-letter queue`,
    });
  }

  const openIncidents = data.activeIncidents.length;
  if (openIncidents > 0 && critical === 0) {
    alerts.push({
      id: 'open-incidents',
      level: 'warning',
      message: `${openIncidents} open incident${openIncidents > 1 ? 's' : ''} require attention`,
    });
  }

  return alerts;
}

export function GlobalRuntimeAlerts() {
  const { get } = useControlApi();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    const res = await get<OverviewResponse>('/api/runtime/control/overview');
    if (res) setAlerts(deriveAlerts(res));
  }, [get]);

  useEffect(() => { void refresh(); }, [refresh]);
  useAutoRefresh(refresh, 10_000);

  const visible = alerts.filter(a => !dismissed.has(a.id));
  if (visible.length === 0) return null;

  return (
    <div className='space-y-1.5 mb-4'>
      {visible.map(alert => (
        <div
          key={alert.id}
          className={`flex items-center gap-3 rounded-lg border px-4 py-2.5 text-sm ${
            alert.level === 'critical'
              ? 'border-red-500/50 bg-red-500/10 text-red-400'
              : 'border-amber-500/50 bg-amber-500/10 text-amber-400'
          }`}
        >
          <AlertTriangle className='h-4 w-4 shrink-0' />
          <span className='flex-1'>{alert.message}</span>
          <button
            onClick={() => setDismissed(prev => new Set([...prev, alert.id]))}
            className='shrink-0 opacity-60 hover:opacity-100 transition-opacity'
            aria-label='Dismiss alert'
          >
            <X className='h-3.5 w-3.5' />
          </button>
        </div>
      ))}
    </div>
  );
}

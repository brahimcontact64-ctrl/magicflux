'use client';

import { useCallback, useEffect, useState } from 'react';
import { Bell, BellOff, Plus, Trash2, Play, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useControlApi } from './use-control-api';
import { useAutoRefresh } from './use-auto-refresh';
import type { AlertRule, AlertFiring, AlertRulesResponse, AlertFiringsResponse } from './types';

const CONDITION_LABELS: Record<string, string> = {
  queue_overload:      'Queue Overload',
  worker_crash:        'Worker Crash',
  incident_explosion:  'Incident Explosion',
  replay_corruption:   'Replay Corruption',
  sla_violation:       'SLA Violation',
};

const CHANNEL_ICONS: Record<string, string> = {
  dashboard: '🖥',
  email:     '📧',
  webhook:   '🔗',
  slack:     '💬',
  telegram:  '✈',
};

function severityClass(s: string): string {
  if (s === 'critical') return 'text-red-400 border-red-500/40';
  if (s === 'warning')  return 'text-amber-400 border-amber-500/40';
  return 'text-muted-foreground';
}

function RuleRow({
  rule,
  onToggle,
  onTest,
  onDelete,
}: {
  rule:     AlertRule;
  onToggle: (r: AlertRule) => void;
  onTest:   (r: AlertRule) => void;
  onDelete: (r: AlertRule) => void;
}) {
  return (
    <div className='flex items-center gap-3 rounded-lg border border-border/50 bg-card px-3 py-2.5 text-xs'>
      <div className={`h-2 w-2 rounded-full shrink-0 ${rule.is_active ? 'bg-emerald-500' : 'bg-muted-foreground'}`} />
      <div className='flex-1 min-w-0'>
        <div className='flex items-center gap-2'>
          <span className='font-medium'>{rule.name}</span>
          <Badge variant='outline' className={`text-[10px] ${severityClass(rule.severity)}`}>
            {rule.severity}
          </Badge>
        </div>
        <div className='text-muted-foreground mt-0.5'>
          {CONDITION_LABELS[rule.condition_type] ?? rule.condition_type}
          {' · threshold ≥ '}{rule.threshold}
          {' · '}{rule.window_minutes}m window
        </div>
        <div className='mt-1 flex gap-1'>
          {rule.channels.map(ch => (
            <span key={ch} title={ch} className='text-[10px]'>
              {CHANNEL_ICONS[ch] ?? ch}
            </span>
          ))}
        </div>
      </div>
      <div className='flex items-center gap-1 shrink-0'>
        <Button
          size='sm'
          variant='ghost'
          className='h-6 w-6 p-0'
          title='Test alert'
          onClick={() => onTest(rule)}
        >
          <Play className='h-3 w-3' />
        </Button>
        <Button
          size='sm'
          variant='ghost'
          className='h-6 w-6 p-0'
          title={rule.is_active ? 'Disable' : 'Enable'}
          onClick={() => onToggle(rule)}
        >
          {rule.is_active ? <Bell className='h-3 w-3' /> : <BellOff className='h-3 w-3' />}
        </Button>
        <Button
          size='sm'
          variant='ghost'
          className='h-6 w-6 p-0 text-destructive hover:text-destructive'
          title='Delete rule'
          onClick={() => onDelete(rule)}
        >
          <Trash2 className='h-3 w-3' />
        </Button>
      </div>
    </div>
  );
}

function FiringRow({ firing, rules }: { firing: AlertFiring; rules: AlertRule[] }) {
  const rule = rules.find(r => r.id === firing.rule_id);
  return (
    <div className='flex items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs'>
      <Bell className='h-3.5 w-3.5 shrink-0 text-amber-400' />
      <div className='flex-1 min-w-0'>
        <div className='font-medium'>{rule?.name ?? firing.rule_id.slice(0, 12)}</div>
        <div className='text-muted-foreground'>
          Channels: {firing.channels_sent.join(', ') || '—'}
        </div>
      </div>
      <div className='text-muted-foreground shrink-0'>
        {new Date(firing.fired_at).toLocaleTimeString()}
      </div>
      {firing.resolved_at && (
        <Badge variant='outline' className='text-[10px] text-emerald-400 border-emerald-500/40'>
          resolved
        </Badge>
      )}
    </div>
  );
}

export function AlertsPanel() {
  const { get, post } = useControlApi();
  const [rules,      setRules]      = useState<AlertRule[]>([]);
  const [firings,    setFirings]    = useState<AlertFiring[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [deleting,   setDeleting]   = useState<AlertRule | null>(null);
  const [activeTab,  setActiveTab]  = useState<'rules' | 'firings'>('rules');

  const load = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    const [rulesRes, firingsRes] = await Promise.all([
      get<AlertRulesResponse>('/api/runtime/control/alerts'),
      get<AlertFiringsResponse>('/api/runtime/control/alerts?firings=true'),
    ]);
    if (rulesRes)   setRules(rulesRes.rules ?? []);
    if (firingsRes) setFirings(firingsRes.firings ?? []);
    setLoading(false);
  }, [get]);

  useEffect(() => { void load(); }, [load]);
  useAutoRefresh(() => { void load(false); }, 15_000);

  const handleToggle = useCallback(async (rule: AlertRule) => {
    const ok = await post<{ updated: boolean }>('/api/runtime/control/alerts', {
      action:  'update',
      ruleId:  rule.id,
      patch:   { is_active: !rule.is_active },
    });
    if (ok) {
      toast.success(rule.is_active ? 'Alert rule disabled' : 'Alert rule enabled');
      void load(false);
    }
  }, [post, load]);

  const handleTest = useCallback(async (rule: AlertRule) => {
    const ok = await post<{ fired: boolean }>('/api/runtime/control/alerts', {
      action: 'test',
      ruleId: rule.id,
    });
    if (ok?.fired) toast.success(`Test alert fired for "${rule.name}"`);
    else toast.error('Test alert failed');
    void load(false);
  }, [post, load]);

  const handleDelete = useCallback(async (rule: AlertRule) => {
    const ok = await post<{ deleted: boolean }>('/api/runtime/control/alerts', {
      action: 'delete',
      ruleId: rule.id,
    });
    if (ok?.deleted) {
      toast.success('Alert rule deleted');
      setDeleting(null);
      void load(false);
    } else {
      toast.error('Delete failed');
    }
  }, [post, load]);

  return (
    <div className='space-y-4'>
      {/* Header */}
      <div className='flex items-center justify-between'>
        <div className='flex items-center gap-2'>
          <Bell className='h-4 w-4 text-muted-foreground' />
          <span className='text-sm font-medium'>Alerting</span>
          {firings.filter(f => !f.resolved_at).length > 0 && (
            <Badge className='bg-amber-500/10 text-amber-400 border-amber-500/30 ml-2'>
              {firings.filter(f => !f.resolved_at).length} active
            </Badge>
          )}
        </div>
        <div className='flex items-center gap-2'>
          <Button size='sm' variant='ghost' className='h-7 w-7 p-0' onClick={() => void load(false)}>
            <RefreshCw className='h-3 w-3' />
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className='flex gap-1 rounded-lg border border-border p-1 bg-muted/30 w-fit'>
        {(['rules', 'firings'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-3 py-1 rounded text-xs capitalize transition-colors ${
              activeTab === tab
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab}
            <span className='ml-1.5 text-muted-foreground'>
              ({tab === 'rules' ? rules.length : firings.length})
            </span>
          </button>
        ))}
      </div>

      {loading ? (
        <div className='space-y-2'>
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className='h-16 w-full rounded-lg' />
          ))}
        </div>
      ) : activeTab === 'rules' ? (
        <div className='space-y-2'>
          {rules.length === 0 ? (
            <div className='rounded-lg border border-border/50 bg-card p-6 text-center'>
              <Bell className='h-8 w-8 mx-auto mb-2 text-muted-foreground' />
              <p className='text-xs text-muted-foreground'>
                No alert rules configured. Default rules are seeded but inactive.
              </p>
            </div>
          ) : (
            rules.map(rule => (
              <RuleRow
                key={rule.id}
                rule={rule}
                onToggle={handleToggle}
                onTest={handleTest}
                onDelete={r => setDeleting(r)}
              />
            ))
          )}
        </div>
      ) : (
        <div className='space-y-2'>
          {firings.length === 0 ? (
            <div className='flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-xs text-emerald-400'>
              <Bell className='h-3.5 w-3.5 shrink-0' />
              No alert firings recently
            </div>
          ) : (
            firings.map(f => (
              <FiringRow key={f.id} firing={f} rules={rules} />
            ))
          )}
        </div>
      )}

      {/* Delete confirmation */}
      <AlertDialog open={!!deleting} onOpenChange={open => { if (!open) setDeleting(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Alert Rule</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &ldquo;{deleting?.name}&rdquo;?
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className='bg-destructive text-destructive-foreground hover:bg-destructive/90'
              onClick={() => deleting && void handleDelete(deleting)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

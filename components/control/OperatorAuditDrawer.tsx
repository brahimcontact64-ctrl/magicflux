'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { History, RefreshCw, Search, ChevronLeft, ChevronRight } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet';
import { useControlApi } from './use-control-api';
import type { OperatorAction, OperatorActionsResponse } from './types';

function fmt(ts?: string | null) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

function actionColor(type: string): string {
  if (type.startsWith('resolve') || type.startsWith('bulk_resolve')) return 'text-emerald-400';
  if (type.includes('critical') || type.includes('dead_letter') || type.includes('cancel')) return 'text-red-400';
  if (type.includes('escalat')) return 'text-orange-400';
  if (type.includes('restart')) return 'text-amber-400';
  return 'text-muted-foreground';
}

function ActionRow({ action }: { action: OperatorAction }) {
  return (
    <div className='border-b border-border/50 px-4 py-3 hover:bg-muted/10'>
      <div className='flex items-start justify-between gap-3'>
        <span className={`font-mono text-xs font-semibold ${actionColor(action.action_type)}`}>
          {action.action_type}
        </span>
        <span className='shrink-0 text-[11px] text-muted-foreground'>{fmt(action.created_at)}</span>
      </div>
      <div className='mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground'>
        <span>Op: {action.operator_id.slice(0, 8)}</span>
        {action.execution_id && <span>Exec: {action.execution_id.slice(0, 8)}</span>}
        {action.worker_id    && <span>Worker: {action.worker_id.slice(0, 16)}</span>}
        {action.incident_id  && <span>Incident: {action.incident_id.slice(0, 8)}</span>}
      </div>
    </div>
  );
}

export function OperatorAuditDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { get } = useControlApi();

  const [actions, setActions]     = useState<OperatorAction[]>([]);
  const [total, setTotal]         = useState(0);
  const [page, setPage]           = useState(1);
  const [loading, setLoading]     = useState(false);
  const [search, setSearch]       = useState('');
  const [searchInput, setSearchInput] = useState('');
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const PAGE_SIZE = 50;

  const load = useCallback(async (pg: number, q: string) => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(pg), page_size: String(PAGE_SIZE) });
    if (q.trim()) params.set('search', q.trim());
    const res = await get<OperatorActionsResponse>(`/api/runtime/control/operator-actions?${params}`);
    if (res) {
      setActions(res.actions ?? []);
      setTotal(res.total ?? 0);
    }
    setLoading(false);
  }, [get]);

  useEffect(() => {
    if (open) void load(page, search);
  }, [open, page, search, load]);

  const handleSearchChange = (value: string) => {
    setSearchInput(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setPage(1);
      setSearch(value);
    }, 400);
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <Sheet open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <SheetContent side='right' className='w-full max-w-lg p-0 flex flex-col'>
        <SheetHeader className='px-4 pt-5 pb-3 border-b border-border'>
          <div className='flex items-center gap-2'>
            <History className='h-4 w-4 text-muted-foreground' />
            <SheetTitle className='text-sm'>Operator Audit Log</SheetTitle>
          </div>
          <SheetDescription className='text-xs'>
            All operator actions on the runtime control plane.
          </SheetDescription>
        </SheetHeader>

        <div className='border-b border-border px-4 py-2.5 flex items-center gap-2'>
          <Search className='h-3.5 w-3.5 shrink-0 text-muted-foreground' />
          <Input
            placeholder='Search action type…'
            value={searchInput}
            onChange={e => handleSearchChange(e.target.value)}
            className='h-7 border-0 bg-transparent p-0 text-xs shadow-none focus-visible:ring-0'
          />
          <Button
            size='sm' variant='ghost' className='h-7 w-7 shrink-0 p-0'
            onClick={() => void load(page, search)}
            disabled={loading}
          >
            <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>

        <div className='flex-1 overflow-y-auto'>
          {loading ? (
            <div className='space-y-px p-4'>
              {[...Array(8)].map((_, i) => <Skeleton key={i} className='h-12 rounded' />)}
            </div>
          ) : actions.length === 0 ? (
            <p className='p-8 text-center text-xs text-muted-foreground'>No operator actions found.</p>
          ) : (
            actions.map(a => <ActionRow key={a.id} action={a} />)
          )}
        </div>

        <div className='border-t border-border px-4 py-2.5 flex items-center justify-between text-xs text-muted-foreground'>
          <span>{total.toLocaleString()} total actions</span>
          <div className='flex items-center gap-1'>
            <Button
              size='sm' variant='ghost' className='h-6 w-6 p-0'
              disabled={page <= 1 || loading}
              onClick={() => setPage(p => p - 1)}
            >
              <ChevronLeft className='h-3.5 w-3.5' />
            </Button>
            <span className='px-1'>Page {page} / {totalPages}</span>
            <Button
              size='sm' variant='ghost' className='h-6 w-6 p-0'
              disabled={page >= totalPages || loading}
              onClick={() => setPage(p => p + 1)}
            >
              <ChevronRight className='h-3.5 w-3.5' />
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

'use client';

import { useCallback } from 'react';
import { Search, X } from 'lucide-react';
import { Input }  from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useExecutionStore } from '@/store/execution-store';

const STATUSES = [
  { value: '',          label: 'All statuses'  },
  { value: 'running',   label: 'Running'       },
  { value: 'success',   label: 'Success'       },
  { value: 'failed',    label: 'Failed'        },
  { value: 'waiting',   label: 'Waiting'       },
  { value: 'paused',    label: 'Paused'        },
  { value: 'cancelled', label: 'Cancelled'     },
];

const MODES = [
  { value: '',     label: 'All modes' },
  { value: 'live', label: 'Live'      },
  { value: 'test', label: 'Test'      },
];

const DATE_PRESETS = [
  { value: '',    label: 'All time'     },
  { value: '1',   label: 'Last 24 h'   },
  { value: '7',   label: 'Last 7 days' },
  { value: '30',  label: 'Last 30 days'},
  { value: '90',  label: 'Last 90 days'},
];

function daysBefore(days: number): string {
  const d = new Date(Date.now() - days * 86_400_000);
  return d.toISOString();
}

export function ExecutionFilterBar() {
  const { filters, setFilters, resetFilters } = useExecutionStore();

  const hasActive =
    Boolean(filters.search) ||
    Boolean(filters.status) ||
    Boolean(filters.mode)   ||
    Boolean(filters.from);

  const handleDatePreset = useCallback((val: string) => {
    if (!val) { setFilters({ from: '', to: '' }); return; }
    setFilters({ from: daysBefore(Number(val)), to: '' });
  }, [setFilters]);

  return (
    <div className="flex flex-wrap gap-2 items-center">
      {/* Search */}
      <div className="relative flex-1 min-w-[180px] max-w-[280px]">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
        <Input
          placeholder="Search workflows…"
          className="pl-8 h-9 text-sm"
          value={filters.search ?? ''}
          onChange={e => setFilters({ search: e.target.value })}
        />
      </div>

      {/* Status */}
      <Select
        value={filters.status ?? ''}
        onValueChange={v => setFilters({ status: v as typeof filters.status })}
      >
        <SelectTrigger className="h-9 text-sm w-[140px]">
          <SelectValue placeholder="All statuses" />
        </SelectTrigger>
        <SelectContent>
          {STATUSES.map(s => (
            <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Mode */}
      <Select
        value={filters.mode ?? ''}
        onValueChange={v => setFilters({ mode: v as typeof filters.mode })}
      >
        <SelectTrigger className="h-9 text-sm w-[120px]">
          <SelectValue placeholder="All modes" />
        </SelectTrigger>
        <SelectContent>
          {MODES.map(m => (
            <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Date preset */}
      <Select
        value={''}
        onValueChange={handleDatePreset}
      >
        <SelectTrigger className="h-9 text-sm w-[140px]">
          <SelectValue placeholder="All time" />
        </SelectTrigger>
        <SelectContent>
          {DATE_PRESETS.map(p => (
            <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Clear */}
      {hasActive && (
        <Button
          variant="ghost"
          size="sm"
          className="h-9 gap-1.5 text-muted-foreground"
          onClick={resetFilters}
        >
          <X className="h-3.5 w-3.5" />
          Clear
        </Button>
      )}
    </div>
  );
}

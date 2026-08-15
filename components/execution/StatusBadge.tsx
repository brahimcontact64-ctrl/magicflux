import { cn } from '@/lib/utils';
import type { ExecutionStatus, NodeStatus } from '@/lib/execution/types';

type Status = ExecutionStatus | NodeStatus;

const CONFIG: Record<string, { label: string; classes: string; dot: string }> = {
  success:          { label: 'Success',   classes: 'bg-green-50  text-green-700  border-green-200',  dot: 'bg-green-500'  },
  completed:        { label: 'Success',   classes: 'bg-green-50  text-green-700  border-green-200',  dot: 'bg-green-500'  },
  failed:           { label: 'Failed',    classes: 'bg-red-50    text-red-700    border-red-200',    dot: 'bg-red-500'    },
  running:          { label: 'Running',   classes: 'bg-blue-50   text-blue-700   border-blue-200',   dot: 'bg-blue-500 animate-pulse' },
  waiting:          { label: 'Waiting',   classes: 'bg-yellow-50 text-yellow-700 border-yellow-200', dot: 'bg-yellow-500' },
  paused:           { label: 'Paused',    classes: 'bg-orange-50 text-orange-700 border-orange-200', dot: 'bg-orange-500' },
  cancelled:        { label: 'Cancelled', classes: 'bg-gray-50   text-gray-600   border-gray-200',   dot: 'bg-gray-400'   },
  retrying:         { label: 'Retrying',  classes: 'bg-purple-50 text-purple-700 border-purple-200', dot: 'bg-purple-500 animate-pulse' },
  queued:           { label: 'Queued',    classes: 'bg-gray-50   text-gray-600   border-gray-200',   dot: 'bg-gray-400'   },
  skipped:          { label: 'Skipped',   classes: 'bg-gray-50   text-gray-500   border-gray-200',   dot: 'bg-gray-300'   },
  simulated_success:{ label: 'Simulated', classes: 'bg-teal-50   text-teal-700   border-teal-200',   dot: 'bg-teal-500'   },
};

const DEFAULT_CONFIG = { label: 'Unknown', classes: 'bg-gray-50 text-gray-600 border-gray-200', dot: 'bg-gray-400' };

interface Props {
  status: Status | string;
  size?: 'sm' | 'md';
  showDot?: boolean;
  className?: string;
}

export function StatusBadge({ status, size = 'md', showDot = true, className }: Props) {
  const cfg = CONFIG[status] ?? DEFAULT_CONFIG;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border font-medium',
        size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-xs',
        cfg.classes,
        className
      )}
    >
      {showDot && (
        <span className={cn('h-1.5 w-1.5 rounded-full flex-shrink-0', cfg.dot)} />
      )}
      {cfg.label}
    </span>
  );
}

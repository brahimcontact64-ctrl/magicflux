import { Skeleton } from '@/components/ui/skeleton';

export default function ExecutionsLoading() {
  return (
    <div className="flex flex-col gap-6 p-6 max-w-6xl mx-auto w-full">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Skeleton className="h-9 w-9 rounded-lg" />
        <div className="space-y-1.5">
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-3.5 w-56" />
        </div>
      </div>

      {/* Metrics row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-24 rounded-lg" />)}
      </div>

      {/* Filter bar */}
      <div className="flex gap-2">
        <Skeleton className="h-9 flex-1 max-w-[280px] rounded-md" />
        <Skeleton className="h-9 w-36 rounded-md" />
        <Skeleton className="h-9 w-28 rounded-md" />
      </div>

      {/* Table */}
      <Skeleton className="h-[400px] w-full rounded-lg" />
    </div>
  );
}

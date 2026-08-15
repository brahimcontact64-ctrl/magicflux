import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';

export default function ExecutionDetailLoading() {
  return (
    <div className="flex flex-col gap-6 p-6 max-w-5xl mx-auto w-full">
      {/* Back button */}
      <Skeleton className="h-8 w-32 rounded" />

      {/* Header card */}
      <div className="rounded-xl border border-border bg-card px-6 py-5 space-y-4">
        <div className="flex justify-between">
          <div className="space-y-2">
            <Skeleton className="h-5 w-20 rounded-full" />
            <Skeleton className="h-6 w-56 rounded" />
            <Skeleton className="h-3.5 w-72 rounded" />
          </div>
          <Skeleton className="h-10 w-24 rounded" />
        </div>
        <Separator />
        <div className="grid grid-cols-4 gap-4">
          {[0,1,2,3].map(i => <Skeleton key={i} className="h-12 rounded" />)}
        </div>
      </div>

      {/* Two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Timeline */}
        <div className="lg:col-span-2 space-y-3">
          <Skeleton className="h-4 w-40 rounded" />
          {[0,1,2,3].map(i => (
            <div key={i} className="flex gap-3">
              <Skeleton className="h-9 w-9 rounded-lg flex-shrink-0" />
              <Skeleton className="h-20 flex-1 rounded-lg" />
            </div>
          ))}
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          <Skeleton className="h-4 w-28 rounded" />
          <div className="grid grid-cols-2 gap-3">
            {[0,1,2,3].map(i => <Skeleton key={i} className="h-20 rounded-lg" />)}
          </div>
          <Skeleton className="h-32 rounded-lg" />
        </div>
      </div>
    </div>
  );
}

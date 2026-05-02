import Link from 'next/link';
import { Zap, ArrowLeft } from 'lucide-react';

import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <main className="min-h-screen bg-background flex items-center justify-center p-6">
      <div className="w-full max-w-md text-center space-y-6">
        <div className="mx-auto w-14 h-14 rounded-xl bg-primary/15 border border-primary/25 flex items-center justify-center">
          <Zap className="w-7 h-7 text-primary" />
        </div>
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">404</p>
          <h1 className="text-2xl font-semibold">Page not found</h1>
          <p className="text-sm text-muted-foreground">
            The page you are looking for does not exist or may have been moved.
          </p>
        </div>
        <div className="flex items-center justify-center gap-2">
          <Link href="/">
            <Button className="gap-2">
              <ArrowLeft className="w-4 h-4" />
              Go home
            </Button>
          </Link>
          <Link href="/builder">
            <Button variant="outline">Open builder</Button>
          </Link>
        </div>
      </div>
    </main>
  );
}

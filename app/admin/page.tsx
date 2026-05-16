'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowLeft, Inbox, Loader2, ShieldAlert, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme-toggle';
import { supabase } from '@/lib/supabase-client';

type AccessState = 'checking' | 'allowed' | 'forbidden' | 'unauthorized';

function ProPlanDevButton() {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const handleAssignPro = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/dev/assign-pro', { method: 'POST' });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setMessage(data.error ?? 'Failed to assign Pro plan');
        return;
      }
      setMessage('Pro plan assigned successfully for current user.');
    } catch {
      setMessage('Network error assigning Pro plan');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className='rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4'>
      <div className='flex items-start justify-between gap-4'>
        <div>
          <p className='text-sm font-medium text-emerald-400'>DEV Tool: Assign Pro Plan</p>
          <p className='mt-0.5 text-xs text-muted-foreground'>
            Testing utility. Updates subscriptions and activates Pro permissions.
          </p>
          {message ? <p className='mt-2 text-xs text-emerald-300'>{message}</p> : null}
        </div>
        <Button size='sm' onClick={handleAssignPro} disabled={loading}>
          {loading ? 'Assigning...' : 'Assign PRO (DEV)'}
        </Button>
      </div>
    </div>
  );
}

export default function AdminPage() {
  const [state, setState] = useState<AccessState>('checking');

  useEffect(() => {
    let cancelled = false;

    async function checkAccess() {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) {
        if (!cancelled) setState('unauthorized');
        return;
      }

      const res = await fetch('/api/admin/requests', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });

      if (cancelled) return;
      if (res.status === 401) setState('unauthorized');
      else if (res.status === 403) setState('forbidden');
      else if (res.ok) setState('allowed');
      else setState('forbidden');
    }

    checkAccess();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className='min-h-screen bg-background'>
      <header className='flex h-14 items-center gap-4 border-b border-border bg-card/50 px-6'>
        <Link href='/' className='group flex items-center gap-2'>
          <div className='flex h-7 w-7 items-center justify-center rounded-md bg-primary transition-transform group-hover:scale-105'>
            <Zap className='h-3.5 w-3.5 text-primary-foreground' fill='currentColor' />
          </div>
          <span className='text-sm font-semibold'>MagicFlux</span>
        </Link>
        <div className='h-4 w-px bg-border' />
        <span className='text-xs text-muted-foreground'>Admin</span>
        <div className='flex-1' />
        <ThemeToggle />
        <Link href='/dashboard'>
          <Button variant='ghost' size='sm' className='gap-2 text-muted-foreground'>
            <ArrowLeft className='h-3.5 w-3.5' />
            Back
          </Button>
        </Link>
      </header>

      <main className='mx-auto max-w-4xl px-6 py-10'>
        {state === 'checking' && (
          <div className='flex items-center gap-2 text-sm text-muted-foreground'>
            <Loader2 className='h-4 w-4 animate-spin' />
            Checking admin access...
          </div>
        )}

        {state === 'unauthorized' && (
          <div className='rounded-xl border border-amber-500/30 bg-amber-500/10 p-6'>
            <p className='text-sm font-semibold text-amber-300'>Sign-in required</p>
            <p className='mt-1 text-xs text-amber-200/90'>You must sign in with an admin account to access this page.</p>
            <div className='mt-3'>
              <Link href='/login'>
                <Button size='sm'>Go to Login</Button>
              </Link>
            </div>
          </div>
        )}

        {state === 'forbidden' && (
          <div className='rounded-xl border border-red-500/30 bg-red-500/10 p-6'>
            <p className='text-sm font-semibold text-red-300'>Admin access denied</p>
            <p className='mt-1 text-xs text-red-200/90'>This account is not allowed to access managed setup administration.</p>
          </div>
        )}

        {state === 'allowed' && (
          <div className='space-y-6'>
            <div className='rounded-xl border border-border bg-card p-6'>
              <h1 className='text-xl font-bold'>Managed Setup Admin</h1>
              <p className='mt-1 text-sm text-muted-foreground'>
                Generate workflow draft, review setup requirements, and deploy only after customer integrations are connected.
              </p>
              <div className='mt-4'>
                <Link href='/admin/requests'>
                  <Button className='gap-2'>
                    <Inbox className='h-4 w-4' />
                    Open Managed Requests
                  </Button>
                </Link>
              </div>
            </div>

            <div className='rounded-xl border border-border bg-card p-6'>
              <p className='flex items-center gap-2 text-sm font-semibold'>
                <ShieldAlert className='h-4 w-4 text-amber-400' />
                Admin Rules
              </p>
              <ul className='mt-3 space-y-2 text-xs text-muted-foreground'>
                <li>Generate workflow draft first.</li>
                <li>Deploy only after customer integrations are connected.</li>
                <li>If setup is incomplete, return SETUP_REQUIRED with exact missing providers.</li>
              </ul>
            </div>

            <ProPlanDevButton />
          </div>
        )}
      </main>
    </div>
  );
}

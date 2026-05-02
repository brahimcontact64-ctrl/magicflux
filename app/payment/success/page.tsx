'use client';

import { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Zap, Crown, CircleCheck as CheckCircle2, Loader as Loader2, CircleAlert as AlertCircle, ArrowRight } from 'lucide-react';
import { supabase } from '@/lib/supabase-client';
import { useAuth } from '@/lib/auth-context';
import { Button } from '@/components/ui/button';

type State = 'loading' | 'success' | 'error';

export default function PaymentSuccessPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { refreshPlan } = useAuth();
  const [state, setState] = useState<State>('loading');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    const orderId = searchParams.get('token'); // PayPal passes orderId as "token"

    if (!orderId) {
      setState('error');
      setErrorMsg('No order ID found in the URL. If you completed payment, contact support.');
      return;
    }

    async function confirm() {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        router.replace(`/login?next=/payment/success?token=${orderId}`);
        return;
      }

      try {
        const res = await fetch('/api/paypal/confirm', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ orderId }),
        });
        const data = await res.json() as { success?: boolean; error?: string };

        if (!res.ok || !data.success) {
          setState('error');
          setErrorMsg(data.error || 'Payment confirmation failed. Contact support if you were charged.');
          return;
        }

        await refreshPlan();
        setState('success');
      } catch {
        setState('error');
        setErrorMsg('Network error during confirmation. Contact support if you were charged.');
      }
    }

    confirm();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-8 text-center">
        <Link href="/" className="inline-flex items-center gap-2 group">
          <div className="w-10 h-10 rounded-xl bg-primary flex items-center justify-center group-hover:scale-105 transition-transform">
            <Zap className="w-5 h-5 text-primary-foreground" fill="currentColor" />
          </div>
        </Link>

        {state === 'loading' && (
          <div className="space-y-4">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
              <Loader2 className="w-8 h-8 text-primary animate-spin" />
            </div>
            <div>
              <h1 className="text-xl font-bold">Confirming payment...</h1>
              <p className="text-sm text-muted-foreground mt-1">Verifying with PayPal and activating your account.</p>
            </div>
          </div>
        )}

        {state === 'success' && (
          <div className="space-y-6">
            <div className="w-20 h-20 rounded-full bg-amber-500/15 flex items-center justify-center mx-auto">
              <Crown className="w-10 h-10 text-amber-400" />
            </div>
            <div className="space-y-2">
              <h1 className="text-2xl font-bold">You are now Pro</h1>
              <p className="text-muted-foreground text-sm">
                Payment confirmed. Your account has been upgraded — you can now deploy workflows directly to n8n.
              </p>
            </div>
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-left space-y-2">
              <p className="text-sm font-semibold text-amber-400 flex items-center gap-2">
                <Crown className="w-4 h-4" /> Pro plan includes
              </p>
              <ul className="space-y-1.5 text-xs text-muted-foreground">
                {[
                  'Deploy workflows directly to n8n',
                  'Automatic credential provisioning',
                  'One-click workflow activation',
                  'Unlimited workflow generation',
                ].map(item => (
                  <li key={item} className="flex items-center gap-2">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <Button onClick={() => router.push('/builder')} className="w-full gap-2">
              <Zap className="w-4 h-4" />
              Start building
              <ArrowRight className="w-4 h-4 ml-auto" />
            </Button>
          </div>
        )}

        {state === 'error' && (
          <div className="space-y-6">
            <div className="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center mx-auto">
              <AlertCircle className="w-8 h-8 text-red-400" />
            </div>
            <div className="space-y-2">
              <h1 className="text-xl font-bold">Something went wrong</h1>
              <p className="text-sm text-muted-foreground">{errorMsg}</p>
            </div>
            <div className="rounded-lg border border-border bg-muted/10 p-3 text-left text-xs text-muted-foreground">
              If you were charged and your plan was not upgraded, email us with your PayPal transaction ID.
            </div>
            <Button onClick={() => router.push('/builder')} className="w-full gap-2">
              <ArrowRight className="w-4 h-4" /> Back to builder
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

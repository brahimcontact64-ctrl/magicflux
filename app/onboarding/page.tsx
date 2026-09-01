'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Zap, Loader as Loader2, Check, ArrowRight, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/utils';
import { getOnboardingToolOptions } from '@/lib/onboarding-capabilities';

const INTEREST_OPTIONS = [
  'Sales',
  'Customer support',
  'Marketing',
  'Operations',
  'E-commerce',
  'Personal productivity',
  'Other',
];

const TOTAL_STEPS = 3;

function ProgressDots({ step }: { step: number }) {
  return (
    <div className="flex items-center justify-center gap-1.5" role="progressbar" aria-valuenow={step} aria-valuemin={1} aria-valuemax={TOTAL_STEPS} aria-label={`Step ${step} of ${TOTAL_STEPS}`}>
      {Array.from({ length: TOTAL_STEPS }, (_, i) => i + 1).map((n) => (
        <span
          key={n}
          className={cn(
            'h-1.5 rounded-full transition-all',
            n === step ? 'w-6 bg-primary' : n < step ? 'w-1.5 bg-primary/50' : 'w-1.5 bg-muted',
          )}
        />
      ))}
    </div>
  );
}

function SelectableChip({
  label,
  selected,
  onToggle,
  badge,
}: {
  label: string;
  selected: boolean;
  onToggle: () => void;
  badge?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      onClick={onToggle}
      className={cn(
        'flex items-center gap-2 rounded-xl border px-4 py-3.5 text-left text-sm font-medium transition-colors w-full',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
        selected
          ? 'border-primary bg-primary/10 text-foreground'
          : 'border-border bg-muted/20 text-foreground hover:bg-muted/40',
      )}
    >
      <span
        className={cn(
          'flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md border transition-colors',
          selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
        )}
      >
        {selected && <Check className="h-3.5 w-3.5" />}
      </span>
      <span className="flex-1 truncate">{label}</span>
      {badge && (
        <span className="flex-shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {badge}
        </span>
      )}
    </button>
  );
}

export default function OnboardingPage() {
  const router = useRouter();
  const { user, session, loading: authLoading } = useAuth();

  const [checkingStatus, setCheckingStatus] = useState(true);
  const [step, setStep] = useState(1);
  const [interests, setInterests] = useState<string[]>([]);
  const [tools, setTools] = useState<string[]>([]);
  const [intentText, setIntentText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const toolOptions = getOnboardingToolOptions();

  // Auth guard — same pattern as /builder.
  useEffect(() => {
    if (!authLoading && !user) router.replace('/login');
  }, [authLoading, user, router]);

  // Server-authoritative check: returning/grandfathered users bounce to
  // /builder before the wizard ever renders (Phase 9.2 Step D — no repeat
  // onboarding, no flash of the wizard for users who shouldn't see it).
  useEffect(() => {
    if (authLoading || !user || !session?.access_token) return;
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch('/api/onboarding/status', {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        const data = await res.json().catch(() => null) as { shouldOnboard?: boolean } | null;
        if (cancelled) return;
        if (!res.ok || data?.shouldOnboard === false) {
          router.replace('/builder');
          return;
        }
        setCheckingStatus(false);
      } catch {
        // Network error checking status — fail open to the wizard rather
        // than trapping the user on a blank screen; skip remains available.
        if (!cancelled) setCheckingStatus(false);
      }
    })();

    return () => { cancelled = true; };
  }, [authLoading, user, session?.access_token, router]);

  const toggleInterest = useCallback((label: string) => {
    setInterests((prev) => (prev.includes(label) ? prev.filter((i) => i !== label) : [...prev, label]));
  }, []);

  const toggleTool = useCallback((key: string) => {
    setTools((prev) => (prev.includes(key) ? prev.filter((t) => t !== key) : [...prev, key]));
  }, []);

  const finish = useCallback(async (skippedFrom?: number) => {
    if (!session?.access_token) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/onboarding/complete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
      });
      if (!res.ok) {
        setError('Could not save your progress. You can still continue.');
      }
      const trimmed = intentText.trim();
      const destination = trimmed ? `/builder?intent=${encodeURIComponent(trimmed)}` : '/builder';
      router.push(destination);
    } catch {
      setError('Network error. You can still continue.');
      router.push('/builder');
    } finally {
      setSubmitting(false);
    }
    void skippedFrom;
  }, [session?.access_token, intentText, router]);

  if (authLoading || checkingStatus) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-3">
          <Link href="/" className="inline-flex items-center gap-2 group">
            <div className="w-10 h-10 rounded-xl bg-primary flex items-center justify-center group-hover:scale-105 transition-transform">
              <Zap className="w-5 h-5 text-primary-foreground" fill="currentColor" />
            </div>
          </Link>
          <ProgressDots step={step} />
        </div>

        {/* min-height wrapper keeps step transitions from shifting page height */}
        <div className="rounded-2xl border border-border bg-card p-6 space-y-5 min-h-[380px] flex flex-col">
          <div className="flex-1 space-y-5">
            {step === 1 && (
              <div className="space-y-5">
                <div className="space-y-1.5 text-center">
                  <h1 className="text-xl font-semibold tracking-tight">What do you want MagicFlux to help with?</h1>
                  <p className="text-sm text-muted-foreground">Pick as many as you like — this just helps us get started.</p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" role="group" aria-label="Areas you want help with">
                  {INTEREST_OPTIONS.map((label) => (
                    <SelectableChip key={label} label={label} selected={interests.includes(label)} onToggle={() => toggleInterest(label)} />
                  ))}
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-5">
                <div className="space-y-1.5 text-center">
                  <h1 className="text-xl font-semibold tracking-tight">What tools do you currently use?</h1>
                  <p className="text-sm text-muted-foreground">We&apos;ll show you what&apos;s ready today and what&apos;s coming soon.</p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" role="group" aria-label="Tools you currently use">
                  {toolOptions.map((tool) => (
                    <SelectableChip
                      key={tool.key}
                      label={tool.label}
                      selected={tools.includes(tool.key)}
                      onToggle={() => toggleTool(tool.key)}
                      badge={tool.available ? 'Available' : 'Coming soon'}
                    />
                  ))}
                </div>
              </div>
            )}

            {step === 3 && (
              <div className="space-y-5">
                <div className="space-y-1.5 text-center">
                  <h1 className="text-xl font-semibold tracking-tight">What would you like to automate first?</h1>
                  <p className="text-sm text-muted-foreground">Describe it in plain English — you&apos;ll be able to review and edit everything before it goes live.</p>
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="onboarding-intent" className="sr-only">Describe your first automation</label>
                  <textarea
                    id="onboarding-intent"
                    value={intentText}
                    onChange={(e) => setIntentText(e.target.value)}
                    placeholder="e.g. When a new order arrives, notify my team on Slack"
                    rows={4}
                    className="w-full bg-muted/30 border border-border rounded-lg px-3 py-2.5 text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
                  />
                </div>
                {error && (
                  <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2.5">
                    <p className="text-sm text-red-400">{error}</p>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Navigation */}
          <div className="flex items-center justify-between gap-2 pt-2">
            <div>
              {step > 1 && (
                <Button type="button" variant="ghost" size="sm" onClick={() => setStep((s) => s - 1)} disabled={submitting} className="gap-1.5">
                  <ArrowLeft className="w-3.5 h-3.5" />
                  Back
                </Button>
              )}
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => finish(step)}
                disabled={submitting}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors underline-offset-2 hover:underline disabled:opacity-50"
              >
                Skip
              </button>
              {step < TOTAL_STEPS ? (
                <Button type="button" onClick={() => setStep((s) => s + 1)} disabled={submitting} className="gap-1.5">
                  Continue
                  <ArrowRight className="w-3.5 h-3.5" />
                </Button>
              ) : (
                <Button type="button" onClick={() => finish()} disabled={submitting} className={cn('gap-1.5', submitting && 'opacity-70')}>
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                  {submitting ? 'Starting...' : 'Start building'}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

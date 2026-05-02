'use client';

import { useState } from 'react';
import { Loader as Loader2, CircleCheck as CheckCircle2, Zap, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { supabase } from '@/lib/supabase-client';

export function Waitlist() {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;

    setStatus('loading');

    const { error } = await supabase.from('waitlist_signups').insert({
      email: email.trim(),
      name: name.trim(),
      company: company.trim()
    });

    if (error) {
      if (error.code === '23505') {
        setMessage("You're already on the list! We'll be in touch.");
        setStatus('success');
      } else {
        setMessage('Something went wrong. Please try again.');
        setStatus('error');
      }
    } else {
      setMessage("You're on the list! We'll notify you when Pro launches.");
      setStatus('success');
    }
  }

  return (
    <section id="waitlist" className="py-24 relative overflow-hidden">
      {/* Background */}
      <div className="absolute inset-0 grid-pattern opacity-30" />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px] rounded-full bg-primary/8 blur-[150px] pointer-events-none" />

      <div className="relative z-10 max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        {/* Badge */}
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-medium mb-8">
          <Zap className="w-3 h-3" />
          Early Access — Limited spots available
        </div>

        <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
          Be first when{' '}
          <span className="text-gradient">Pro launches</span>
        </h2>
        <p className="text-muted-foreground mb-10 leading-relaxed">
          Join the waitlist for early access to Pro features: unlimited generations, saved libraries, custom integrations, and more. Early members get 50% off for life.
        </p>

        {status === 'success' ? (
          <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-8 flex flex-col items-center gap-4">
            <CheckCircle2 className="w-12 h-12 text-emerald-400" />
            <p className="text-lg font-semibold">{message}</p>
            <p className="text-sm text-muted-foreground">We'll send you an email as soon as early access opens.</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="grid sm:grid-cols-2 gap-3">
              <Input
                type="text"
                placeholder="Your name"
                value={name}
                onChange={e => setName(e.target.value)}
                className="h-11 bg-card border-border focus:border-primary"
              />
              <Input
                type="text"
                placeholder="Company (optional)"
                value={company}
                onChange={e => setCompany(e.target.value)}
                className="h-11 bg-card border-border focus:border-primary"
              />
            </div>
            <div className="flex gap-3">
              <Input
                type="email"
                placeholder="your@email.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                className="h-11 flex-1 bg-card border-border focus:border-primary"
              />
              <Button
                type="submit"
                disabled={status === 'loading' || !email.trim()}
                className="h-11 px-6 gap-2 shadow-lg shadow-primary/20 whitespace-nowrap"
              >
                {status === 'loading' ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <>
                    Join Waitlist
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </Button>
            </div>

            {status === 'error' && (
              <p className="text-sm text-destructive text-left">{message}</p>
            )}

            <p className="text-xs text-muted-foreground">
              No spam, ever. Unsubscribe at any time.
            </p>
          </form>
        )}

        {/* Trust indicators */}
        <div className="mt-10 flex flex-wrap justify-center gap-6 text-xs text-muted-foreground">
          {['100+ on waitlist', 'Early access pricing', 'No credit card required'].map(item => (
            <span key={item} className="flex items-center gap-1.5">
              <span className="w-1 h-1 rounded-full bg-primary" />
              {item}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

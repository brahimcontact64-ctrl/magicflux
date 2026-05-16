'use client';

import { useState } from 'react';
import {
  X, Sparkles, CircleCheck as CheckCircle2, Loader as Loader2,
  ChevronRight, Clock, Shield, Users, Star, Zap
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { supabase } from '@/lib/supabase-client';
import { cn } from '@/lib/utils';

const MANAGED_PERKS = [
  { icon: Shield, label: 'We handle all n8n setup' },
  { icon: Clock, label: '48-hour delivery SLA' },
  { icon: Users, label: 'Dedicated workflow engineer' },
  { icon: Star, label: '30-day support included' }
];

const REQUEST_TYPES = [
  { id: 'setup', label: 'Full Setup & Deploy', description: 'We set up and deploy the entire automation for you', price: '$97' },
  { id: 'customization', label: 'Custom Modifications', description: 'Modify an existing workflow to fit your exact needs', price: '$47' },
  { id: 'support', label: 'Ongoing Support', description: 'Monthly support and maintenance for your automations', price: '$29/mo' }
];

interface ManagedRequestModalProps {
  templateId: string;
  templateName: string;
  onClose: () => void;
}

export function ManagedRequestModal({ templateId, templateName, onClose }: ManagedRequestModalProps) {
  const [step, setStep] = useState<'choose' | 'details' | 'success'>('choose');
  const [requestType, setRequestType] = useState('setup');
  const [email, setEmail] = useState('');
  const [description, setDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit() {
    if (!email.trim()) return;
    setIsSubmitting(true);

    const desc = description.trim() || `Request for ${templateName}`;
    const { data } = await supabase.from('managed_requests').insert({
      user_id: (await supabase.auth.getUser()).data.user?.id ?? undefined,
      template_id: templateId,
      template_name: templateName,
      request_type: requestType,
      description: desc,
      contact_email: email.trim(),
      status: 'new'
    }).select('id').maybeSingle();

    if (data?.id) {
      fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/notify-managed-request`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({
          requestId: data.id,
          templateName,
          requestType,
          contactEmail: email.trim(),
          description: desc,
        }),
      }).catch(() => {});
    }

    setIsSubmitting(false);
    setStep('success');
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card shadow-2xl shadow-black/40 overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-border bg-gradient-to-r from-primary/10 to-primary/5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-primary/20 border border-primary/30 flex items-center justify-center">
              <Sparkles className="w-4.5 h-4.5 text-primary" />
            </div>
            <div>
              <p className="text-sm font-semibold">Managed Service</p>
              <p className="text-xs text-muted-foreground">We build and run it for you</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-muted/50 text-muted-foreground transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {step === 'success' ? (
          <div className="p-6 text-center space-y-4">
            <div className="w-14 h-14 rounded-full bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center mx-auto">
              <CheckCircle2 className="w-7 h-7 text-emerald-400" />
            </div>
            <div>
              <h3 className="font-semibold text-base mb-1">Request Received!</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                We'll review your request and reach out within 24 hours to get started on your{' '}
                <strong>{templateName}</strong> automation.
              </p>
            </div>
            <div className="rounded-lg border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
              Check your inbox at <span className="text-foreground font-medium">{email}</span> for a confirmation and next steps.
            </div>
            <Button onClick={onClose} className="w-full gap-2">
              <Zap className="w-4 h-4" />
              Got it, thanks!
            </Button>
          </div>
        ) : step === 'choose' ? (
          <div className="p-5 space-y-4">
            {/* Perks */}
            <div className="grid grid-cols-2 gap-2">
              {MANAGED_PERKS.map(perk => (
                <div key={perk.label} className="flex items-center gap-2 text-xs text-muted-foreground">
                  <perk.icon className="w-3.5 h-3.5 text-primary flex-shrink-0" />
                  {perk.label}
                </div>
              ))}
            </div>

            {/* Request type */}
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Choose service</p>
              {REQUEST_TYPES.map(type => (
                <button
                  key={type.id}
                  onClick={() => setRequestType(type.id)}
                  className={cn(
                    'w-full rounded-xl border p-3.5 text-left flex items-center gap-3 transition-all',
                    requestType === type.id
                      ? 'border-primary/50 bg-primary/5'
                      : 'border-border hover:border-primary/30 hover:bg-muted/20'
                  )}
                >
                  <div className={cn(
                    'w-3 h-3 rounded-full border-2 flex-shrink-0 transition-all',
                    requestType === type.id ? 'border-primary bg-primary' : 'border-muted-foreground'
                  )} />
                  <div className="flex-1">
                    <p className="text-sm font-medium">{type.label}</p>
                    <p className="text-xs text-muted-foreground">{type.description}</p>
                  </div>
                  <span className="text-sm font-semibold text-primary">{type.price}</span>
                </button>
              ))}
            </div>

            <div className="rounded-lg border border-border bg-muted/20 px-3 py-2.5">
              <p className="text-xs text-muted-foreground">
                <strong className="text-foreground">Template:</strong> {templateName}
              </p>
            </div>

            <Button onClick={() => setStep('details')} className="w-full gap-2 font-medium">
              Continue
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        ) : (
          <div className="p-5 space-y-4">
            <div>
              <label className="block text-xs font-medium mb-1.5">Your email</label>
              <input
                type="email"
                placeholder="you@company.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="w-full px-3 py-2.5 text-sm rounded-lg border border-border bg-background focus:outline-none focus:border-primary transition-colors"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1.5">
                Any specific requirements? <span className="text-muted-foreground font-normal">(optional)</span>
              </label>
              <textarea
                placeholder="e.g. I use Gmail + Airtable, need notifications in Slack channel #operations..."
                value={description}
                onChange={e => setDescription(e.target.value)}
                rows={3}
                className="w-full px-3 py-2.5 text-sm rounded-lg border border-border bg-background focus:outline-none focus:border-primary transition-colors resize-none"
              />
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setStep('choose')} className="flex-1 h-9 text-sm">
                Back
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={!email.trim() || isSubmitting}
                className="flex-1 h-9 text-sm gap-2"
              >
                {isSubmitting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <>
                    <Sparkles className="w-4 h-4" />
                    Request Service
                  </>
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground text-center">
              No payment required upfront. We'll confirm scope and pricing before starting.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

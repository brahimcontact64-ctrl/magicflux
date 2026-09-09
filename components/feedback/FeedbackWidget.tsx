'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { MessageSquarePlus, Star, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/auth-context';

type Category = 'general' | 'bug' | 'feature_request';

const CATEGORIES: Array<{ value: Category; label: string }> = [
  { value: 'general', label: 'General feedback' },
  { value: 'bug', label: 'Bug report' },
  { value: 'feature_request', label: 'Feature request' },
];

/**
 * Phase 9.6 Section 3 — first-party feedback widget.
 *
 * Only the fields the user fills in here are ever sent. Only safe
 * operational context (current page path) is attached automatically by
 * the API route from the request itself -- nothing here reads or attaches
 * workflow content, credentials, or auth headers beyond the normal
 * Authorization bearer token every authenticated call already sends.
 */
export function FeedbackWidget() {
  const { session } = useAuth();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<Category>('general');
  const [rating, setRating] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (!session) return null; // feedback requires a signed-in account (attaches user id)

  async function handleSubmit() {
    setSubmitting(true);
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session!.access_token}`,
        },
        body: JSON.stringify({ category, rating, comment: comment.trim() || undefined, pagePath: pathname }),
      });
      const data = (await res.json().catch(() => ({}))) as { message?: string };

      if (res.status === 503) {
        toast.info(data.message ?? "Feedback isn't available yet — check back soon.");
        return;
      }
      if (!res.ok) {
        toast.error(data.message ?? 'Could not send feedback');
        return;
      }

      toast.success('Thanks — feedback sent.');
      setOpen(false);
      setCategory('general');
      setRating(null);
      setComment('');
    } catch {
      toast.error('Network error sending feedback');
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit = Boolean(comment.trim()) || rating != null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5 text-xs">
          <MessageSquarePlus className="h-3.5 w-3.5" />
          Feedback
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Send feedback</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex gap-1.5">
            {CATEGORIES.map((c) => (
              <button
                key={c.value}
                type="button"
                onClick={() => setCategory(c.value)}
                className={cn(
                  'rounded-lg border px-2.5 py-1.5 text-xs transition-colors',
                  category === c.value
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:bg-muted/40',
                )}
              >
                {c.label}
              </button>
            ))}
          </div>

          <div>
            <p className="mb-1.5 text-xs text-muted-foreground">Rating (optional)</p>
            <div className="flex gap-1">
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} type="button" onClick={() => setRating(rating === n ? null : n)} aria-label={`${n} star${n > 1 ? 's' : ''}`}>
                  <Star className={cn('h-5 w-5', rating != null && n <= rating ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground')} />
                </button>
              ))}
            </div>
          </div>

          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="What's on your mind? (Don't paste real credentials — only include workflow details if you want us to see them.)"
            rows={4}
            className="w-full rounded-lg border border-border bg-muted/20 px-3 py-2 text-sm placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary/30"
          />

          <Button className="w-full gap-2" disabled={!canSubmit || submitting} onClick={handleSubmit}>
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {submitting ? 'Sending...' : 'Send feedback'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

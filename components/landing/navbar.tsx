'use client';

import Link from 'next/link';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Zap, Menu, X, Crown, LogOut, ChevronDown, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme-toggle';
import { useAuth } from '@/lib/auth-context';
import { supabase } from '@/lib/supabase-client';
import { cn } from '@/lib/utils';

const ISOLATE_A = process.env.NEXT_PUBLIC_MF_BUILD_ISOLATE_A === '1';

const NAV_LINKS = [
  { href: '#how-it-works', label: 'How it works' },
  { href: '#managed', label: 'Done For You' },
  { href: '/marketplace', label: 'Marketplace' },
  { href: '#pricing', label: 'Pricing' },
  { href: '/dashboard', label: 'Dashboard' },
];

function UserDropdown() {
  const { user, signOut } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [upgrading, setUpgrading] = useState(false);

  if (!user) return null;

  // Business is also a real, purchasable paid tier -- "has paid access"
  // means anything above Free, not literally 'pro'.
  const isPro = user.plan === 'pro' || user.plan === 'business';

  // Phase 9.3.2 Step I: real Stripe subscription checkout. Previously
  // called /api/paypal/create-order -- PayPal is not the V1 provider.
  async function handleUpgrade() {
    if (ISOLATE_A) return;

    setUpgrading(true);
    setOpen(false);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({ plan: 'pro' }),
      });
      const data = await res.json() as { url?: string };
      if (data.url && typeof window !== 'undefined') window.location.href = data.url;
      else setUpgrading(false);
    } catch {
      setUpgrading(false);
    }
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border hover:bg-secondary transition-colors text-sm"
      >
        <div className={cn('w-5 h-5 rounded-full flex items-center justify-center', isPro ? 'bg-amber-500/20' : 'bg-primary/20')}>
          {isPro ? <Crown className="w-3 h-3 text-amber-400" /> : <User className="w-3 h-3 text-primary" />}
        </div>
        <span className="max-w-[120px] truncate hidden sm:block">{user.email}</span>
        <ChevronDown className={cn('w-3.5 h-3.5 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-2 z-50 w-60 rounded-xl border border-border bg-card shadow-xl shadow-black/20 p-1.5 space-y-0.5">
            <div className="px-3 py-2.5 space-y-1">
              <p className="text-sm font-medium truncate">{user.email}</p>
              <span className={cn(
                'inline-block text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded border',
                isPro
                  ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                  : 'bg-muted text-muted-foreground border-border'
              )}>
                {user.plan === 'business' ? 'Business' : isPro ? 'Pro' : 'Free plan'}
              </span>
            </div>
            <div className="h-px bg-border" />
            {!isPro && (
              <button
                onClick={handleUpgrade}
                disabled={upgrading}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-amber-500/10 text-sm text-amber-400 transition-colors"
              >
                <Crown className="w-4 h-4" />
                {upgrading ? 'Redirecting…' : 'Upgrade to Pro — $29'}
              </button>
            )}
            <Link href="/builder" onClick={() => setOpen(false)}
              className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-secondary text-sm text-muted-foreground hover:text-foreground transition-colors">
              <Zap className="w-4 h-4" />
              Builder
            </Link>
            <button
              onClick={async () => { await signOut(); router.push('/'); }}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-secondary text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <LogOut className="w-4 h-4" />
              Sign out
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function Navbar() {
  const { user, loading } = useAuth();
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = () => setScrolled(window.scrollY > 20);
    window.addEventListener('scroll', handler);
    return () => window.removeEventListener('scroll', handler);
  }, []);

  return (
    <header className={cn(
      'fixed top-0 left-0 right-0 z-50 transition-all duration-300',
      scrolled ? 'bg-background/90 backdrop-blur-xl border-b border-border shadow-sm' : 'bg-transparent'
    )}>
      <nav className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <Link href="/" className="flex items-center gap-2 group">
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center group-hover:scale-105 transition-transform">
              <Zap className="w-4 h-4 text-primary-foreground" fill="currentColor" />
            </div>
            <span className="font-semibold text-sm tracking-tight">
              MagicFlux
            </span>
          </Link>

          <div className="hidden md:flex items-center gap-1">
            {NAV_LINKS.map(link => (
              <a key={link.href} href={link.href}
                className="px-3 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors rounded-lg hover:bg-secondary">
                {link.label}
              </a>
            ))}
          </div>

          <div className="hidden md:flex items-center gap-2">
            <ThemeToggle />
            {!loading && (
              user ? (
                <UserDropdown />
              ) : (
                <div className="flex items-center gap-2">
                  <Link href="/login">
                    <Button variant="ghost" size="sm">Sign in</Button>
                  </Link>
                  <Link href="/builder">
                    <Button size="sm" className="gap-2 font-medium">
                      <Zap className="w-3.5 h-3.5" />
                      Start Building
                    </Button>
                  </Link>
                </div>
              )
            )}
          </div>

          <div className="flex md:hidden items-center gap-2">
            <ThemeToggle />
            <button onClick={() => setMobileOpen(!mobileOpen)}
              className="p-2 rounded-lg hover:bg-secondary transition-colors">
              {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>

        {mobileOpen && (
          <div className="md:hidden border-t border-border py-4 space-y-1">
            {NAV_LINKS.map(link => (
              <a key={link.href} href={link.href} onClick={() => setMobileOpen(false)}
                className="block px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg transition-colors">
                {link.label}
              </a>
            ))}
            <div className="pt-2 space-y-2">
              {user ? (
                <div className="px-3 py-2 text-sm text-muted-foreground">
                  Signed in as <span className="text-foreground font-medium">{user.email}</span>
                </div>
              ) : (
                <>
                  <Link href="/login" onClick={() => setMobileOpen(false)}>
                    <Button variant="outline" size="sm" className="w-full">Sign in</Button>
                  </Link>
                  <Link href="/builder" onClick={() => setMobileOpen(false)}>
                    <Button size="sm" className="w-full gap-2">
                      <Zap className="w-3.5 h-3.5" />
                      Start Building Free
                    </Button>
                  </Link>
                </>
              )}
            </div>
          </div>
        )}
      </nav>
    </header>
  );
}

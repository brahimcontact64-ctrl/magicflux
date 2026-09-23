'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Copy,
  Loader2,
  CheckCircle2,
  CircleAlert,
  Clock,
  ExternalLink,
  PlayCircle,
  StopCircle,
  ClipboardList,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/lib/auth-context';
import { supabase } from '@/lib/supabase-client';
import { PLATFORM_GUIDES, getPlatformGuide, type PlatformGuide } from '@/lib/connection-guide/platform-registry';
import { buildSamplePayload } from '@/lib/connection-guide/trigger-fields';
import { buildCodeSnippets, buildDeveloperHandoff } from '@/lib/connection-guide/code-snippets';

type WorkflowSummary = { id: string; name: string; status: string; workflow_json: { nodes?: Array<Record<string, unknown>> } };

type ConnectionInfo = {
  status: string;
  requiredFields: string[];
  optionalFields: string[];
  lastSuccessfulEventAt: string | null;
  testMode: { active: boolean; until: string | null; lastEvent: null | { receivedAt: string; authenticated: boolean; valid: boolean; missingFields: string[]; presentFields: string[] } };
};

const CONNECTION_TYPE_LABEL: Record<PlatformGuide['connectionType'], string> = {
  native: 'Native connection',
  plugin: 'Plugin connection',
  intermediary: 'Intermediary connection (Zapier/Make)',
  custom_api: 'Custom/API connection',
};

const CONNECTION_TYPE_CLASS: Record<PlatformGuide['connectionType'], string> = {
  native: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25',
  plugin: 'bg-blue-500/10 text-blue-400 border-blue-500/25',
  intermediary: 'bg-amber-500/10 text-amber-400 border-amber-500/25',
  custom_api: 'bg-muted text-muted-foreground border-border',
};

export default function ConnectWebsitePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user, session, loading: authLoading } = useAuth();

  const [workflow, setWorkflow] = useState<WorkflowSummary | null>(null);
  const [connection, setConnection] = useState<ConnectionInfo | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedPlatformId, setSelectedPlatformId] = useState('custom');
  const [testBusy, setTestBusy] = useState(false);
  const [includeSecretInHandoff, setIncludeSecretInHandoff] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const withAuthHeaders = useCallback(async (): Promise<HeadersInit | null> => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return null;
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }, []);

  const loadAll = useCallback(async () => {
    const headers = await withAuthHeaders();
    if (!headers) return;

    const [wfRes, connRes, secretRes] = await Promise.all([
      fetch(`/api/workflows/${params.id}`, { headers, cache: 'no-store' }),
      fetch(`/api/workflows/${params.id}/connection`, { headers, cache: 'no-store' }),
      fetch(`/api/workflows/${params.id}/webhook-secret`, { headers, cache: 'no-store' }),
    ]);

    if (wfRes.ok) {
      const payload = await wfRes.json();
      setWorkflow(payload.workflow);
    }
    if (connRes.ok) {
      setConnection(await connRes.json());
    } else if (connRes.status === 404) {
      toast.error('This workflow has no webhook trigger to connect.');
    }
    if (secretRes.ok) {
      const payload = await secretRes.json();
      setSecret(payload.secret ?? null);
    }
    setLoading(false);
  }, [params.id, withAuthHeaders]);

  useEffect(() => {
    if (!authLoading && user) loadAll();
  }, [authLoading, user, loadAll]);

  // Poll while a Test Connection session is active, so "Waiting -> Received
  // -> Valid" updates without a manual refresh.
  useEffect(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (connection?.testMode.active) {
      pollRef.current = setInterval(async () => {
        const headers = await withAuthHeaders();
        if (!headers) return;
        const res = await fetch(`/api/workflows/${params.id}/connection`, { headers, cache: 'no-store' });
        if (res.ok) setConnection(await res.json());
      }, 2000);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection?.testMode.active, params.id]);

  const webhookInfo = useMemo(() => {
    if (!workflow) return null;
    const nodes = workflow.workflow_json?.nodes ?? [];
    const webhookNode = nodes.find((n) => String(n.type ?? '').toLowerCase().includes('webhook') && !String(n.type ?? '').toLowerCase().includes('trigger.'));
    if (!webhookNode) return null;
    const method = String((webhookNode.parameters as Record<string, unknown> | undefined)?.httpMethod ?? 'POST').toUpperCase();
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    return { method, url: `${origin}/api/workflows/${workflow.id}/webhook` };
  }, [workflow]);

  const samplePayload = useMemo(() => {
    if (!connection) return {};
    const fields = [
      ...connection.requiredFields.map((name) => ({ name, required: true, source: 'template' as const })),
      ...connection.optionalFields.map((name) => ({ name, required: false, source: 'optional-block' as const })),
    ];
    return buildSamplePayload(fields);
  }, [connection]);

  const codeSnippets = useMemo(() => {
    if (!webhookInfo) return [];
    return buildCodeSnippets({
      webhookUrl: webhookInfo.url,
      method: webhookInfo.method,
      secretHeaderName: 'X-MagicFlux-Webhook-Secret',
      secretValue: secret ?? '<secret>',
      samplePayload,
    });
  }, [webhookInfo, secret, samplePayload]);

  const copyText = useCallback((text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => toast.success(`${label} copied`)).catch(() => toast.error('Copy failed'));
  }, []);

  const handleStartTest = useCallback(async () => {
    setTestBusy(true);
    try {
      const headers = await withAuthHeaders();
      if (!headers) return;
      const res = await fetch(`/api/workflows/${params.id}/connection/test`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action: 'start', ttlMinutes: 15 }),
      });
      const payload = await res.json();
      if (!res.ok) {
        toast.error(payload.error ?? 'Could not start Test Connection');
        return;
      }
      setConnection((prev) => (prev ? { ...prev, testMode: payload.testMode } : prev));
      toast.success('Waiting for an event from your platform…');
    } finally {
      setTestBusy(false);
    }
  }, [params.id, withAuthHeaders]);

  const handleStopTest = useCallback(async () => {
    setTestBusy(true);
    try {
      const headers = await withAuthHeaders();
      if (!headers) return;
      const res = await fetch(`/api/workflows/${params.id}/connection/test`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action: 'stop' }),
      });
      const payload = await res.json();
      if (res.ok) setConnection((prev) => (prev ? { ...prev, testMode: payload.testMode } : prev));
    } finally {
      setTestBusy(false);
    }
  }, [params.id, withAuthHeaders]);

  const handleCopyHandoff = useCallback(() => {
    if (!webhookInfo || !connection) return;
    const handoff = buildDeveloperHandoff({
      webhookUrl: webhookInfo.url,
      method: webhookInfo.method,
      secretHeaderName: 'X-MagicFlux-Webhook-Secret',
      secretValue: includeSecretInHandoff ? secret : null,
      requiredFields: connection.requiredFields,
      optionalFields: connection.optionalFields,
      samplePayload,
    });
    copyText(handoff, 'Developer handoff');
  }, [webhookInfo, connection, includeSecretInHandoff, secret, samplePayload, copyText]);

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!user) {
    router.push('/login');
    return null;
  }

  if (!workflow || !connection || !webhookInfo) {
    return (
      <div className="min-h-screen bg-background p-4 sm:p-6 max-w-2xl mx-auto">
        <Link href={`/dashboard/workflows/${params.id}`} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground mb-4">
          <ArrowLeft className="w-3.5 h-3.5" /> Back to workflow
        </Link>
        <div className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
          This workflow doesn&apos;t have a webhook trigger, so there&apos;s nothing to connect a website to.
        </div>
      </div>
    );
  }

  const guide = getPlatformGuide(selectedPlatformId) ?? PLATFORM_GUIDES[0];
  const canTest = connection.status !== 'active' && connection.status !== 'deployed';
  const lastEvent = connection.testMode.lastEvent;

  return (
    <div className="min-h-screen bg-background pb-16">
      <header className="border-b border-border px-4 py-3 flex items-center gap-3">
        <Link href={`/dashboard/workflows/${params.id}`} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="w-3.5 h-3.5" /> Back
        </Link>
        <h1 className="text-sm font-semibold">Connect your website</h1>
      </header>

      <main className="max-w-2xl mx-auto p-4 space-y-4">
        {/* Endpoint card */}
        <div className="rounded-xl border border-border bg-card p-4 space-y-3">
          <p className="text-sm font-semibold">Your production webhook</p>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="px-1.5 py-0.5 rounded bg-muted/40 text-muted-foreground font-mono">{webhookInfo.method}</span>
            <code className="flex-1 min-w-[220px] truncate rounded bg-black/20 border border-border px-2 py-1">{webhookInfo.url}</code>
            <Button size="sm" variant="outline" className="gap-1.5 h-7" onClick={() => copyText(webhookInfo.url, 'Webhook URL')}>
              <Copy className="w-3.5 h-3.5" /> Copy
            </Button>
          </div>

          <div className="rounded-md border border-border bg-background/40 p-2 space-y-1.5 text-xs">
            <p className="font-medium">Authentication header</p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="px-1.5 py-0.5 rounded bg-muted/40 font-mono">X-MagicFlux-Webhook-Secret</code>
              <code className="flex-1 min-w-[160px] truncate rounded bg-black/20 border border-border px-2 py-1 font-mono">
                {secret ? (revealed ? secret : '•'.repeat(24)) : 'Unavailable'}
              </code>
              <Button size="sm" variant="outline" className="h-7" onClick={() => setRevealed((r) => !r)} disabled={!secret}>
                {revealed ? 'Hide' : 'Reveal'}
              </Button>
              <Button size="sm" variant="outline" className="h-7 gap-1.5" onClick={() => secret && copyText(secret, 'Secret')} disabled={!secret}>
                <Copy className="w-3.5 h-3.5" /> Copy
              </Button>
            </div>
          </div>

          <div className="grid sm:grid-cols-2 gap-2 text-xs">
            <div className="rounded-md border border-border bg-background/40 p-2">
              <p className="text-muted-foreground mb-1">Required fields</p>
              <p className="font-mono">{connection.requiredFields.length ? connection.requiredFields.join(', ') : 'none detected'}</p>
            </div>
            <div className="rounded-md border border-border bg-background/40 p-2">
              <p className="text-muted-foreground mb-1">Optional fields</p>
              <p className="font-mono">{connection.optionalFields.length ? connection.optionalFields.join(', ') : 'none'}</p>
            </div>
          </div>

          <details className="rounded-md border border-border bg-background/40 p-2 text-[11px]">
            <summary className="cursor-pointer font-medium">Example payload</summary>
            <pre className="mt-2 rounded bg-black/20 border border-border p-2 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(samplePayload, null, 2)}</pre>
          </details>

          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            {connection.lastSuccessfulEventAt ? (
              <>
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                Last successful event: {new Date(connection.lastSuccessfulEventAt).toLocaleString()}
              </>
            ) : (
              <>
                <Clock className="w-3.5 h-3.5" />
                No inbound events received yet
              </>
            )}
          </div>
        </div>

        {/* Test Connection */}
        <div className="rounded-xl border border-border bg-card p-4 space-y-3">
          <p className="text-sm font-semibold">Test connection</p>
          {!canTest ? (
            <p className="text-xs text-muted-foreground">
              This workflow is already {connection.status}. Real traffic is never paused for testing -- pause it, or test again before your next activation.
            </p>
          ) : connection.testMode.active ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
                Waiting for an event from your platform… (expires {connection.testMode.until ? new Date(connection.testMode.until).toLocaleTimeString() : ''})
              </div>
              {lastEvent && (
                <div className={`rounded-md border p-2 text-xs ${lastEvent.authenticated && lastEvent.valid ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-amber-500/30 bg-amber-500/5'}`}>
                  {!lastEvent.authenticated ? (
                    <p className="text-amber-400 flex items-center gap-1.5"><CircleAlert className="w-3.5 h-3.5" /> Event received, but authentication failed. Check your secret/header.</p>
                  ) : lastEvent.valid ? (
                    <p className="text-emerald-400 flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5" /> Connected — payload valid.</p>
                  ) : (
                    <p className="text-amber-400 flex items-center gap-1.5"><CircleAlert className="w-3.5 h-3.5" /> Event received, but missing: {lastEvent.missingFields.join(', ')}</p>
                  )}
                </div>
              )}
              <Button size="sm" variant="outline" className="gap-1.5" onClick={handleStopTest} disabled={testBusy}>
                {testBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <StopCircle className="w-3.5 h-3.5" />}
                Stop test
              </Button>
            </div>
          ) : (
            <Button size="sm" className="gap-1.5" onClick={handleStartTest} disabled={testBusy}>
              {testBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlayCircle className="w-3.5 h-3.5" />}
              Start test
            </Button>
          )}
          <p className="text-[11px] text-muted-foreground">
            While testing, a real inbound event is validated but never executed — no emails, Slack messages, or Airtable records are created.
          </p>
        </div>

        {/* Platform selector */}
        <div className="rounded-xl border border-border bg-card p-4 space-y-3">
          <p className="text-sm font-semibold">Where is your website/store built?</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {PLATFORM_GUIDES.map((p) => (
              <button
                key={p.id}
                onClick={() => setSelectedPlatformId(p.id)}
                className={`rounded-lg border px-2.5 py-2 text-xs text-left transition-colors ${
                  selectedPlatformId === p.id ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/40'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="space-y-2 pt-2 border-t border-border">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded border ${CONNECTION_TYPE_CLASS[guide.connectionType]}`}>
                {CONNECTION_TYPE_LABEL[guide.connectionType]}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">{guide.summary}</p>
            <ol className="text-xs list-decimal list-inside space-y-1">
              {guide.steps.map((step, i) => <li key={i}>{step}</li>)}
            </ol>
            {guide.limitations.length > 0 && (
              <div className="rounded-md border border-amber-500/25 bg-amber-500/5 p-2 text-[11px] text-amber-300 space-y-1">
                {guide.limitations.map((l, i) => <p key={i}>{l}</p>)}
              </div>
            )}
            {guide.officialDocs.length > 0 && (
              <div className="flex flex-wrap gap-3 text-[11px]">
                {guide.officialDocs.map((d) => (
                  <a key={d.url} href={d.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                    {d.label} <ExternalLink className="w-3 h-3" />
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Code examples (custom-code only, but always available) */}
        <div className="rounded-xl border border-border bg-card p-4 space-y-3">
          <p className="text-sm font-semibold">Code examples</p>
          <Tabs defaultValue={codeSnippets[0]?.id}>
            <TabsList className="flex-wrap h-auto">
              {codeSnippets.map((s) => (
                <TabsTrigger key={s.id} value={s.id} className="text-xs">{s.label}</TabsTrigger>
              ))}
            </TabsList>
            {codeSnippets.map((s) => (
              <TabsContent key={s.id} value={s.id}>
                <div className="flex items-center justify-end mb-1">
                  <Button size="sm" variant="outline" className="h-6 gap-1" onClick={() => copyText(s.code, s.label)}>
                    <Copy className="w-3 h-3" /> Copy
                  </Button>
                </div>
                <pre className="rounded bg-black/20 border border-border p-2 overflow-auto whitespace-pre-wrap break-words text-[11px]">{s.code}</pre>
              </TabsContent>
            ))}
          </Tabs>
        </div>

        {/* Developer handoff */}
        <div className="rounded-xl border border-border bg-card p-4 space-y-3">
          <p className="text-sm font-semibold">Send to developer</p>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={includeSecretInHandoff} onChange={(e) => setIncludeSecretInHandoff(e.target.checked)} />
            Include the secret value (only share this with someone you trust to configure the integration)
          </label>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={handleCopyHandoff}>
            <ClipboardList className="w-3.5 h-3.5" /> Copy setup instructions
          </Button>
        </div>
      </main>
    </div>
  );
}

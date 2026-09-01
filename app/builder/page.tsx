'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Zap, ArrowLeft, PanelRightOpen, PanelRightClose, LayoutPanelLeft, Brain, LogOut, Crown, ChevronDown, Loader as Loader2, TriangleAlert, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme-toggle';
import { IndustrySelector } from '@/components/builder/industry-selector';
import { ChatInterface } from '@/components/builder/chat-interface';
import { IntegrationConnectModal } from '@/components/builder/integration-connect-modal';
import { ArchitectPanel } from '@/components/builder/architect-panel';
import { AUTOMATION_TEMPLATES, AutomationTemplate, Industry } from '@/lib/templates';
import { createAutomationPlanAsync, PlannerApiError, PlannerResult } from '@/lib/planner';
import { validateWorkflow, ValidationResult } from '@/lib/validator';
import { supabase } from '@/lib/supabase-client';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { requiredProvidersFromWorkflow, type IntegrationProvider } from '@/lib/integrations';
import { apiRequest } from '@/lib/api/client';

const ISOLATE_C = process.env.NEXT_PUBLIC_MF_BUILD_ISOLATE_C === '1';

type WorkflowTestResult = {
  success: boolean;
  logs: string[];
  output: Record<string, unknown> | null;
  error?: string;
  simulated?: boolean;
  simulationMessage?: string | null;
  statusLabel?: 'SIMULATED TEST' | 'LIVE SUCCESS' | 'FAILED';
};

type PlannerRejection = {
  code: 'CLARIFICATION_REQUIRED' | 'INCOMPLETE_INTENT' | 'UNSUPPORTED_REQUIREMENTS';
  mode?: 'clarification';
  message: string;
  missing?: Array<'trigger' | 'action' | 'data'>;
  questions?: string[];
  suggestions?: string[];
  examples?: string[];
};

type ExecutionMode = 'safe_preview' | 'staging_deploy' | 'production_deploy';

const MODE_STORAGE_KEY = 'magicflux.builder.execution_mode';
const MODE_SESSION_PREFIX = 'magicflux.builder.execution_mode.session.';

const EXECUTION_MODES: Array<{ value: ExecutionMode; label: string }> = [
  { value: 'safe_preview', label: 'Preview' },
  { value: 'staging_deploy', label: 'Staging' },
  { value: 'production_deploy', label: 'Production' },
];

// ── User menu ─────────────────────────────────────────────────────────────────

function UserMenu() {
  const { user, session, signOut, refreshPlan } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [activatingPro, setActivatingPro] = useState(false);

  // ⚠️ DEV ONLY — remove before production
  const SHOW_DEV = true; // fallback: set to false to rely solely on env var
  console.log('DEV BUTTON:', process.env.NEXT_PUBLIC_ENABLE_DEV_PRO_BUTTON);
  const devProEnabled = process.env.NEXT_PUBLIC_ENABLE_DEV_PRO_BUTTON === 'true' || SHOW_DEV;

  if (!user) return null;

  const isPro = user.plan === 'pro';

  async function handleUpgrade() {
    if (!session) return;
    setUpgrading(true);
    setOpen(false);
    try {
      const data = await apiRequest<{ approvalUrl?: string }>(
        '/api/paypal/create-order',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
        },
        'Could not start checkout'
      );
      if (data.approvalUrl && typeof window !== 'undefined') window.location.href = data.approvalUrl;
      else setUpgrading(false);
    } catch {
      setUpgrading(false);
    }
  }

  async function handleSignOut() {
    await signOut();
    router.push('/login');
  }

  async function handleDevActivatePro() {
    if (!session) return;
    setActivatingPro(true);
    setOpen(false);
    try {
      const res = await fetch('/api/dev/activate-pro', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) throw new Error('Failed');
      await refreshPlan();
      toast.success('Pro activated for testing 🧪');
    } catch {
      toast.error('Dev activation failed');
    } finally {
      setActivatingPro(false);
    }
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg hover:bg-muted/50 transition-colors text-xs"
      >
        <div className={cn(
          'w-5 h-5 rounded-full flex items-center justify-center',
          isPro ? 'bg-amber-500/20' : 'bg-primary/20'
        )}>
          {isPro ? <Crown className="w-3 h-3 text-amber-400" /> : <User className="w-3 h-3 text-primary" />}
        </div>
        <span className="hidden sm:block text-muted-foreground max-w-[120px] truncate">{user.email}</span>
        <ChevronDown className={cn('w-3 h-3 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-50 w-56 rounded-xl border border-border bg-card shadow-xl shadow-black/20 p-1.5 space-y-0.5">
            <div className="px-3 py-2 space-y-1">
              <p className="text-xs font-medium truncate">{user.email}</p>
              <span className={cn(
                'inline-block text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded border',
                isPro
                  ? 'bg-amber-500/15 text-amber-400 border-amber-500/20'
                  : 'bg-muted text-muted-foreground border-border'
              )}>
                {isPro ? 'Pro' : 'Free'}
              </span>
            </div>
            <div className="h-px bg-border" />
            {!isPro && (
              <button
                onClick={handleUpgrade}
                disabled={upgrading}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-amber-500/10 text-xs text-amber-400 transition-colors"
              >
                {upgrading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Crown className="w-3.5 h-3.5" />}
                {upgrading ? 'Redirecting...' : 'Upgrade to Pro — $29'}
              </button>
            )}
            {devProEnabled && (
              <button
                onClick={handleDevActivatePro}
                disabled={activatingPro}
                title="Development only — remove before production"
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-orange-500/20 text-xs text-orange-400 transition-colors border border-dashed border-orange-500/40"
              >
                {activatingPro ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <span>🧪</span>}
                DEV: Activate Pro for Testing 🧪
              </button>
            )}
            <button
              onClick={handleSignOut}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-muted/50 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <LogOut className="w-3.5 h-3.5" />
              Sign out
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ── Upgrade banner ────────────────────────────────────────────────────────────

function UpgradeBanner({ onUpgrade, upgrading }: { onUpgrade: () => void; upgrading: boolean }) {
  return (
    <div className="flex-shrink-0 border-b border-amber-500/20 bg-amber-500/5 px-4 py-2 flex items-center gap-3">
      <TriangleAlert className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
      <p className="text-xs text-amber-300 flex-1">
        <strong>Free plan</strong> — workflow generation is available. Activating a live workflow requires Pro.
      </p>
      <button
        onClick={onUpgrade}
        disabled={upgrading}
        className="flex items-center gap-1.5 text-xs font-semibold text-amber-400 hover:text-amber-300 transition-colors flex-shrink-0"
      >
        {upgrading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Crown className="w-3 h-3" />}
        {upgrading ? 'Redirecting...' : 'Upgrade — $29'}
      </button>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function BuilderPage() {
  if (ISOLATE_C) {
    return (
      <main className="min-h-screen p-6">
        <p className="text-sm text-muted-foreground">Builder temporarily isolated for build diagnostics.</p>
      </main>
    );
  }

  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, session, loading: authLoading } = useAuth();

  const [selectedIndustry, setSelectedIndustry] = useState<Industry | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<AutomationTemplate | null>(null);
  const [plannerResult, setPlannerResult] = useState<PlannerResult | null>(null);
  const [conversationSessionId, setConversationSessionId] = useState<string | null>(null);
  const [integrationWizardOpen, setIntegrationWizardOpen] = useState(false);
  const [integrationWizardProviders, setIntegrationWizardProviders] = useState<string[]>([]);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [outputOpen, setOutputOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  // Phase 9.2 — free-text automation intent carried over from onboarding
  // via ?intent=. Prefill only; the user still generates/reviews/activates
  // through the normal flow.
  const [initialIntent, setInitialIntent] = useState<string | null>(null);
  // isDeploying doubles as the generic "activating" busy flag for the single
  // Review & Activate CTA (Phase 9.1.5 — the old separate n8n live-deploy
  // state below it was removed along with the broken n8n deploy path).
  const [isDeploying, setIsDeploying] = useState(false);
  const [lastPrompt, setLastPrompt] = useState('');
  const [upgrading, setUpgrading] = useState(false);
  const [isCreatingManagedRequest, setIsCreatingManagedRequest] = useState(false);
  const [savedWorkflowId, setSavedWorkflowId] = useState<string | null>(null);
  const [requiredIntegrations, setRequiredIntegrations] = useState<IntegrationProvider[]>([]);
  const [missingIntegrations, setMissingIntegrations] = useState<IntegrationProvider[]>([]);
  const [isTestingWorkflow, setIsTestingWorkflow] = useState(false);
  const [testResult, setTestResult] = useState<WorkflowTestResult | null>(null);
  const [plannerRejection, setPlannerRejection] = useState<PlannerRejection | null>(null);
  const [mode, setMode] = useState<ExecutionMode>('staging_deploy');
  const [modeHydrated, setModeHydrated] = useState(false);

  const getAuthHeaders = useCallback((): HeadersInit | null => {
    if (!session?.access_token) {
      toast.error('Session expired. Please login again.');
      return null;
    }

    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    };
  }, [session]);

  const refreshIntegrationStatus = useCallback(async (workflowJson: unknown) => {
    const required = requiredProvidersFromWorkflow(workflowJson);
    setRequiredIntegrations(required);

    if (!session?.access_token) {
      setMissingIntegrations(required);
      return;
    }

    try {
      const headers = getAuthHeaders();
      if (!headers) return;

      const payload = await apiRequest<{
        integrations?: Array<{ provider: IntegrationProvider; status: 'connected' | 'invalid' | 'not_connected' }>;
      }>(
        '/api/integrations',
        { headers, cache: 'no-store' },
        'Failed to load integrations'
      );

      const connected = new Set(
        (payload?.integrations ?? [])
          .filter((row) => row.status === 'connected')
          .map((row) => row.provider)
      );
      setMissingIntegrations(required.filter((provider) => !connected.has(provider)));
    } catch {
      setMissingIntegrations(required);
    }
  }, [getAuthHeaders, session?.access_token]);

  // Auth guard — redirect unauthenticated users to /login
  useEffect(() => {
    if (!authLoading && !user) router.replace('/login');
  }, [authLoading, user, router]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    const templateId = searchParams.get('template');
    const industryId = searchParams.get('industry') as Industry | null;
    const intent = searchParams.get('intent');
    if (templateId) {
      const template = AUTOMATION_TEMPLATES.find(t => t.id === templateId);
      if (template) { setSelectedTemplate(template); setSelectedIndustry(template.industry); }
    } else if (industryId) {
      setSelectedIndustry(industryId);
    }
    if (intent) setInitialIntent(intent);
  }, [searchParams]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const sessionMode = conversationSessionId
      ? window.localStorage.getItem(`${MODE_SESSION_PREFIX}${conversationSessionId}`)
      : null;
    const persistedMode = window.localStorage.getItem(MODE_STORAGE_KEY);
    const candidate = (sessionMode ?? persistedMode) as ExecutionMode | null;

    if (
      candidate === 'safe_preview'
      || candidate === 'staging_deploy'
      || candidate === 'production_deploy'
    ) {
      setMode(candidate);
    }

    setModeHydrated(true);
  }, [conversationSessionId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!modeHydrated) return;
    window.localStorage.setItem(MODE_STORAGE_KEY, mode);
    if (conversationSessionId) {
      window.localStorage.setItem(`${MODE_SESSION_PREFIX}${conversationSessionId}`, mode);
    }
  }, [mode, conversationSessionId, modeHydrated]);

  const handleUpgrade = useCallback(async () => {
    if (!session) return;
    setUpgrading(true);
    try {
      const data = await apiRequest<{ approvalUrl?: string }>(
        '/api/paypal/create-order',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
        },
        'Could not start checkout'
      );
      if (data.approvalUrl && typeof window !== 'undefined') window.location.href = data.approvalUrl;
      else setUpgrading(false);
    } catch {
      setUpgrading(false);
    }
  }, [session]);

  // Canonical save path (Phase 9.1.5): every workflow created from the AI
  // Builder is saved through POST /api/workflows — the same entitlement-
  // checked, single-source-of-truth route used by /workflows/new-ai and the
  // rest of the product — instead of writing to the `workflows` table
  // directly from the browser client. This is what makes the workflow this
  // page produces the exact representation the real editor, validator,
  // activateWorkflow(), and certified runtime already expect.
  const saveWorkflowDraft = useCallback(async (params: {
    name: string;
    description: string;
    prompt: string;
    workflowJson: unknown;
  }): Promise<string | null> => {
    const headers = getAuthHeaders();
    if (!headers) return null;

    try {
      const res = await fetch('/api/workflows', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: params.name,
          description: params.description,
          prompt: params.prompt,
          workflow_json: params.workflowJson,
        }),
      });
      const data = await res.json().catch(() => null) as { workflow?: { id?: string }; error?: string; message?: string } | null;

      if (!res.ok) {
        toast.error(data?.message ?? data?.error ?? 'Could not save workflow');
        return null;
      }

      return data?.workflow?.id ?? null;
    } catch {
      toast.error('Network error while saving workflow');
      return null;
    }
  }, [getAuthHeaders]);

  const runPlanner = useCallback(async (prompt: string) => {
    try {
      const result = await createAutomationPlanAsync(prompt);

      const validationResult = validateWorkflow(result.plan, result.composition, result.n8nJson);
      setPlannerRejection(null);
      setPlannerResult(result);
      setValidation(validationResult);
      if (result.generationAdjusted || result.generationWarning) {
        toast.warning(result.generationWarning ?? 'Workflow adjusted to match your request');
      }
      setTestResult(null);
      setSavedWorkflowId(null);
      await refreshIntegrationStatus(result.n8nJson);

      supabase.from('automation_plans').insert({
        session_id: conversationSessionId ?? `session-${Date.now()}`,
        user_id: user?.id ?? null,
        prompt,
        plan_json: result.plan as unknown as Record<string, unknown>,
        composition_json: result.composition as unknown as Record<string, unknown>,
        n8n_json: result.n8nJson as unknown as Record<string, unknown>,
        env_config: result.envConfig,
        pattern: result.plan.pattern,
        trigger_type: result.plan.trigger.type,
        integrations: requiredProvidersFromWorkflow(result.n8nJson),
        complexity: result.plan.complexity,
        estimated_nodes: result.plan.estimatedNodes,
        confidence: result.plan.confidence,
        validation_score: validationResult.score,
        is_valid: validationResult.valid,
      }).then(() => {}, () => {});

      if (user?.id) {
        const id = await saveWorkflowDraft({
          name: result.plan.title,
          description: result.plan.description,
          prompt,
          workflowJson: result.n8nJson,
        });
        setSavedWorkflowId(id);
      }

      return result;
    } catch (error) {
      if (error instanceof PlannerApiError) {
        setPlannerResult(null);
        setValidation(null);
        setRequiredIntegrations([]);
        setMissingIntegrations([]);
        setSavedWorkflowId(null);
        setPlannerRejection({
          code: error.code,
          mode: error.mode,
          message: error.message,
          missing: error.missing,
          questions: error.questions,
          suggestions: error.suggestions,
          examples: error.examples,
        });
        toast.error(error.message);
        return null;
      }
      setPlannerRejection({
        code: 'CLARIFICATION_REQUIRED',
        message: error instanceof Error ? error.message : 'Planner failed',
      });
      setPlannerResult(null);
      setValidation(null);
      toast.error(error instanceof Error ? error.message : 'Planner failed');
      return null;
    }
  }, [conversationSessionId, refreshIntegrationStatus, saveWorkflowDraft, user]);

  async function handlePlannerReady(prompt: string) {
    setTestResult(null);

    setLastPrompt(prompt);
    const strictPlan = await runPlanner(prompt);
    if (strictPlan) {
      setOutputOpen(true);
      if (isMobile) setSidebarOpen(false);
    }
  }

  const handleOpenIntegrationWizard = useCallback((providers: string[], sessionId: string) => {
    setConversationSessionId(sessionId);
    setIntegrationWizardProviders(providers);
    setIntegrationWizardOpen(true);
  }, []);

  const handleIntegrationConnected = useCallback(async (provider: string) => {
    setIntegrationWizardProviders((prev) => {
      const next = prev.filter((p) => p !== provider);
      if (next.length === 0) setIntegrationWizardOpen(false);
      return next;
    });
    await refreshIntegrationStatus(plannerResult?.n8nJson ?? {});
  }, [plannerResult?.n8nJson, refreshIntegrationStatus]);

  function handleSelectTemplate(template: AutomationTemplate) {
    setSelectedTemplate(template);
    if (isMobile) setSidebarOpen(false);
  }

  // Ensures the currently generated plan has a saved workflows row (idempotent
  // — reuses savedWorkflowId if runPlanner's own save already succeeded),
  // via the same canonical POST /api/workflows path.
  const ensureWorkflowSaved = useCallback(async (): Promise<string | null> => {
    if (savedWorkflowId) return savedWorkflowId;
    if (!user?.id || !plannerResult) {
      toast.error('Generate a workflow first.');
      return null;
    }

    const id = await saveWorkflowDraft({
      name: plannerResult.plan.title,
      description: plannerResult.plan.description,
      prompt: lastPrompt,
      workflowJson: plannerResult.n8nJson,
    });
    setSavedWorkflowId(id);
    return id;
  }, [lastPrompt, plannerResult, saveWorkflowDraft, savedWorkflowId, user?.id]);

  const handleTestWorkflow = useCallback(async () => {
    const workflowId = await ensureWorkflowSaved();
    if (!workflowId) return;

    const headers = getAuthHeaders();
    if (!headers) return;

    setIsTestingWorkflow(true);
    try {
      const res = await fetch(`/api/workflows/${workflowId}/test`, {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });

      const payload = await res.json().catch(() => null) as {
        success?: boolean;
        status?: 'success' | 'failed' | 'simulated_success';
        message?: string;
        steps?: Array<{ nodeName?: string; status?: string; logs?: string[]; error?: string }>;
        finalOutput?: Record<string, unknown>;
        error?: string;
        missingIntegrations?: string[];
        simulated?: boolean;
        simulationMessage?: string | null;
        warnings?: string[];
      } | null;

      if (!res.ok) {
        if (payload?.error === 'SETUP_REQUIRED') {
          router.push('/settings/integrations');
          return;
        }

        setTestResult({
          success: false,
          logs: ['Test failed.'],
          output: null,
          error: payload?.error ?? 'Test failed',
        });
        toast.error(payload?.error ?? 'Test failed');
        return;
      }

      const logs = (payload?.steps ?? []).flatMap((step) => {
        const intro = `${step.nodeName ?? 'Node'} (${step.status ?? 'unknown'})`;
        const stepLogs = step.logs ?? [];
        const maybeError = step.error ? [`Error: ${step.error}`] : [];
        return [intro, ...stepLogs, ...maybeError];
      });

      setTestResult({
        success: payload?.status === 'success',
        logs: [
          ...(payload?.simulated ? [payload?.simulationMessage ?? 'SIMULATED — no real API executed'] : []),
          ...(payload?.warnings ?? []),
          ...logs,
        ],
        output: payload?.finalOutput ?? null,
        simulated: payload?.simulated ?? true,
        simulationMessage: payload?.simulationMessage ?? null,
        statusLabel: payload?.status === 'simulated_success'
          ? 'SIMULATED TEST'
          : payload?.status === 'success'
            ? 'LIVE SUCCESS'
            : 'FAILED',
      });
      if (payload?.status === 'simulated_success') {
        toast.warning('SIMULATED TEST: No real APIs were called.');
      } else {
        toast.success(payload?.message ?? 'Test successful');
      }
    } catch {
      setTestResult({ success: false, logs: ['Unexpected error while testing workflow.'], output: null, error: 'Unexpected error' });
      toast.error('Test failed');
    } finally {
      setIsTestingWorkflow(false);
    }
  }, [ensureWorkflowSaved, getAuthHeaders, router]);

  // The single "make it real" action for this page (Phase 9.1.5): saves the
  // generated plan through the canonical workflow API, then hands off to the
  // real editor page, where Test/Validate/Activate all use the certified
  // native runtime (activateWorkflow() -> deployment version -> scheduler
  // sync -> webhook/retry/scheduler/self-heal). There is deliberately no
  // second "Deploy" action on this page anymore.
  const handleReviewAndActivate = useCallback(async () => {
    setIsDeploying(true);
    try {
      const workflowId = await ensureWorkflowSaved();
      if (!workflowId) return;
      router.push(`/dashboard/workflows/${workflowId}`);
    } finally {
      setIsDeploying(false);
    }
  }, [ensureWorkflowSaved, router]);

  const handleManagedUpgrade = useCallback(async () => {
    if (!user || !session || !plannerResult || isCreatingManagedRequest) return;

    setIsCreatingManagedRequest(true);
    try {
      const description = (lastPrompt || plannerResult.plan.description || 'Managed setup request from Builder').trim();
      const { data, error } = await supabase
        .from('managed_requests')
        .insert({
          user_id: user.id,
          template_id: selectedTemplate?.id ?? null,
          template_name: selectedTemplate?.name ?? plannerResult.plan.title ?? 'Builder Workflow',
          request_type: 'setup',
          description,
          contact_email: user.email,
          status: 'new',
        })
        .select('id')
        .maybeSingle();

      if (error) {
        throw error;
      }

      const requestId = data?.id;
      const checkoutUrl = requestId
        ? `/payment/checkout?type=managed&requestId=${encodeURIComponent(requestId)}`
        : '/payment/checkout?type=managed';

      router.push(checkoutUrl);
    } catch {
      setIsCreatingManagedRequest(false);
    }
  }, [isCreatingManagedRequest, lastPrompt, plannerResult, router, selectedTemplate, session, user]);

  function handleDownload() {
    if (!plannerResult || typeof window === 'undefined' || typeof document === 'undefined') return;
    const { plan, n8nJson, envConfig } = plannerResult;

    const jsonBlob = new Blob([JSON.stringify(n8nJson, null, 2)], { type: 'application/json' });
    const jsonUrl = URL.createObjectURL(jsonBlob);
    const a = document.createElement('a');
    a.href = jsonUrl; a.download = `${plan.title.replace(/\s+/g, '-').toLowerCase()}.json`; a.click();
    URL.revokeObjectURL(jsonUrl);

    const envBlob = new Blob([envConfig], { type: 'text/plain' });
    const envUrl = URL.createObjectURL(envBlob);
    const b = document.createElement('a');
    b.href = envUrl; b.download = '.env.example'; b.click();
    URL.revokeObjectURL(envUrl);
  }

  const showOutput = outputOpen && !plannerRejection && !!plannerResult;
  const isPro = user?.plan === 'pro';
  const hasMissingIntegrations = missingIntegrations.length > 0;
  const testDisabled = hasMissingIntegrations || isTestingWorkflow;
  // Entitlement (Pro vs Free) is checked server-side when the user clicks
  // Activate on the editor page, not here — this page only needs to know
  // whether it's safe to hand off to the editor at all.
  const reviewDisabled = isTestingWorkflow || isDeploying;

  if (authLoading) {
    return (
      <div className="h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      {/* Navbar */}
      <header className="flex-shrink-0 h-14 border-b border-border bg-card/50 backdrop-blur-sm flex items-center px-4 gap-3 z-20">
        <Link href="/" className="flex items-center gap-2 group mr-2">
          <div className="w-7 h-7 rounded-md bg-primary flex items-center justify-center group-hover:scale-105 transition-transform">
            <Zap className="w-3.5 h-3.5 text-primary-foreground" fill="currentColor" />
          </div>
          <span className="font-semibold text-sm hidden sm:block">
            MagicFlux
          </span>
        </Link>

        <div className="w-px h-4 bg-border" />

        <Link href="/" className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="w-3.5 h-3.5" />
          <span className="hidden sm:block">Home</span>
        </Link>

        <div className="flex-1" />

        {plannerResult && (
          <div className="flex items-center gap-1 px-2 py-1 rounded-md bg-muted/30 border border-border text-xs text-foreground">
            <Brain className="w-3 h-3" />
            <span>Architect</span>
          </div>
        )}

        <div className="flex items-center gap-1">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className={cn(
              'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs transition-colors',
              sidebarOpen ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            )}
          >
            <LayoutPanelLeft className="w-3.5 h-3.5" />
            <span className="hidden sm:block">Templates</span>
          </button>
          {plannerResult && (
            <button
              onClick={() => setOutputOpen(!outputOpen)}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs transition-colors',
                outputOpen ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              )}
            >
              {outputOpen ? <PanelRightClose className="w-3.5 h-3.5" /> : <PanelRightOpen className="w-3.5 h-3.5" />}
              <span className="hidden sm:block">Output</span>
            </button>
          )}
        </div>

        <ThemeToggle />
        <UserMenu />
      </header>

      {/* Upgrade banner for free users */}
      {!isPro && <UpgradeBanner onUpgrade={handleUpgrade} upgrading={upgrading} />}

      {/* Main */}
      <div className="flex-1 flex overflow-hidden">
        <aside className={cn(
          'flex-shrink-0 border-r border-border bg-card/30 transition-all duration-300 overflow-hidden',
          sidebarOpen ? 'w-56 lg:w-64' : 'w-0'
        )}>
          <div className="w-56 lg:w-64 h-full overflow-y-auto scrollbar-thin p-3">
            <IndustrySelector
              selectedIndustry={selectedIndustry}
              selectedTemplate={selectedTemplate}
              onSelectIndustry={setSelectedIndustry}
              onSelectTemplate={handleSelectTemplate}
            />
          </div>
        </aside>

        <main className="flex-1 flex flex-col overflow-hidden p-3 lg:p-4 min-w-0">
          <div className="mb-3 rounded-xl border border-border bg-card/50 px-3 py-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Execution mode</span>
              <div className="inline-flex rounded-md border border-border bg-muted/30 p-0.5">
                {EXECUTION_MODES.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => setMode(item.value)}
                    className={cn(
                      'px-2.5 py-1 text-xs rounded-md transition-colors',
                      mode === item.value
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="text-xs text-muted-foreground">
              Current mode: <span className="text-foreground font-medium">{mode}</span>
            </div>
          </div>

          <ChatInterface
            initialTemplate={selectedTemplate}
            initialPrompt={initialIntent}
            accessToken={session?.access_token ?? null}
            mode={mode}
            onPlannerReadyAction={handlePlannerReady}
            onConversationStateChangeAction={(state) => {
              setConversationSessionId(state.sessionId);
            }}
            onOpenIntegrationWizardAction={handleOpenIntegrationWizard}
          />

          {plannerRejection && (
            <div className={cn(
              'mt-3 rounded-xl border px-4 py-3 space-y-2',
              plannerRejection.code === 'UNSUPPORTED_REQUIREMENTS'
                ? 'border-red-500/30 bg-red-500/10'
                : 'border-amber-500/30 bg-amber-500/10'
            )}>
              <p className={cn(
                'text-sm font-semibold',
                plannerRejection.code === 'UNSUPPORTED_REQUIREMENTS' ? 'text-red-300' : 'text-amber-300'
              )}>
                {plannerRejection.code === 'INCOMPLETE_INTENT'
                  ? 'Incomplete request'
                  : plannerRejection.code === 'UNSUPPORTED_REQUIREMENTS'
                    ? 'Unsupported'
                    : 'Needs clarification'}
              </p>
              <p className="text-xs text-muted-foreground">{plannerRejection.message}</p>
              {plannerRejection.missing && plannerRejection.missing.length > 0 && (
                <p className="text-xs text-muted-foreground">Missing: {plannerRejection.missing.join(', ')}</p>
              )}
              {plannerRejection.questions && plannerRejection.questions.length > 0 && (
                <ul className="text-xs text-muted-foreground space-y-1">
                  {plannerRejection.questions.map((q, i) => (
                    <li key={i}>• {q}</li>
                  ))}
                </ul>
              )}
              {(plannerRejection.suggestions ?? plannerRejection.examples ?? []).length > 0 && (
                <ul className="text-xs text-muted-foreground space-y-1">
                  {(plannerRejection.suggestions ?? plannerRejection.examples ?? []).map((s, i) => (
                    <li key={i}>• {s}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {plannerResult && !plannerRejection && (
            <div className="mt-3 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold">Upgrade to Managed Setup 🚀</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Let our team build, configure integrations, and deploy this workflow for you.
                </p>
              </div>
              <Button
                onClick={handleManagedUpgrade}
                disabled={isCreatingManagedRequest}
                className="gap-2"
              >
                {isCreatingManagedRequest ? <Loader2 className="w-4 h-4 animate-spin" /> : <Crown className="w-4 h-4" />}
                {isCreatingManagedRequest ? 'Preparing checkout...' : 'Upgrade to Managed Setup 🚀'}
              </Button>
            </div>
          )}

          {plannerResult && !plannerRejection && (
            <div className="mt-3 rounded-xl border border-border bg-card p-4 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" className="gap-2" onClick={handleTestWorkflow} disabled={testDisabled}>
                  {isTestingWorkflow ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  Run Simulated Test ▶️
                </Button>
                {hasMissingIntegrations && (
                  <Button variant="outline" className="gap-2" onClick={() => router.push('/settings/integrations')}>
                    Open Integrations Settings
                  </Button>
                )}
                <Button className="gap-2" onClick={handleReviewAndActivate} disabled={reviewDisabled}>
                  {isDeploying ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  Review & Activate →
                </Button>
              </div>

              <div className="text-xs text-muted-foreground space-y-1">
                <p>Required integrations: {requiredIntegrations.length > 0 ? requiredIntegrations.join(', ') : 'None'}</p>
                {hasMissingIntegrations ? (
                  <p className="text-amber-400">⚠️ Missing integrations: {missingIntegrations.join(', ')}</p>
                ) : (
                  <p className="text-emerald-400">All required integrations connected.</p>
                )}
                {!isPro && <p className="text-amber-400">Activating a live workflow is Pro only. Testing and export remain free.</p>}
              </div>

              {testResult && (
                <div className={cn(
                  'rounded-lg border p-3 space-y-2',
                  testResult.statusLabel === 'SIMULATED TEST'
                    ? 'border-amber-500/30 bg-amber-500/5'
                    : testResult.success
                      ? 'border-emerald-500/30 bg-emerald-500/5'
                      : 'border-red-500/30 bg-red-500/5'
                )}>
                  <p className={cn(
                    'text-sm font-semibold',
                    testResult.statusLabel === 'SIMULATED TEST'
                      ? 'text-amber-300'
                      : testResult.success ? 'text-emerald-400' : 'text-red-400'
                  )}>
                    {testResult.statusLabel ?? (testResult.success ? 'LIVE SUCCESS' : 'FAILED')}
                  </p>
                  {testResult.statusLabel === 'SIMULATED TEST' && (
                    <p className="text-xs text-amber-200">No real APIs were called.</p>
                  )}
                  {testResult.error && <p className="text-xs text-red-300">{testResult.error}</p>}

                  <div>
                    <p className="text-xs font-medium mb-1">Logs</p>
                    <pre className="text-xs rounded-md bg-black/30 border border-border p-2 overflow-auto max-h-40">
                      {(testResult.logs ?? []).join('\n') || 'No logs'}
                    </pre>
                  </div>

                  {testResult.output && (
                    <p className="text-xs text-muted-foreground">
                      Output generated successfully and is ready for use.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </main>

        <aside className={cn(
          'flex-shrink-0 border-l border-border bg-card/30 transition-all duration-300 overflow-hidden',
          showOutput ? 'w-full sm:w-[440px] lg:w-[520px]' : 'w-0'
        )}>
          <div className="w-full sm:w-[440px] lg:w-[520px] h-full p-3 lg:p-4">
            {/* Phase 9.1.5: the n8n one-click-deploy / Pro-upgrade-card paths
                inside ArchitectPanel are intentionally not wired up here
                anymore — omitting onLiveDeploy/onDeploy/isPro/onUpgrade
                disables those blocks without touching that component's code
                (kept isolated as an optional adapter, not deleted). Review &
                Activate above is the one path forward. */}
            {plannerResult && validation && !plannerRejection ? (
              <ArchitectPanel
                plannerResult={plannerResult}
                validation={validation}
                onDownload={handleDownload}
                className="h-full"
              />
            ) : null}
          </div>
        </aside>
      </div>

      {!plannerRejection && plannerResult && !outputOpen && isMobile && (
        <div className="fixed bottom-4 right-4 z-30">
          <Button onClick={() => setOutputOpen(true)} size="sm" className="gap-2 shadow-xl shadow-primary/30">
            <PanelRightOpen className="w-4 h-4" />
            View Output
          </Button>
        </div>
      )}

      {conversationSessionId && session?.access_token && (
        <IntegrationConnectModal
          open={integrationWizardOpen}
          sessionId={conversationSessionId}
          providers={integrationWizardProviders}
          accessToken={session.access_token}
          onOpenChange={setIntegrationWizardOpen}
          onConnected={handleIntegrationConnected}
        />
      )}

      {/* suppress unused variable warning */}
      <span className="hidden">{lastPrompt}</span>
    </div>
  );
}

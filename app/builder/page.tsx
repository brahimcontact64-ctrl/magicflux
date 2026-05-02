'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Zap, ArrowLeft, PanelRightOpen, PanelRightClose, LayoutPanelLeft, Brain, Activity, LogOut, Crown, ChevronDown, Loader as Loader2, TriangleAlert, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme-toggle';
import { IndustrySelector } from '@/components/builder/industry-selector';
import { ChatInterface } from '@/components/builder/chat-interface';
import { OutputPanel } from '@/components/builder/output-panel';
import { ArchitectPanel } from '@/components/builder/architect-panel';
import { GenerationResult } from '@/lib/generator';
import { AUTOMATION_TEMPLATES, AutomationTemplate, Industry } from '@/lib/templates';
import { createAutomationPlanAsync, modifyPlan, PlannerResult } from '@/lib/planner';
import { validateWorkflow, ValidationResult } from '@/lib/validator';
import { supabase } from '@/lib/supabase-client';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/utils';
import { DeploymentLifecycle } from '@/components/builder/setup-wizard';
import { LiveDeployResult } from '@/components/builder/one-click-deploy';

type OutputMode = 'legacy' | 'architect';

// ── User menu ─────────────────────────────────────────────────────────────────

function UserMenu() {
  const { user, session, signOut } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [upgrading, setUpgrading] = useState(false);

  if (!user) return null;

  const isPro = user.plan === 'pro';

  async function handleUpgrade() {
    if (!session) return;
    setUpgrading(true);
    setOpen(false);
    try {
      const res = await fetch('/api/paypal/create-order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
      });
      const data = await res.json() as { approvalUrl?: string };
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
                {upgrading ? 'Redirecting...' : 'Upgrade to Pro — $19'}
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
        <strong>Free plan</strong> — workflow generation is available. Deploy to n8n requires Pro.
      </p>
      <button
        onClick={onUpgrade}
        disabled={upgrading}
        className="flex items-center gap-1.5 text-xs font-semibold text-amber-400 hover:text-amber-300 transition-colors flex-shrink-0"
      >
        {upgrading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Crown className="w-3 h-3" />}
        {upgrading ? 'Redirecting...' : 'Upgrade — $19'}
      </button>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function BuilderPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, session, loading: authLoading } = useAuth();

  const [selectedIndustry, setSelectedIndustry] = useState<Industry | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<AutomationTemplate | null>(null);
  const [generationResult, setGenerationResult] = useState<GenerationResult | null>(null);
  const [plannerResult, setPlannerResult] = useState<PlannerResult | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [outputOpen, setOutputOpen] = useState(false);
  const [outputMode, setOutputMode] = useState<OutputMode>('architect');
  const [isMobile, setIsMobile] = useState(false);
  const [isDeploying, setIsDeploying] = useState(false);
  const [deployedUrl, setDeployedUrl] = useState<string | null>(null);
  const [deployedWorkflowId, setDeployedWorkflowId] = useState<string | null>(null);
  const [deploymentLifecycle, setDeploymentLifecycle] = useState<DeploymentLifecycle>('draft_created');
  const [isCheckingActivation, setIsCheckingActivation] = useState(false);
  const [liveDeployResult, setLiveDeployResult] = useState<LiveDeployResult | null>(null);
  const [lastPrompt, setLastPrompt] = useState('');
  const [upgrading, setUpgrading] = useState(false);

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
    if (templateId) {
      const template = AUTOMATION_TEMPLATES.find(t => t.id === templateId);
      if (template) { setSelectedTemplate(template); setSelectedIndustry(template.industry); }
    } else if (industryId) {
      setSelectedIndustry(industryId);
    }
  }, [searchParams]);

  const handleUpgrade = useCallback(async () => {
    if (!session) return;
    setUpgrading(true);
    try {
      const res = await fetch('/api/paypal/create-order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
      });
      const data = await res.json() as { approvalUrl?: string };
      if (data.approvalUrl && typeof window !== 'undefined') window.location.href = data.approvalUrl;
      else setUpgrading(false);
    } catch {
      setUpgrading(false);
    }
  }, [session]);

  const runPlanner = useCallback(async (
    prompt: string, isModification: boolean, currentPlannerResult: PlannerResult | null
  ) => {
    try {
      let result: PlannerResult;
      if (isModification && currentPlannerResult) {
        result = modifyPlan(currentPlannerResult, prompt);
      } else {
        result = await createAutomationPlanAsync(prompt);
      }

      const validationResult = validateWorkflow(result.plan, result.composition, result.n8nJson);
      setPlannerResult(result);
      setValidation(validationResult);

      supabase.from('automation_plans').insert({
        session_id: `session-${Date.now()}`,
        user_id: user?.id ?? null,
        prompt,
        plan_json: result.plan as unknown as Record<string, unknown>,
        composition_json: result.composition as unknown as Record<string, unknown>,
        n8n_json: result.n8nJson as unknown as Record<string, unknown>,
        env_config: result.envConfig,
        pattern: result.plan.pattern,
        trigger_type: result.plan.trigger.type,
        integrations: result.plan.integrations,
        complexity: result.plan.complexity,
        estimated_nodes: result.plan.estimatedNodes,
        confidence: result.plan.confidence,
        validation_score: validationResult.score,
        is_valid: validationResult.valid,
      }).then(() => {}, () => {});

      return result;
    } catch {
      return null;
    }
  }, [user]);

  const handleLiveDeploy = useCallback((result: LiveDeployResult) => {
    setLiveDeployResult(result);
    if (result.workflowId) setDeployedWorkflowId(result.workflowId);
    if (result.workflowUrl) setDeployedUrl(result.workflowUrl);
    if (result.activated) {
      setDeploymentLifecycle('active');
      if (result.workflowId) {
        supabase.from('workflow_executions')
          .update({ status: 'active', activated_at: new Date().toISOString() })
          .eq('n8n_workflow_id', result.workflowId)
          .then(() => {}, () => {});
      }
    }
  }, []);

  async function handleGenerated(result: GenerationResult | null, prompt?: string) {
    setGenerationResult(result);
    setDeployedUrl(null);
    setDeployedWorkflowId(null);
    setDeploymentLifecycle('draft_created');
    setLiveDeployResult(null);

    if (result && prompt) {
      setLastPrompt(prompt);
      const isModification = ['add ', 'remove ', 'switch ', 'change ', 'include ', 'replace '].some(
        t => prompt.toLowerCase().startsWith(t) || prompt.toLowerCase().includes(t)
      );
      await runPlanner(prompt, isModification && plannerResult !== null, plannerResult);
    }

    if (result) {
      setOutputOpen(true);
      if (isMobile) setSidebarOpen(false);
    }
  }

  function handleSelectTemplate(template: AutomationTemplate) {
    setSelectedTemplate(template);
    if (isMobile) setSidebarOpen(false);
  }

  async function handleDeploy() {
    if (!plannerResult || !validation) return;
    setIsDeploying(true);
    try {
      const res = await fetch('/api/n8n', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', workflow: plannerResult.n8nJson }),
      });
      const data = await res.json();

      if (data.result?.workflowUrl) {
        const wfId = data.result.workflowId || '';
        setDeployedUrl(data.result.workflowUrl);
        setDeployedWorkflowId(wfId);
        const initialLifecycle: DeploymentLifecycle =
          validation.credentialsRequired.length > 0 ? 'draft_created' : 'ready_to_activate';
        setDeploymentLifecycle(initialLifecycle);

        supabase.from('workflow_executions').insert({
          session_id: `session-${Date.now()}`,
          user_id: user?.id ?? null,
          n8n_workflow_id: wfId,
          n8n_instance_url: process.env.NEXT_PUBLIC_N8N_INSTANCE_URL || '',
          status: 'pending',
          workflow_name: plannerResult.plan.title,
        }).then(() => {}, () => {});
      }
    } catch {
      // n8n not configured
    } finally {
      setIsDeploying(false);
    }
  }

  const handleLifecycleChange = useCallback((next: DeploymentLifecycle) => {
    setDeploymentLifecycle(next);
    if (next === 'active' && deployedWorkflowId) {
      supabase.from('workflow_executions')
        .update({ status: 'active', activated_at: new Date().toISOString() })
        .eq('n8n_workflow_id', deployedWorkflowId)
        .then(() => {}, () => {});
    }
  }, [deployedWorkflowId]);

  const handleCheckActivation = useCallback(async (): Promise<boolean> => {
    if (!deployedWorkflowId) return false;
    setIsCheckingActivation(true);
    try {
      const res = await fetch(`/api/n8n?action=status&workflowId=${deployedWorkflowId}`);
      const data = await res.json();
      return data.status?.active === true;
    } catch {
      return false;
    } finally {
      setIsCheckingActivation(false);
    }
  }, [deployedWorkflowId]);

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

  const showOutput = outputOpen && (generationResult || plannerResult);
  const isPro = user?.plan === 'pro';

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

        {(generationResult || plannerResult) && (
          <div className="flex items-center gap-1 p-0.5 rounded-md bg-muted/30 border border-border">
            <button
              onClick={() => setOutputMode('architect')}
              className={cn(
                'flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors',
                outputMode === 'architect' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Brain className="w-3 h-3" />
              <span className="hidden sm:block">Architect</span>
            </button>
            <button
              onClick={() => setOutputMode('legacy')}
              className={cn(
                'flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors',
                outputMode === 'legacy' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Activity className="w-3 h-3" />
              <span className="hidden sm:block">Classic</span>
            </button>
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
          {(generationResult || plannerResult) && (
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
          <ChatInterface
            initialTemplate={selectedTemplate}
            onGenerated={handleGenerated}
            currentResult={generationResult}
          />
        </main>

        <aside className={cn(
          'flex-shrink-0 border-l border-border bg-card/30 transition-all duration-300 overflow-hidden',
          showOutput ? 'w-full sm:w-[440px] lg:w-[520px]' : 'w-0'
        )}>
          <div className="w-full sm:w-[440px] lg:w-[520px] h-full p-3 lg:p-4">
            {outputMode === 'architect' && plannerResult && validation ? (
              <ArchitectPanel
                plannerResult={plannerResult}
                validation={validation}
                onDeploy={handleDeploy}
                onDownload={handleDownload}
                isDeploying={isDeploying}
                deployedUrl={deployedUrl}
                deployedWorkflowId={deployedWorkflowId}
                deploymentLifecycle={deployedUrl ? deploymentLifecycle : undefined}
                onLifecycleChange={handleLifecycleChange}
                onCheckActivation={handleCheckActivation}
                isCheckingActivation={isCheckingActivation}
                onLiveDeploy={isPro ? handleLiveDeploy : undefined}
                liveDeployResult={liveDeployResult}
                className="h-full"
                isPro={isPro}
                onUpgrade={handleUpgrade}
              />
            ) : generationResult ? (
              <OutputPanel result={generationResult} />
            ) : null}
          </div>
        </aside>
      </div>

      {(generationResult || plannerResult) && !outputOpen && isMobile && (
        <div className="fixed bottom-4 right-4 z-30">
          <Button onClick={() => setOutputOpen(true)} size="sm" className="gap-2 shadow-xl shadow-primary/30">
            <PanelRightOpen className="w-4 h-4" />
            View Output
          </Button>
        </div>
      )}

      {/* suppress unused variable warning */}
      <span className="hidden">{lastPrompt}</span>
    </div>
  );
}

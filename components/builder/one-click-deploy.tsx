'use client';

import { useState, useCallback } from 'react';
import {
  Rocket, CircleCheck as CheckCircle2, CircleAlert as AlertCircle,
  RefreshCw, ChevronDown, ChevronRight, KeyRound, Zap, Activity,
  ArrowRight, Eye, EyeOff, ExternalLink, ShieldCheck, CircleDot,
  Info, TriangleAlert
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CredentialRequirement } from '@/lib/validator';
import { getCredentialGuide } from '@/lib/credential-setup';
import { cn } from '@/lib/utils';
import { OrchestrationStage } from '@/app/api/n8n/orchestrate/route';

// ── TYPES ─────────────────────────────────────────────────────────────────────

export interface LiveDeployResult {
  stage: OrchestrationStage;
  workflowId?: string;
  workflowUrl?: string;
  activated: boolean;
  deployedAsDraft?: boolean;
  testStatus: 'not_tested';
  testMessage: string;
  warnings: string[];
  error?: string;
}

interface OneClickDeployProps {
  workflowName: string;
  workflowJson: object;
  credentialsRequired: CredentialRequirement[];
  hasApprovalNode: boolean;
  onDeployComplete: (result: LiveDeployResult) => void;
  className?: string;
}

// ── STAGE CONFIG ──────────────────────────────────────────────────────────────

interface StageConfig {
  label: string;
  description: string;
}

const STAGE_CONFIG: Record<OrchestrationStage, StageConfig> = {
  creating_workflow:        { label: 'Creating workflow',        description: 'Deploying to n8n...' },
  provisioning_credentials: { label: 'Provisioning credentials', description: 'Creating API credentials in n8n...' },
  injecting_credentials:    { label: 'Injecting credentials',    description: 'Wiring credentials into nodes...' },
  activating:               { label: 'Activating',               description: 'Enabling workflow in n8n...' },
  complete:                 { label: 'Deployed',                 description: 'Workflow deployed to n8n' },
  failed:                   { label: 'Failed',                   description: 'Deployment encountered an error' },
};

const STAGE_ORDER: OrchestrationStage[] = [
  'creating_workflow',
  'provisioning_credentials',
  'injecting_credentials',
  'activating',
  'complete',
];

function stageIndex(s: OrchestrationStage): number {
  return STAGE_ORDER.indexOf(s);
}

// ── CREDENTIAL FIELD INPUT ────────────────────────────────────────────────────

function SecretInput({
  label, placeholder, value, onChange, type = 'password'
}: {
  label: string; placeholder: string; value: string;
  onChange: (v: string) => void; type?: 'text' | 'password';
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <div className="relative">
        <input
          type={type === 'password' && !show ? 'password' : 'text'}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full text-xs bg-muted/30 border border-border rounded-lg px-3 py-2 pr-8 font-mono text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
        />
        {type === 'password' && (
          <button
            type="button"
            onClick={() => setShow(v => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
          >
            {show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
        )}
      </div>
    </div>
  );
}

// ── CREDENTIAL COLLECTION CARD ────────────────────────────────────────────────

function CredentialCard({
  cred, values, onChange
}: {
  cred: CredentialRequirement;
  values: Record<string, string>;
  onChange: (key: string, val: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const guide = getCredentialGuide(cred.n8nCredentialType);
  const isComplete = guide ? guide.fields.filter(f => f.required).every(f => values[f.key]?.trim()) : false;
  const isManual = guide?.tier === 'manual';
  const isRisk = guide?.tier === 'risk';

  return (
    <div className={cn(
      'rounded-xl border transition-colors',
      isComplete && !isManual ? 'border-emerald-500/30 bg-emerald-500/5' :
      isManual ? 'border-amber-500/30 bg-amber-500/5' :
      isRisk ? 'border-yellow-500/20 bg-yellow-500/5' :
      'border-border bg-muted/10'
    )}>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-3 py-3 text-left"
      >
        <div className={cn(
          'w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 transition-colors',
          isComplete && !isManual ? 'bg-emerald-500/20' :
          isManual ? 'bg-amber-500/20' :
          'bg-amber-500/20'
        )}>
          {isComplete && !isManual
            ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            : isManual
              ? <Info className="w-3.5 h-3.5 text-amber-400" />
              : <KeyRound className="w-3.5 h-3.5 text-amber-400" />
          }
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">{cred.service}</p>
            {isManual && (
              <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-1.5 py-0.5">
                Manual OAuth required
              </span>
            )}
            {isRisk && (
              <span className="text-[10px] font-semibold uppercase tracking-wider text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 rounded px-1.5 py-0.5">
                Verify in n8n
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground truncate">{guide?.summary || cred.description}</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {isComplete && !isManual && (
            <span className="text-xs text-emerald-400 font-medium">Ready</span>
          )}
          {open ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}
        </div>
      </button>

      {open && guide && (
        <div className="px-3 pb-3 space-y-3 border-t border-border/50">
          {isManual && guide.manualNote && (
            <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/5 p-2.5 text-xs text-amber-300 leading-relaxed">
              {guide.manualNote}
            </div>
          )}
          {isRisk && guide.manualNote && (
            <div className="mt-3 rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-2.5 text-xs text-yellow-300 leading-relaxed">
              {guide.manualNote}
            </div>
          )}

          {guide.steps.length > 0 && (
            <div className="mt-3 space-y-1">
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Setup steps</p>
              <ol className="space-y-1">
                {guide.steps.map((step, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
                    <span className="text-[10px] font-mono text-muted-foreground/50 flex-shrink-0 mt-0.5 w-4">{i + 1}.</span>
                    {step}
                  </li>
                ))}
              </ol>
              {guide.docsUrl && (
                <a href={guide.docsUrl} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline mt-1">
                  {guide.docsLabel}
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
          )}

          {!isManual && (
            <div className="space-y-2">
              {guide.fields.map(field => (
                <SecretInput
                  key={field.key}
                  label={`${field.label}${field.required ? ' *' : ''}`}
                  placeholder={field.example}
                  value={values[field.key] || ''}
                  onChange={val => onChange(field.key, val)}
                  type={field.type === 'password' ? 'password' : 'text'}
                />
              ))}
            </div>
          )}

          {isManual && (
            <div className="space-y-2">
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                Enter credentials (credential shell will be created — OAuth step done in n8n)
              </p>
              {guide.fields.map(field => (
                <SecretInput
                  key={field.key}
                  label={`${field.label}${field.required ? ' *' : ''}`}
                  placeholder={field.example}
                  value={values[field.key] || ''}
                  onChange={val => onChange(field.key, val)}
                  type={field.type === 'password' ? 'password' : 'text'}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── ORCHESTRATION PROGRESS ────────────────────────────────────────────────────

function OrchestrationProgress({
  currentStage, error
}: {
  currentStage: OrchestrationStage; error?: string;
}) {
  const currentIdx = stageIndex(currentStage);
  const isFailed = currentStage === 'failed';

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {STAGE_ORDER.filter(s => s !== 'complete').map(stage => {
          const idx = stageIndex(stage);
          const isDone = !isFailed && idx < currentIdx;
          const isActive = !isFailed && stage === currentStage;
          const isPending = idx > currentIdx || (isFailed && idx >= currentIdx);
          const cfg = STAGE_CONFIG[stage];

          return (
            <div key={stage} className={cn(
              'flex items-center gap-3 rounded-lg px-3 py-2 border transition-all',
              isDone   ? 'border-emerald-500/20 bg-emerald-500/5' :
              isActive ? 'border-primary/30 bg-primary/5' :
              isFailed && idx === currentIdx ? 'border-red-500/20 bg-red-500/5' :
              'border-border/30 bg-transparent opacity-40'
            )}>
              <div className="w-5 h-5 flex-shrink-0 flex items-center justify-center">
                {isDone && <CheckCircle2 className="w-4 h-4 text-emerald-400" />}
                {isActive && <RefreshCw className="w-4 h-4 text-primary animate-spin" />}
                {isFailed && idx === currentIdx && <AlertCircle className="w-4 h-4 text-red-400" />}
                {isPending && <CircleDot className="w-4 h-4 text-muted-foreground/30" />}
              </div>
              <div className="flex-1 min-w-0">
                <p className={cn('text-xs font-medium',
                  isDone ? 'text-emerald-400' :
                  isActive ? 'text-foreground' :
                  isFailed && idx === currentIdx ? 'text-red-400' :
                  'text-muted-foreground'
                )}>{cfg.label}</p>
                {isActive && (
                  <p className="text-[11px] text-muted-foreground">{cfg.description}</p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
          <p className="text-xs text-red-400 font-medium">{error}</p>
        </div>
      )}
    </div>
  );
}

// ── EXECUTION HEALTH PANEL ────────────────────────────────────────────────────

export function ExecutionHealthPanel({
  result
}: {
  result: LiveDeployResult;
}) {
  const isActivated = result.activated && result.stage === 'complete';
  const isDraft = result.deployedAsDraft;
  const isFailed = result.stage === 'failed';

  return (
    <div className="space-y-3">
      {/* Status header */}
      <div className={cn(
        'rounded-xl border p-4',
        isActivated ? 'border-emerald-500/30 bg-emerald-500/5' :
        isDraft ? 'border-blue-500/30 bg-blue-500/5' :
        isFailed ? 'border-red-500/30 bg-red-500/5' :
        'border-amber-500/30 bg-amber-500/5'
      )}>
        <div className="flex items-center gap-3 mb-2">
          <div className={cn(
            'w-8 h-8 rounded-full flex items-center justify-center',
            isActivated ? 'bg-emerald-500/20' :
            isDraft ? 'bg-blue-500/20' :
            isFailed ? 'bg-red-500/20' :
            'bg-amber-500/20'
          )}>
            {isActivated && <Zap className="w-4 h-4 text-emerald-400" fill="currentColor" />}
            {!isActivated && isDraft && <ShieldCheck className="w-4 h-4 text-blue-400" />}
            {!isActivated && !isDraft && isFailed && <AlertCircle className="w-4 h-4 text-red-400" />}
            {!isActivated && !isDraft && !isFailed && <Activity className="w-4 h-4 text-amber-400" />}
          </div>
          <div>
            <p className={cn('text-sm font-semibold',
              isActivated ? 'text-emerald-400' :
              isDraft ? 'text-blue-400' :
              isFailed ? 'text-red-400' :
              'text-amber-400'
            )}>
              {isActivated ? 'Deployed to n8n — Activated' :
               isDraft ? 'Deployed to n8n — Manual Activation Required' :
               isFailed ? 'Deployment Failed' :
               'Deployed to n8n — Action Required'}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {result.testMessage}
            </p>
          </div>
        </div>

        {result.workflowUrl && (
          <a
            href={result.workflowUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
          >
            Open in n8n
            <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>

      {/* Manual test required notice */}
      <div className="rounded-lg border border-border bg-muted/10 p-3 space-y-1">
        <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
          <Activity className="w-3.5 h-3.5" />
          Manual test required
        </p>
        <p className="text-xs text-muted-foreground leading-relaxed">
          The n8n Public API does not support automated test execution. Trigger your workflow manually in n8n to verify all nodes run correctly.
        </p>
      </div>

      {/* Warnings */}
      {result.warnings && result.warnings.length > 0 && (
        <div className="space-y-2">
          {result.warnings.map((w, i) => (
            <div key={i} className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-2.5 flex items-start gap-2">
              <TriangleAlert className="w-3.5 h-3.5 text-amber-400 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-amber-300 leading-relaxed">{w}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── MAIN COMPONENT ────────────────────────────────────────────────────────────

type DeployPhase = 'collect' | 'deploying' | 'done';

export function OneClickDeploy({
  workflowName, workflowJson, credentialsRequired, hasApprovalNode,
  onDeployComplete, className
}: OneClickDeployProps) {
  const [phase, setPhase] = useState<DeployPhase>('collect');
  const [credValues, setCredValues] = useState<Record<string, Record<string, string>>>({});
  const [currentStage, setCurrentStage] = useState<OrchestrationStage>('creating_workflow');
  const [deployError, setDeployError] = useState<string | undefined>();
  const [deployResult, setDeployResult] = useState<LiveDeployResult | null>(null);

  const handleCredChange = useCallback((credType: string, fieldKey: string, value: string) => {
    setCredValues(prev => ({
      ...prev,
      [credType]: { ...(prev[credType] || {}), [fieldKey]: value }
    }));
  }, []);

  const allCredsComplete = credentialsRequired.every(cred => {
    const guide = getCredentialGuide(cred.n8nCredentialType);
    if (!guide) return true;
    // Manual OAuth credentials (Google Sheets): fields are optional pre-fill, not blocking
    if (guide.tier === 'manual') return true;
    return guide.fields.filter(f => f.required).every(f => credValues[cred.n8nCredentialType]?.[f.key]?.trim());
  });

  const handleDeploy = useCallback(async () => {
    setPhase('deploying');
    setDeployError(undefined);
    setCurrentStage('creating_workflow');

    const credentials = credentialsRequired
      .filter(cred => {
        const guide = getCredentialGuide(cred.n8nCredentialType);
        return guide && Object.keys(credValues[cred.n8nCredentialType] || {}).length > 0;
      })
      .map(cred => ({
        type: cred.n8nCredentialType,
        service: cred.service,
        data: credValues[cred.n8nCredentialType] || {}
      }));

    try {
      const res = await fetch('/api/n8n/orchestrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflow: workflowJson,
          credentials,
          sessionId: `session-${Date.now()}`
        })
      });

      const data = await res.json() as LiveDeployResult;
      setCurrentStage(data.stage);
      setDeployError(data.error);
      setDeployResult(data);
      setPhase('done');
      onDeployComplete(data);
    } catch {
      const errorResult: LiveDeployResult = {
        stage: 'failed',
        activated: false,
        testStatus: 'not_tested',
        testMessage: 'Deployment failed. Check your n8n instance and try again.',
        warnings: [],
        error: 'Unable to reach the deployment endpoint. Check your connection and try again.',
      };
      setDeployError(errorResult.error);
      setCurrentStage('failed');
      setPhase('done');
      onDeployComplete(errorResult);
    }
  }, [workflowJson, credentialsRequired, credValues, onDeployComplete]);

  return (
    <div className={cn('space-y-4', className)}>
      {/* Header */}
      <div className="flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-lg bg-primary/15 flex items-center justify-center">
          <Rocket className="w-4 h-4 text-primary" />
        </div>
        <div>
          <p className="text-sm font-semibold">Deploy to n8n</p>
          <p className="text-xs text-muted-foreground">
            {credentialsRequired.length > 0
              ? `Provide ${credentialsRequired.length} credential${credentialsRequired.length > 1 ? 's' : ''} — workflow deploys and activates automatically`
              : 'No credentials required — deploys instantly'}
          </p>
        </div>
      </div>

      {/* Collect phase */}
      {phase === 'collect' && (
        <div className="space-y-3">
          {credentialsRequired.length > 0 ? (
            <>
              {credentialsRequired.map(cred => (
                <CredentialCard
                  key={cred.n8nCredentialType}
                  cred={cred}
                  values={credValues[cred.n8nCredentialType] || {}}
                  onChange={(key, val) => handleCredChange(cred.n8nCredentialType, key, val)}
                />
              ))}

              {hasApprovalNode && (
                <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-muted-foreground space-y-1">
                  <p className="font-semibold text-amber-400 flex items-center gap-1.5">
                    <Info className="w-3 h-3" />
                    Approval node — manual step required
                  </p>
                  <p>
                    Approval/Wait node resume URLs must be copied from n8n manually after the workflow runs for the first time.
                    Open the Wait node in n8n to find the URL, then share it with your approvers.
                  </p>
                </div>
              )}

              <Button
                onClick={handleDeploy}
                disabled={!allCredsComplete}
                className="w-full gap-2 bg-primary hover:bg-primary/90"
              >
                <Rocket className="w-4 h-4" />
                Deploy to n8n
                <ArrowRight className="w-4 h-4 ml-auto" />
              </Button>

              {!allCredsComplete && (
                <p className="text-xs text-muted-foreground text-center">
                  Fill in all required credentials above to enable deployment
                </p>
              )}
            </>
          ) : (
            <Button onClick={handleDeploy} className="w-full gap-2">
              <Rocket className="w-4 h-4" />
              Deploy to n8n
            </Button>
          )}
        </div>
      )}

      {/* Deploying phase */}
      {phase === 'deploying' && (
        <div className="space-y-4">
          <div className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2.5 flex items-center gap-2.5">
            <RefreshCw className="w-4 h-4 text-primary animate-spin flex-shrink-0" />
            <div>
              <p className="text-xs font-medium text-foreground">{STAGE_CONFIG[currentStage].label}</p>
              <p className="text-xs text-muted-foreground">{STAGE_CONFIG[currentStage].description}</p>
            </div>
          </div>
          <OrchestrationProgress currentStage={currentStage} error={deployError} />
        </div>
      )}

      {/* Done phase */}
      {phase === 'done' && deployResult && (
        <div className="space-y-3">
          <OrchestrationProgress currentStage={currentStage} error={deployError} />
          <ExecutionHealthPanel result={deployResult} />
          {(currentStage === 'failed' || deployResult.deployedAsDraft) && (
            <Button
              variant="outline"
              onClick={() => { setPhase('collect'); setDeployResult(null); setDeployError(undefined); }}
              className="w-full gap-2 text-xs"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Retry Deployment
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

'use client';

import { useState } from 'react';
import { CircleCheck as CheckCircle2, Circle, ExternalLink, ChevronDown, ChevronRight, KeyRound, Zap, RefreshCw, TriangleAlert as AlertTriangle, Info, Copy, Check, Clock, BookOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CredentialRequirement } from '@/lib/validator';
import { getCredentialGuide, APPROVAL_NODE_GUIDE, CredentialSetupGuide } from '@/lib/credential-setup';
import { cn } from '@/lib/utils';

export type DeploymentLifecycle =
  | 'draft_created'
  | 'credentials_required'
  | 'credentials_linked_manually'
  | 'ready_to_activate'
  | 'activating'
  | 'active'
  | 'failed';

export interface SetupWizardProps {
  workflowName: string;
  workflowUrl: string;
  workflowId: string;
  credentialsRequired: CredentialRequirement[];
  hasApprovalNode: boolean;
  lifecycle: DeploymentLifecycle;
  onLifecycleChange: (next: DeploymentLifecycle) => void;
  onCheckActivation: () => Promise<boolean>;
  isCheckingActivation?: boolean;
}

// ── STEP CONFIG ──────────────────────────────────────────────────────────────

type WizardStep = 'open' | 'credentials' | 'link' | 'approval' | 'activate' | 'test';

interface StepDef {
  id: WizardStep;
  label: string;
  description: string;
}

function getSteps(hasCredentials: boolean, hasApproval: boolean): StepDef[] {
  const steps: StepDef[] = [
    { id: 'open', label: 'Open workflow in n8n', description: 'Verify nodes imported correctly' },
  ];
  if (hasCredentials) {
    steps.push(
      { id: 'credentials', label: 'Create credentials in n8n', description: 'Add each required service credential' },
      { id: 'link', label: 'Link credentials to nodes', description: 'Connect each node to its credential' }
    );
  }
  if (hasApproval) {
    steps.push({ id: 'approval', label: 'Configure approval URL', description: 'Wire the resume URL into your notification' });
  }
  steps.push(
    { id: 'activate', label: 'Activate workflow', description: 'Toggle from Inactive to Active in n8n' },
    { id: 'test', label: 'Test a run', description: 'Trigger the workflow and verify execution' }
  );
  return steps;
}

// ── COPY BUTTON ──────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function handle() {
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <button onClick={handle} className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded hover:bg-muted/50">
      {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

// ── CREDENTIAL GUIDE CARD ────────────────────────────────────────────────────

function CredentialGuideCard({ req }: { req: CredentialRequirement }) {
  const [expanded, setExpanded] = useState(false);
  const guide: CredentialSetupGuide | undefined = getCredentialGuide(req.n8nCredentialType);

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-muted/30 transition-colors text-left"
      >
        <div className="w-7 h-7 rounded-lg bg-amber-500/15 flex items-center justify-center flex-shrink-0">
          <KeyRound className="w-3.5 h-3.5 text-amber-400" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold">{req.service}</p>
          <p className="text-[11px] text-muted-foreground truncate">{req.description}</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground">{req.n8nCredentialType}</span>
          {expanded ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-3 border-t border-border pt-3 space-y-3">
          {guide ? (
            <>
              <p className="text-xs text-muted-foreground">{guide.summary}</p>

              <div>
                <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Setup Steps</p>
                <ol className="space-y-1.5">
                  {guide.steps.map((step, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs">
                      <span className="w-4 h-4 rounded-full bg-muted flex items-center justify-center text-[10px] font-mono text-muted-foreground flex-shrink-0 mt-0.5">
                        {i + 1}
                      </span>
                      <span className="text-muted-foreground leading-relaxed">{step}</span>
                    </li>
                  ))}
                </ol>
              </div>

              <div>
                <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Required Fields in n8n</p>
                <div className="space-y-1">
                  {guide.fields.map(field => (
                    <div key={field.key} className="rounded-md bg-muted/30 px-2.5 py-2">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-xs font-medium">{field.label}</span>
                        {field.required && <span className="text-[10px] text-red-400">required</span>}
                      </div>
                      <p className="text-[11px] text-muted-foreground">{field.description}</p>
                      <div className="flex items-center gap-1.5 mt-1">
                        <code className="text-[11px] font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground/80 flex-1 min-w-0 truncate">
                          {field.example}
                        </code>
                        <CopyButton text={field.example} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <Clock className="w-3 h-3" />
                ~{guide.estimatedMinutes} min
                <a href={guide.docsUrl} target="_blank" rel="noopener noreferrer"
                  className="ml-auto flex items-center gap-1 text-primary hover:underline">
                  <BookOpen className="w-3 h-3" />
                  {guide.docsLabel}
                  <ExternalLink className="w-2.5 h-2.5" />
                </a>
              </div>
            </>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                In n8n: Credentials → Add Credential → search for <code className="font-mono bg-muted px-1 rounded text-xs">{req.n8nCredentialType}</code>
              </p>
              <p className="text-[11px] text-muted-foreground">Used by nodes: {req.nodeNames.join(', ')}</p>
              {req.setupUrl && (
                <a href={req.setupUrl} target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs text-primary hover:underline">
                  Setup documentation <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── APPROVAL NODE GUIDE ──────────────────────────────────────────────────────

function ApprovalNodeGuide() {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-blue-500/10 transition-colors text-left"
      >
        <Info className="w-4 h-4 text-blue-400 flex-shrink-0" />
        <div className="flex-1">
          <p className="text-xs font-semibold text-blue-400">{APPROVAL_NODE_GUIDE.title}</p>
          <p className="text-[11px] text-muted-foreground">Click to see how to wire the approval URL</p>
        </div>
        {expanded ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}
      </button>
      {expanded && (
        <div className="px-3 pb-3 border-t border-blue-500/20 pt-3 space-y-2">
          <div className="rounded-md bg-amber-500/10 border border-amber-500/20 px-3 py-2">
            <p className="text-xs font-medium text-amber-400 flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5" />
              {APPROVAL_NODE_GUIDE.important}
            </p>
          </div>
          <ol className="space-y-1.5">
            {APPROVAL_NODE_GUIDE.steps.map((step, i) => (
              <li key={i} className="flex items-start gap-2 text-xs">
                <span className="w-4 h-4 rounded-full bg-blue-500/20 flex items-center justify-center text-[10px] font-mono text-blue-400 flex-shrink-0 mt-0.5">
                  {i + 1}
                </span>
                <span className="text-muted-foreground leading-relaxed">{step}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

// ── MAIN WIZARD ──────────────────────────────────────────────────────────────

const LIFECYCLE_LABELS: Record<DeploymentLifecycle, { label: string; color: string; description: string }> = {
  draft_created:             { label: 'Draft Created',         color: 'text-blue-400',      description: 'Workflow imported to n8n as inactive draft' },
  credentials_required:      { label: 'Credentials Required',  color: 'text-amber-400',     description: 'Link required credentials in n8n before activating' },
  credentials_linked_manually: { label: 'Credentials Linked',  color: 'text-cyan-400',      description: 'Credentials linked — ready to activate' },
  ready_to_activate:         { label: 'Ready to Activate',     color: 'text-emerald-400',   description: 'All setup complete — activate the workflow' },
  activating:                { label: 'Checking Status...',    color: 'text-amber-400',     description: 'Verifying workflow is active in n8n' },
  active:                    { label: 'Active',                color: 'text-emerald-400',   description: 'Workflow is live and processing events' },
  failed:                    { label: 'Failed',                color: 'text-red-400',       description: 'Workflow activation failed — check n8n for errors' },
};

export function SetupWizard({
  workflowName,
  workflowUrl,
  workflowId,
  credentialsRequired,
  hasApprovalNode,
  lifecycle,
  onLifecycleChange,
  onCheckActivation,
  isCheckingActivation = false,
}: SetupWizardProps) {
  const hasCredentials = credentialsRequired.length > 0;
  const hasApproval = hasApprovalNode;
  const steps = getSteps(hasCredentials, hasApproval);
  const status = LIFECYCLE_LABELS[lifecycle];

  // Determine which steps are "done" based on lifecycle
  const completedSteps = new Set<WizardStep>();
  if (['credentials_linked_manually', 'ready_to_activate', 'activating', 'active'].includes(lifecycle)) {
    completedSteps.add('open');
    if (hasCredentials) {
      completedSteps.add('credentials');
      completedSteps.add('link');
    }
  }
  if (['ready_to_activate', 'activating', 'active'].includes(lifecycle)) {
    if (hasApproval) completedSteps.add('approval');
  }
  if (lifecycle === 'active') {
    completedSteps.add('activate');
    completedSteps.add('test');
  }

  async function handleConfirmCredentials() {
    onLifecycleChange('credentials_linked_manually');
    // After confirming, move to ready if no approval node, otherwise they need approval guide
    setTimeout(() => {
      if (!hasApproval) {
        onLifecycleChange('ready_to_activate');
      } else {
        onLifecycleChange('ready_to_activate');
      }
    }, 200);
  }

  async function handleCheckActivation() {
    onLifecycleChange('activating');
    const isActive = await onCheckActivation();
    onLifecycleChange(isActive ? 'active' : 'failed');
  }

  return (
    <div className="space-y-4">
      {/* Status banner */}
      <div className={cn(
        'rounded-xl border p-4',
        lifecycle === 'active'
          ? 'border-emerald-500/30 bg-emerald-500/5'
          : lifecycle === 'failed'
          ? 'border-red-500/30 bg-red-500/5'
          : 'border-amber-500/30 bg-amber-500/5'
      )}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1">
            <p className={cn('text-sm font-semibold', status.color)}>{status.label}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{status.description}</p>
          </div>
          {lifecycle === 'active' ? (
            <CheckCircle2 className="w-5 h-5 text-emerald-400 flex-shrink-0" />
          ) : lifecycle === 'failed' ? (
            <AlertTriangle className="w-5 h-5 text-red-400 flex-shrink-0" />
          ) : (
            <div className="w-5 h-5 rounded-full border-2 border-amber-500/50 flex-shrink-0" />
          )}
        </div>

        <div className="mt-3 flex items-center gap-2 flex-wrap">
          <a
            href={workflowUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-background border border-border hover:bg-muted/30 transition-colors"
          >
            <Zap className="w-3.5 h-3.5" />
            Open in n8n
            <ExternalLink className="w-3 h-3 text-muted-foreground" />
          </a>
          <code className="text-[11px] font-mono text-muted-foreground bg-muted/40 px-2 py-1 rounded truncate max-w-[180px]">
            ID: {workflowId}
          </code>
        </div>
      </div>

      {/* Progress checklist */}
      <div>
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Setup Checklist</p>
        <div className="space-y-1">
          {steps.map((step, i) => {
            const done = completedSteps.has(step.id);
            const isCurrent = !done && steps.findIndex(s => !completedSteps.has(s.id)) === i;
            return (
              <div
                key={step.id}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2 border',
                  done ? 'border-emerald-500/20 bg-emerald-500/5' :
                  isCurrent ? 'border-border bg-muted/30' :
                  'border-border/50 bg-transparent opacity-60'
                )}
              >
                {done ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                ) : (
                  <Circle className={cn('w-4 h-4 flex-shrink-0', isCurrent ? 'text-foreground' : 'text-muted-foreground/40')} />
                )}
                <div className="flex-1 min-w-0">
                  <p className={cn('text-xs font-medium', done ? 'text-emerald-400' : isCurrent ? 'text-foreground' : 'text-muted-foreground')}>
                    {step.label}
                  </p>
                  <p className="text-[11px] text-muted-foreground">{step.description}</p>
                </div>
                {isCurrent && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20 flex-shrink-0">
                    current
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Credential setup guides */}
      {hasCredentials && !['credentials_linked_manually', 'ready_to_activate', 'activating', 'active'].includes(lifecycle) && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Credential Setup Instructions</p>
          {credentialsRequired.map(req => (
            <CredentialGuideCard key={req.service} req={req} />
          ))}
        </div>
      )}

      {/* Approval node guide */}
      {hasApprovalNode && lifecycle !== 'active' && (
        <ApprovalNodeGuide />
      )}

      {/* Action buttons based on lifecycle */}
      {lifecycle === 'draft_created' && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            The workflow is in n8n as an inactive draft. Follow the checklist above, then confirm below when credentials are linked.
          </p>
          {hasCredentials ? (
            <div className="space-y-2">
              <Button
                onClick={handleConfirmCredentials}
                className="w-full gap-2"
                variant="outline"
              >
                <KeyRound className="w-4 h-4" />
                I linked credentials in n8n
              </Button>
              <p className="text-[11px] text-muted-foreground text-center">
                Expand each credential above for step-by-step setup instructions
              </p>
            </div>
          ) : (
            <Button
              onClick={() => onLifecycleChange('ready_to_activate')}
              className="w-full gap-2"
            >
              <Zap className="w-4 h-4" />
              No credentials needed — ready to activate
            </Button>
          )}
        </div>
      )}

      {lifecycle === 'credentials_required' && (
        <div className="space-y-2">
          <div className="space-y-2">
            {credentialsRequired.map(req => (
              <CredentialGuideCard key={req.service} req={req} />
            ))}
          </div>
          <Button
            onClick={handleConfirmCredentials}
            className="w-full gap-2"
            variant="outline"
          >
            <KeyRound className="w-4 h-4" />
            I linked credentials in n8n
          </Button>
        </div>
      )}

      {(lifecycle === 'credentials_linked_manually' || lifecycle === 'ready_to_activate') && (
        <div className="space-y-2">
          <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2.5">
            <p className="text-xs text-emerald-400 font-medium">
              Credentials confirmed. Activate the workflow in n8n by toggling "Active" in the top-right of the workflow editor.
            </p>
          </div>
          <Button
            onClick={handleCheckActivation}
            disabled={isCheckingActivation}
            className="w-full gap-2"
          >
            {isCheckingActivation ? (
              <><RefreshCw className="w-4 h-4 animate-spin" />Checking n8n...</>
            ) : (
              <><CheckCircle2 className="w-4 h-4" />I activated it — verify status</>
            )}
          </Button>
          <p className="text-[11px] text-muted-foreground text-center">
            Activate in n8n first, then click this button to confirm
          </p>
        </div>
      )}

      {lifecycle === 'activating' && (
        <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
          <RefreshCw className="w-4 h-4 animate-spin" />
          Checking workflow status in n8n...
        </div>
      )}

      {lifecycle === 'active' && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5 text-emerald-400" />
            <p className="text-sm font-semibold text-emerald-400">Workflow is live</p>
          </div>
          <p className="text-xs text-muted-foreground">
            n8n confirmed the workflow is active. Events will now trigger the automation.
          </p>
          <a
            href={workflowUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs text-emerald-400 hover:underline"
          >
            View executions in n8n <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      )}

      {lifecycle === 'failed' && (
        <div className="space-y-3">
          <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2.5">
            <p className="text-xs text-red-400">
              n8n reports this workflow is not active. Check for missing credentials or errors in n8n.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              onClick={handleCheckActivation}
              disabled={isCheckingActivation}
              variant="outline"
              className="flex-1 gap-2 text-xs"
            >
              {isCheckingActivation ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              Re-check status
            </Button>
            <a href={workflowUrl} target="_blank" rel="noopener noreferrer" className="flex-1">
              <Button variant="outline" className="w-full gap-2 text-xs">
                <ExternalLink className="w-3.5 h-3.5" />
                Open in n8n
              </Button>
            </a>
          </div>
          <Button
            onClick={() => onLifecycleChange('credentials_required')}
            variant="ghost"
            className="w-full text-xs text-muted-foreground"
          >
            Go back to credential setup
          </Button>
        </div>
      )}
    </div>
  );
}

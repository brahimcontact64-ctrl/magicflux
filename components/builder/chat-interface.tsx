'use client';

import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { Zap, Send, Loader as Loader2, RefreshCw, ChevronRight, Sparkles, Link2, ShieldCheck, CheckCircle2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { type ConversationState } from '@/lib/conversation-agent';
import { AutomationTemplate, PROMPT_EXAMPLES } from '@/lib/templates';
import { LiveWorkflowPanel, type LiveWorkflowStatus } from './live-workflow-panel';
import { AutomationBrain } from './AutomationBrain';
import type { WorkflowGraphSummary } from '@/lib/agent/workflow-graph';
import { sanitizeAutomationBrainForGraph } from '@/lib/automation/sanitize-automation-brain-for-graph';
import {
  clearRuntimeState,
  createRuntimeState,
  createLiveWorkflowStatus,
  deriveIntegrationCards,
  deriveWorkflowSummary,
  normalizeAssistantCopy,
  sanitizeVisibleText,
  persistRuntimeState,
  restoreRuntimeState,
  toProgressCards,
  updateLiveWorkflow,
} from '@/lib/builder/runtime-state';

const ISOLATE_C = process.env.NEXT_PUBLIC_MF_BUILD_ISOLATE_C === '1';

type MessageRole = 'user' | 'assistant';

type Message = {
  id: string;
  role: MessageRole;
  content: string;
  options?: string[];
  timestamp: Date;
};

type AgentEvent = {
  type: string;
  label: string;
  detail?: string;
  workflowId?: string;
  workflowUrl?: string;
};

type CredentialRequest = {
  provider: string;
  reason: string;
  instructions?: string;
};

type ApprovalRequest = {
  actionKey: string;
  actionType: string;
  reason: string;
  status: string;
};

type ProgressCard = {
  id: string;
  title: string;
  detail?: string;
  tone: 'working' | 'success' | 'warning';
};

type MessageUi = Message & {
  progressCards?: ProgressCard[];
  credentialRequests?: CredentialRequest[];
  integrationCards?: IntegrationCardItem[];
  approvalRequests?: ApprovalRequest[];
  workflowUrl?: string;
  workflowActive?: boolean;
  liveWorkflow?: LiveWorkflowStatus;
  workflowGraph?: WorkflowGraphSummary;
  automationBrain?: AutomationBrainSummary;
};

type CredentialFieldItem = {
  key: string;
  label: string;
  secret: boolean;
  source: string;
  description: string;
  required: boolean;
};

type CredentialIntelligenceItem = {
  provider: string;
  displayName: string;
  missing: CredentialFieldItem[];
  optional: CredentialFieldItem[];
  ready: boolean;
  confidence: number;
};

type AutomationBrainSummary = {
  inferredIntent: string;
  capabilities: Array<{ key: string; reason: string; confidence: number }>;
  activatedSkillPacks: Array<{
    name: string;
    description: string;
    capabilities: string[];
    tools: string[];
    matchScore: number;
  }>;
  matchedPatterns: Array<{
    name: string;
    category: string;
    score: number;
    estimatedCost: number;
    estimatedComplexity: 'simple' | 'moderate' | 'complex';
    risk: 'low' | 'medium' | 'high';
  }>;
  composition: {
    executionFrequency: string;
    expectedInputs: string[];
    expectedOutputs: string[];
    complexity: 'simple' | 'moderate' | 'complex';
    estimatedCostUsd: number;
    latencyEstimateMs: number;
    risks: string[];
    blocks: Array<{ id: string; category: string; name: string; capabilities: string[] }>;
  };
  credentialIntelligence?: CredentialIntelligenceItem[];
};

type IntegrationCardItem = {
  provider: string;
  displayName: string;
  reason: string;
  connected: boolean;
  requiredFields: string[];
};

type WorkflowSummarySnapshot = {
  nodes: number;
  triggers: number;
  actions: number;
  branches: number;
  schedule: string;
  risk: 'Low' | 'Medium' | 'High';
  latencySeconds: number;
  estimatedCostLabel: string;
};

type DeployState = {
  blocked: boolean;
  ready: boolean;
  workflowActive: boolean;
  workflowUrl?: string;
};

type ApprovalState = {
  requests: ApprovalRequest[];
};

type BuilderRuntimeState = {
  version: number;
  session: { id: string };
  conversation: MessageUi[];
  workflowGraph?: WorkflowGraphSummary;
  automationBrain?: AutomationBrainSummary;
  integrationCards: IntegrationCardItem[];
  workflowSummary?: WorkflowSummarySnapshot;
  deployState: DeployState;
  approvalState: ApprovalState;
  liveWorkflow?: LiveWorkflowStatus;
  activeAssistantMessageId?: string;
};

type StreamToolEvent = {
  event?: AgentEvent;
  toolName?: string;
  workflowGraph?: WorkflowGraphSummary;
  workflowPreview?: {
    nodeCount?: number;
    edgeCount?: number;
    integrations?: string[];
    estimatedLatencyMs?: number;
    estimatedCostUsd?: number;
  };
};

type InternalRuntimeState = {
  state?: ConversationState;
  agentEvents?: AgentEvent[];
  credentialRequests?: CredentialRequest[];
  approvalRequests?: ApprovalRequest[];
  workflow?: { id: string; url: string; active: boolean } | null;
  planner?: { readyToBuild?: boolean; canonicalPrompt?: string | null };
  integrationWizard?: { autoLaunch: boolean; required: string[] };
};

const THINKING_STEPS = [
  "I'm setting this up now...",
  'Connecting required integrations...',
  'Generating workflow logic...',
  'Preparing your automation draft...'
];

function formatDollars(value: number): string {
  if (value < 0.01) return '<$0.01';
  return `$${value.toFixed(2)}`;
}

function TypingIndicator({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 px-4 py-2">
      <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0">
        <Zap className="w-4 h-4 text-primary" />
      </div>
      <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-muted/50 border border-border/60">
        <div className="flex items-center gap-1">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce"
              style={{ animationDelay: `${i * 130}ms` }}
            />
          ))}
        </div>
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
    </div>
  );
}

function ProgressTimeline({ cards }: { cards: ProgressCard[] }) {
  if (cards.length === 0) return null;

  const toneStyles: Record<ProgressCard['tone'], string> = {
    working: 'border-primary/25 bg-primary/5 text-foreground',
    success: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    warning: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  };

  return (
    <div className="mt-2 space-y-1.5">
      {cards.map((card) => (
        <div key={card.id} className={`rounded-lg border px-3 py-2 text-xs ${toneStyles[card.tone]}`}>
          <p className="font-medium">{card.title}</p>
          {card.detail ? <p className="mt-0.5 opacity-80">{card.detail}</p> : null}
        </div>
      ))}
    </div>
  );
}

function IntegrationCards({
  cards,
  onConnect,
}: {
  cards: IntegrationCardItem[];
  onConnect: (provider: string) => void;
}) {
  if (cards.length === 0) return null;

  return (
    <div className="mt-2 space-y-2">
      {cards.map((card) => {
        return (
        <div key={card.provider} className="rounded-lg border border-blue-500/25 bg-blue-500/8 px-3 py-2">
          <p className="text-xs font-semibold text-blue-700 dark:text-blue-300 flex items-center gap-1.5">
            <Link2 className="w-3.5 h-3.5" />
            {`Configure ${card.displayName}`}
          </p>
          {card.connected ? <p className="text-[11px] text-emerald-700 dark:text-emerald-300 mt-1">Connected: {card.displayName}</p> : null}
          <p className="text-xs text-muted-foreground mt-1">{card.reason}</p>
          {card.requiredFields.length > 0 ? (
            <p className="text-[11px] text-muted-foreground mt-1">Required: {card.requiredFields.join(' • ')}</p>
          ) : null}
          {!card.connected ? (
            <button
              onClick={() => onConnect(card.provider)}
              className="mt-2 inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border border-blue-500/30 hover:bg-blue-500/15 transition-colors"
            >
              Connect now
            </button>
          ) : null}
        </div>
      )})}
    </div>
  );
}

function WorkflowSummaryCard({ summary }: { summary?: WorkflowSummarySnapshot }) {
  if (!summary) return null;

  return (
    <div className="mt-2 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2">
      <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">Workflow summary</p>
      <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <p>Nodes: {summary.nodes}</p>
        <p>Triggers: {summary.triggers}</p>
        <p>Actions: {summary.actions}</p>
        <p>Branches: {summary.branches}</p>
        <p>Schedule: {summary.schedule}</p>
        <p>Risk: {summary.risk}</p>
        <p>Latency: {summary.latencySeconds}s</p>
        <p>Estimated cost: {summary.estimatedCostLabel}</p>
      </div>
    </div>
  );
}

function toRiskLabel(value: 'low' | 'medium' | 'high' | undefined): 'Low' | 'Medium' | 'High' {
  if (value === 'high') return 'High';
  if (value === 'medium') return 'Medium';
  return 'Low';
}

function AutomationBrainCard({ brain }: { brain: AutomationBrainSummary }) {
  const topPattern = brain.matchedPatterns[0];
  const topCapabilities = brain.capabilities.slice(0, 6);
  const topPacks = brain.activatedSkillPacks.slice(0, 3);

  return (
    <div className="mt-2 rounded-lg border border-cyan-500/25 bg-cyan-500/10 px-3 py-2">
      <p className="text-xs font-semibold text-cyan-700 dark:text-cyan-300">Automation intelligence</p>
      <p className="text-xs text-muted-foreground mt-1">Intent: {brain.inferredIntent}</p>

      {topPattern ? (
        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <p>Pattern: {topPattern.name}</p>
          <p>Category: {topPattern.category}</p>
          <p>Complexity: {topPattern.estimatedComplexity}</p>
          <p>Risk: {toRiskLabel(topPattern.risk)}</p>
          <p>Est. cost: {formatDollars(topPattern.estimatedCost ?? 0)}</p>
          <p>Est. latency: {Math.max(1, Math.round((brain.composition.latencyEstimateMs ?? 0) / 1000))}s</p>
        </div>
      ) : null}

      {topCapabilities.length > 0 ? (
        <p className="text-[11px] text-muted-foreground mt-2">
          Capabilities: {topCapabilities.map((cap) => `${cap.key} (${cap.confidence}%)`).join(' • ')}
        </p>
      ) : null}

      {topPacks.length > 0 ? (
        <p className="text-[11px] text-muted-foreground mt-1">
          Skill packs: {topPacks.map((pack) => `${pack.name} (${pack.matchScore})`).join(' • ')}
        </p>
      ) : null}
    </div>
  );
}

type ConnectionStage = 'idle' | 'connecting' | 'success' | 'failed';

function CredentialIntelligenceCard({
  items,
  accessToken,
  onCredentialSaved,
}: {
  items: CredentialIntelligenceItem[];
  accessToken: string | null;
  onCredentialSaved: (provider: string) => void;
}) {
  const [activeProvider, setActiveProvider] = useState<string | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [connectionStage, setConnectionStage] = useState<ConnectionStage>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);

  if (items.length === 0) return null;

  const sourceLabel: Record<string, string> = {
    oauth: 'OAuth',
    api_key: 'API Key',
    token: 'Token',
    manual: 'Manual',
  };

  const activeItem = items.find((i) => i.provider === activeProvider) ?? null;
  const isConnecting = connectionStage === 'connecting';

  function openModal(provider: string) {
    setActiveProvider(provider);
    setFormValues({});
    setSaveError(null);
    setConnectionStage('idle');
  }

  function closeModal() {
    setActiveProvider(null);
    setFormValues({});
    setSaveError(null);
    setConnectionStage('idle');
  }

  async function handleSave() {
    if (!activeProvider) return;
    setConnectionStage('connecting');
    setSaveError(null);

    let data: {
      success?: boolean;
      error?: string;
      errors?: string[];
      connected?: boolean;
      requiresOAuthFlow?: boolean;
    };

    try {
      const res = await fetch('/api/credentials/connect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({ provider: activeProvider, credentials: formValues }),
      });
      data = (await res.json()) as typeof data;

      if (!res.ok || !data.success) {
        // Prefer the errors array (validation failures), fall back to single error
        const errMsg =
          Array.isArray(data.errors) && data.errors.length > 0
            ? data.errors.join('\n')
            : (data.error ?? 'Failed to save credentials. Please try again.');
        setConnectionStage('failed');
        setSaveError(errMsg);
        return;
      }
    } catch {
      setConnectionStage('failed');
      setSaveError('Network error. Please check your connection and try again.');
      return;
    }

    const savedProvider = activeProvider;
    setConnectionStage('success');

    // Brief success flash before the modal closes
    setTimeout(() => {
      closeModal();
      onCredentialSaved(savedProvider);
    }, 1100);
  }

  return (
    <>
      <div className="mt-2 space-y-2">
        {items.map((item) => (
          <div
            key={item.provider}
            className={`rounded-lg border px-3 py-2 ${
              item.ready
                ? 'border-emerald-500/30 bg-emerald-500/10'
                : 'border-blue-500/25 bg-blue-500/8'
            }`}
          >
            <p className={`text-xs font-semibold flex items-center gap-1.5 ${
              item.ready ? 'text-emerald-700 dark:text-emerald-300' : 'text-blue-700 dark:text-blue-300'
            }`}>
              <Link2 className="w-3.5 h-3.5" />
              {`Configure ${item.displayName}`}
            </p>

            {item.ready ? (
              <p className="text-[11px] text-emerald-700 dark:text-emerald-300 mt-1 flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" />
                Connected
              </p>
            ) : (
              <>
                <p className="text-[11px] text-amber-700 dark:text-amber-400 mt-1">Status: Missing credentials</p>
                {item.missing.length > 0 && (
                  <div className="mt-1.5">
                    <p className="text-[11px] text-muted-foreground font-medium">Required:</p>
                    <ul className="mt-0.5 space-y-0.5">
                      {item.missing.map((field) => (
                        <li key={field.key} className="text-[11px] text-muted-foreground flex items-center gap-1">
                          <span className="text-muted-foreground/60">•</span>
                          <span className="font-medium">{field.label}</span>
                          <span className="text-muted-foreground/50">({sourceLabel[field.source] ?? field.source})</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <button
                  onClick={() => openModal(item.provider)}
                  className="mt-2 inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border border-blue-500/30 hover:bg-blue-500/15 transition-colors"
                >
                  Connect now
                </button>
              </>
            )}
          </div>
        ))}
      </div>

      {activeItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="w-full max-w-sm mx-4 rounded-xl border border-border bg-card shadow-2xl">
            <div className="px-4 pt-4 pb-3 border-b border-border flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold">Connect {activeItem.displayName}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {connectionStage === 'connecting'
                    ? 'Verifying credentials…'
                    : connectionStage === 'success'
                    ? 'Connection successful'
                    : 'Enter your credentials below'}
                </p>
              </div>
              <button
                onClick={closeModal}
                disabled={isConnecting}
                className="text-muted-foreground hover:text-foreground text-xs px-2 py-1 rounded-md hover:bg-muted/50 transition-colors disabled:opacity-40"
              >
                ✕
              </button>
            </div>

            <div className="px-4 py-3 space-y-3">
              {/* Connection state banner */}
              {connectionStage === 'connecting' && (
                <div className="flex items-center gap-2 text-xs text-blue-600 dark:text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded-md px-3 py-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" />
                  Connecting to {activeItem.displayName}…
                </div>
              )}
              {connectionStage === 'success' && (
                <div className="flex items-center gap-2 text-xs text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-md px-3 py-2">
                  <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" />
                  {activeItem.displayName} connected successfully
                </div>
              )}

              {/* Input fields — hidden while connecting or on success */}
              {connectionStage !== 'success' && activeItem.missing.map((field) => (
                <div key={field.key}>
                  <label className="block text-xs font-medium text-foreground mb-1">
                    {field.label}
                    {field.required && <span className="text-red-500 ml-0.5">*</span>}
                  </label>
                  <input
                    type={field.secret ? 'password' : 'text'}
                    placeholder={field.description}
                    value={formValues[field.key] ?? ''}
                    disabled={isConnecting}
                    onChange={(e) =>
                      setFormValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                    }
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-base md:text-xs placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
                    autoComplete="off"
                    data-1p-ignore
                  />
                  <p className="text-[10px] text-muted-foreground mt-0.5">{sourceLabel[field.source] ?? field.source}</p>
                </div>
              ))}

              {/* Error display — shown per-line for multi-error validation failures */}
              {saveError && connectionStage === 'failed' && (
                <div className="rounded-md bg-red-500/10 border border-red-500/20 px-2 py-1.5 space-y-0.5">
                  {saveError.split('\n').map((line, i) => (
                    <p key={i} className="text-[11px] text-red-600 dark:text-red-400">{line}</p>
                  ))}
                </div>
              )}
            </div>

            <div className="px-4 pb-4 flex justify-end gap-2">
              <button
                onClick={closeModal}
                disabled={isConnecting}
                className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-muted/50 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              {connectionStage !== 'success' && (
                <button
                  onClick={handleSave}
                  disabled={
                    isConnecting ||
                    activeItem.missing.some((f) => f.required && !formValues[f.key]?.trim())
                  }
                  className="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isConnecting ? 'Verifying…' : 'Save credentials'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function DeployActionCard({
  blocked,
  blockedReason,
  onDeploy,
}: {
  blocked: boolean;
  blockedReason?: string;
  onDeploy: () => void;
}) {
  return (
    <div className="mt-2 rounded-lg border border-violet-500/30 bg-violet-500/10 px-3 py-2">
      <p className="text-xs font-semibold text-violet-700 dark:text-violet-300">Deploy action</p>
      <p className="text-xs text-muted-foreground mt-1">
        {blocked
          ? (blockedReason ?? 'Connect required integrations first, then approve deployment.')
          : 'Workflow is ready for approval and deployment.'}
      </p>
      <button
        onClick={onDeploy}
        disabled={blocked}
        className="mt-2 inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border border-violet-500/35 enabled:hover:bg-violet-500/15 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Approve + Deploy
      </button>
    </div>
  );
}

function ApprovalCards({ approvals }: { approvals: ApprovalRequest[] }) {
  if (approvals.length === 0) return null;
  return (
    <div className="mt-2 space-y-2">
      {approvals.map((approval) => (
        <div key={approval.actionKey} className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300 flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5" />
            Approval needed
          </p>
          <p className="text-xs text-muted-foreground mt-1">{approval.reason}</p>
          <p className="text-[11px] text-muted-foreground/80 mt-1">Action: {approval.actionType.replaceAll('_', ' ')}</p>
        </div>
      ))}
    </div>
  );
}

function WorkflowSuccessCard({ url }: { url: string }) {
  return (
    <div className="mt-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2">
      <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-300 flex items-center gap-1.5">
        <CheckCircle2 className="w-3.5 h-3.5" />
        Your automation is live
      </p>
      <a href={url} target="_blank" rel="noreferrer" className="mt-2 inline-flex text-xs text-emerald-700 dark:text-emerald-300 underline-offset-2 hover:underline">
        Open workflow
      </a>
    </div>
  );
};

type ChatInterfaceProps = {
  initialTemplate?: AutomationTemplate | null;
  /** Phase 9.2 — free-text automation intent carried over from onboarding.
   * Prefills the input only; never auto-submits (the user still reviews and
   * clicks send themselves). Takes priority over initialTemplate if both are
   * somehow present. */
  initialPrompt?: string | null;
  accessToken: string | null;
  mode?: 'safe_preview' | 'staging_deploy' | 'production_deploy';
  onPlannerReadyAction: (prompt: string) => void | Promise<void>;
  onConversationStateChangeAction?: (state: ConversationState) => void;
  onOpenIntegrationWizardAction?: (providers: string[], sessionId: string) => void;
};

export function ChatInterface({
  initialTemplate,
  initialPrompt,
  accessToken,
  mode = 'production_deploy',
  onPlannerReadyAction,
  onConversationStateChangeAction,
  onOpenIntegrationWizardAction,
}: ChatInterfaceProps) {
  if (ISOLATE_C) {
    return (
      <div className="p-4 text-sm text-muted-foreground">Chat interface temporarily isolated for build diagnostics.</div>
    );
  }

  const [runtimeState, setRuntimeState] = useState<BuilderRuntimeState>(createRuntimeState());
  const internalRuntimeStateRef = useRef<InternalRuntimeState | null>(null);
  const [input, setInput] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const [thinkingLabel, setThinkingLabel] = useState(THINKING_STEPS[0]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sessionId = useRef(runtimeState.session.id);
  const revealTimersRef = useRef<number[]>([]);
  const [restoreComplete, setRestoreComplete] = useState(false);
  const pendingInitialRestoreRef = useRef(true);
  const messages = runtimeState.conversation;

  useLayoutEffect(() => {
    if (typeof window === 'undefined') return;
    const restored = restoreRuntimeState(window.localStorage);
    sessionId.current = restored.session.id;
    setRuntimeState((prev) => {
      console.log({
        stage: 'STATE-WRITE',
        source: 'components/builder/chat-interface.tsx useLayoutEffect hydration restore',
        incomingCapabilities: restored.automationBrain?.capabilities?.map((x) => x.key),
        prevCapabilities: prev?.automationBrain?.capabilities?.map((x) => x.key),
        graphTrigger: restored.workflowGraph?.nodes?.find((n) => n.kind === 'trigger'),
        schedule: restored.workflowSummary?.schedule,
      });
      return restored;
    });
  }, []);

  useEffect(() => {
    if (!pendingInitialRestoreRef.current) return;
    pendingInitialRestoreRef.current = false;
    setRestoreComplete(true);
  }, [messages]);

  useEffect(() => {
    if (typeof window === 'undefined' || !restoreComplete) return;
    persistRuntimeState(window.localStorage, runtimeState);
  }, [runtimeState, restoreComplete]);

  function clearRevealTimers() {
    revealTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    revealTimersRef.current = [];
  }

  useEffect(() => {
    if (messages.length !== 1) return;
    if (initialPrompt) {
      setInput(initialPrompt);
    } else if (initialTemplate) {
      setInput(`I want to build ${initialTemplate.name}`);
    }
  }, [initialTemplate, initialPrompt, messages.length]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isThinking]);

  async function handleSend(overrideInput?: string) {
    const trimmed = (overrideInput ?? input).trim();
    if (!trimmed || isThinking) return;

    setRuntimeState((prev) => ({
      ...prev,
      conversation: [
        ...prev.conversation,
        {
          id: `user-${Date.now()}`,
          role: 'user',
          content: trimmed,
          timestamp: new Date(),
        },
      ],
    }));
    setInput('');
    setIsThinking(true);
    setThinkingLabel(THINKING_STEPS[0]);

    type ResponsePayload = {
      success?: boolean;
      error?: string;
      assistant?: { content: string; options?: string[] };
      agentEvents?: AgentEvent[];
      credentialRequests?: Array<{ provider: string; reason: string; instructions?: string }>;
      approvalRequests?: Array<{ actionKey: string; actionType: string; reason: string; status: string }>;
      integrationWizard?: { autoLaunch: boolean; required: string[] };
      workflow?: { id: string; url: string; active: boolean } | null;
      workflowGraph?: WorkflowGraphSummary | null;
      automationBrain?: AutomationBrainSummary | null;
      safety?: { mode: 'safe' | 'staging' | 'production' };
      runtime?: { configured: boolean; error: string | null };
      state?: ConversationState;
      planner?: { readyToBuild?: boolean; canonicalPrompt?: string | null };
      sessionId?: string;
    };

    const assistantId = `ai-${Date.now()}`;
    setRuntimeState((prev) => ({
      ...prev,
      conversation: [
        ...prev.conversation,
        {
          id: assistantId,
          role: 'assistant',
          content: '',
          timestamp: new Date(),
        },
      ],
      activeAssistantMessageId: assistantId,
    }));

    try {
      const res = await fetch('/api/conversation/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({ sessionId: sessionId.current, message: trimmed, mode }),
      });

      if (!res.ok) {
        const errorBody = await res.text();
        let errorMessage = 'Conversation request failed';
        try {
          const parsed = JSON.parse(errorBody) as { error?: string };
          if (parsed.error) errorMessage = parsed.error;
        } catch {
          if (errorBody) errorMessage = errorBody;
        }
        throw new Error(errorMessage);
      }

      const reader = res.body?.getReader();
      if (!reader) {
        throw new Error('Streaming is unavailable.');
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let finalPayload: ResponsePayload | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        while (true) {
          const boundaryIndex = buffer.indexOf('\n\n');
          if (boundaryIndex === -1) break;

          const rawEvent = buffer.slice(0, boundaryIndex).trim();
          buffer = buffer.slice(boundaryIndex + 2);
          if (!rawEvent) continue;

          let eventName = 'message';
          const dataLines: string[] = [];

          for (const line of rawEvent.split('\n')) {
            if (line.startsWith('event:')) {
              eventName = line.slice('event:'.length).trim();
            }
            if (line.startsWith('data:')) {
              dataLines.push(line.slice('data:'.length).trimStart());
            }
          }

          let data: Record<string, unknown> = {};
          const rawData = dataLines.join('\n');
          if (rawData) {
            try {
              data = JSON.parse(rawData) as Record<string, unknown>;
            } catch {
              data = {};
            }
          }

          if (eventName === 'status') {
            const rawLabel = typeof data.label === 'string'
              ? data.label
              : typeof data.message === 'string'
                ? data.message
                : null;
            const label = sanitizeVisibleText(rawLabel, 'Working on your automation...');
            if (label) setThinkingLabel(label);
          }

          if (eventName === 'token') {
            const text = sanitizeVisibleText(data.text, '');
            if (text) {
              setRuntimeState((prev) => ({
                ...prev,
                conversation: prev.conversation.map((msg) =>
                  msg.id === assistantId ? { ...msg, content: `${msg.content}${text}` } : msg
                ),
              }));
            }
          }

          if (eventName === 'tool_event') {
            const streamed = data as StreamToolEvent;
            const streamedEvent = streamed.event;
            if (streamedEvent) {
              const safeEvent: AgentEvent = {
                type: sanitizeVisibleText(streamedEvent.type, 'event'),
                label: sanitizeVisibleText(streamedEvent.label, 'Progress update'),
                detail: sanitizeVisibleText(streamedEvent.detail, ''),
              };
              const streamedGraph = streamed.workflowGraph;
              setRuntimeState((prev) => {
                const nextGraph = streamedGraph ?? prev.workflowGraph;
                const nextLiveWorkflow = streamedGraph
                  ? updateLiveWorkflow(createLiveWorkflowStatus(streamedGraph), {
                      event: safeEvent,
                      toolName: streamed.toolName,
                    })
                  : prev.liveWorkflow
                    ? updateLiveWorkflow(prev.liveWorkflow, { event: safeEvent, toolName: streamed.toolName })
                    : undefined;

                return {
                  ...prev,
                  workflowGraph: nextGraph,
                  liveWorkflow: nextLiveWorkflow,
                  conversation: prev.conversation.map((msg) =>
                    msg.id === assistantId
                      ? {
                          ...msg,
                          progressCards: [...(msg.progressCards ?? []), ...toProgressCards([safeEvent])],
                          workflowGraph: nextGraph,
                          liveWorkflow: nextLiveWorkflow,
                        }
                      : msg
                  ),
                };
              });
            }
          }

          if (eventName === 'final') {
            finalPayload = (data.payload as ResponsePayload | undefined) ?? null;
          }

          if (eventName === 'error') {
            throw new Error(typeof data.message === 'string' ? data.message : 'Conversation stream failed');
          }
        }
      }

      const typedPayload = finalPayload;
      if (!typedPayload) {
        throw new Error('Conversation stream ended without a final payload.');
      }

      if (typedPayload.sessionId) sessionId.current = typedPayload.sessionId;

      setRuntimeState((prev) => {
        const credentialRequests = (typedPayload.credentialRequests ?? []).map((request) => ({
          provider: sanitizeVisibleText(request.provider, '').toLowerCase(),
          reason: sanitizeVisibleText(request.reason, 'Connect integration to continue.'),
          instructions: sanitizeVisibleText(request.instructions, ''),
        }));

        const graph = typedPayload.workflowGraph ?? prev.workflowGraph;
        const rawBrain = typedPayload.automationBrain ?? prev.automationBrain;
        const credIntelFromPayload = (typedPayload.automationBrain as typeof rawBrain & { credentialIntelligence?: CredentialIntelligenceItem[] })?.credentialIntelligence;
        const brain = sanitizeAutomationBrainForGraph(rawBrain, graph);
        const brainWithCredIntel = brain && credIntelFromPayload
          ? { ...brain, credentialIntelligence: credIntelFromPayload }
          : brain;
        const integrationCards = deriveIntegrationCards(
          graph,
          credentialRequests,
          typedPayload.integrationWizard?.required ?? []
        );
        const approvalRequests = (typedPayload.approvalRequests ?? []).map((approval) => ({
          actionKey: '',
          actionType: sanitizeVisibleText(approval.actionType, 'approval'),
          reason: sanitizeVisibleText(approval.reason, 'Approval is required to continue.'),
          status: sanitizeVisibleText(approval.status, 'pending'),
        }));
        const workflowSummary = deriveWorkflowSummary(graph);
        const workflowActive = Boolean(typedPayload.workflow?.active);
        const credentialBlocked = (credIntelFromPayload ?? []).some((c) => !c.ready && c.missing.length > 0);
        const blocked = integrationCards.some((card) => !card.connected && card.requiredFields.length > 0) || credentialBlocked;
        const liveWorkflow = graph
          ? updateLiveWorkflow(createLiveWorkflowStatus(graph), {
              status: workflowActive ? 'deployed' : 'design',
            })
          : prev.liveWorkflow;

        const nextConversation = prev.conversation.map((msg) =>
          msg.id === assistantId
            ? {
                ...msg,
                content: normalizeAssistantCopy(
                  sanitizeVisibleText(typedPayload.assistant?.content, msg.content),
                  brainWithCredIntel
                ),
                options: typedPayload.assistant?.options,
                progressCards: toProgressCards(
                  (typedPayload.agentEvents ?? []).map((event) => ({
                    ...event,
                    label: sanitizeVisibleText(event.label, 'Progress update'),
                    detail: sanitizeVisibleText(event.detail, ''),
                  }))
                ),
                credentialRequests,
                integrationCards,
                approvalRequests,
                workflowUrl: typedPayload.workflow?.url,
                workflowActive,
                workflowGraph: graph,
                automationBrain: brainWithCredIntel,
                liveWorkflow,
              }
            : msg
        );

        console.log({
          stage: 'STATE-WRITE',
          source: 'components/builder/chat-interface.tsx stream payload merge',
          incomingCapabilities: brain?.capabilities?.map((x) => x.key),
          prevCapabilities: prev?.automationBrain?.capabilities?.map((x) => x.key),
          graphTrigger: graph?.nodes?.find((n) => n.kind === 'trigger'),
          schedule: workflowSummary?.schedule,
        });

        return {
          ...prev,
          session: { id: typedPayload.sessionId ?? prev.session.id },
          conversation: nextConversation,
          workflowGraph: graph,
          automationBrain: brainWithCredIntel,
          integrationCards,
          workflowSummary,
          deployState: {
            blocked,
            ready: Boolean(graph) && !blocked,
            workflowActive,
            workflowUrl: typedPayload.workflow?.url,
          },
          approvalState: {
            requests: approvalRequests,
          },
          liveWorkflow,
          activeAssistantMessageId: assistantId,
        };
      });

      if (typedPayload?.state) {
        internalRuntimeStateRef.current = {
          ...(internalRuntimeStateRef.current ?? {}),
          state: typedPayload.state,
          agentEvents: typedPayload.agentEvents,
          credentialRequests: typedPayload.credentialRequests,
          approvalRequests: typedPayload.approvalRequests,
          workflow: typedPayload.workflow ?? null,
          planner: typedPayload.planner,
          integrationWizard: typedPayload.integrationWizard,
        };
        onConversationStateChangeAction?.(typedPayload.state);
      }

      if (typedPayload?.integrationWizard?.autoLaunch && typedPayload.integrationWizard.required.length > 0) {
        onOpenIntegrationWizardAction?.(typedPayload.integrationWizard.required, sessionId.current);
      }

      if (typedPayload?.planner?.readyToBuild && typedPayload.planner.canonicalPrompt) {
        await onPlannerReadyAction(typedPayload.planner.canonicalPrompt);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Conversation failed';
      setRuntimeState((prev) => ({
        ...prev,
        conversation: prev.conversation.map((msg) =>
          msg.id === assistantId
            ? {
                ...msg,
                content: `I hit a snag while setting that up: ${message}. Please try again and I will continue from there.`,
              }
            : msg
        ),
      }));
    } finally {
      setIsThinking(false);
      setThinkingLabel(THINKING_STEPS[0]);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleReset() {
    clearRevealTimers();
    if (typeof window !== 'undefined') {
      clearRuntimeState(window.localStorage);
    }
    const resetState = createRuntimeState();
    setRuntimeState({
      ...resetState,
      conversation: [
        {
          id: 'welcome',
          role: 'assistant',
          content: 'Fresh start! What automation are we building today?',
          timestamp: new Date(),
        },
      ],
    });
    internalRuntimeStateRef.current = null;
    sessionId.current = resetState.session.id;
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4 h-full">
      <div className="flex flex-col rounded-xl border border-border bg-card overflow-hidden min-h-0">
      <div className="px-4 py-3 border-b border-border bg-muted/20 flex items-center gap-3 flex-shrink-0">
        <div className="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center shadow-sm">
          <Sparkles className="w-4 h-4 text-primary" />
        </div>
        <div>
          <h3 className="text-sm font-semibold">MagicFlux</h3>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            {isThinking ? thinkingLabel : 'Ready to help'}
          </div>
        </div>
        {messages.length > 1 && (
          <button
            onClick={handleReset}
            className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded-md hover:bg-muted/50 transition-colors"
          >
            <RefreshCw className="w-3 h-3" />
            New chat
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin py-3 space-y-1">
        {messages.map((message) => (
          <div key={message.id}>
            {message.role === 'user' ? (
              <div className="flex items-start gap-3 px-4 py-1.5 flex-row-reverse">
                <div className="w-7 h-7 rounded-full bg-secondary border border-border flex items-center justify-center flex-shrink-0 text-xs font-semibold">
                  U
                </div>
                <div className="max-w-[80%] rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm leading-relaxed bg-primary text-primary-foreground">
                  {message.content}
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-3 px-4 py-1.5">
                <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0">
                  <Zap className="w-3.5 h-3.5 text-primary" />
                </div>
                <div className="flex-1 max-w-[85%]">
                  {(() => {
                    const isActiveAssistant = message.id === runtimeState.activeAssistantMessageId;
                    return (
                      <>
                  <div className="rounded-2xl rounded-tl-sm px-4 py-2.5 text-sm leading-relaxed text-foreground bg-muted/50 whitespace-pre-wrap">
                    {message.content}
                  </div>
                  {message.options && message.options.length > 0 && (
                    <div className="mt-2 flex flex-col gap-1.5">
                      <p className="text-xs text-muted-foreground px-1">Choose one:</p>
                      {message.options.map((option, index) => (
                        <button
                          key={`${message.id}-${index}`}
                          onClick={() => handleSend(option)}
                          className="text-left text-xs px-3 py-2 rounded-lg border border-border hover:border-primary/40 hover:bg-primary/5 text-muted-foreground hover:text-foreground transition-colors"
                        >
                          <ChevronRight className="w-3 h-3 inline mr-1 text-primary" />
                          {option}
                        </button>
                      ))}
                    </div>
                  )}
                  <ProgressTimeline cards={message.progressCards ?? []} />
                  {isActiveAssistant && runtimeState.liveWorkflow ? <LiveWorkflowPanel status={runtimeState.liveWorkflow} /> : null}
                  {isActiveAssistant && runtimeState.workflowSummary ? <WorkflowSummaryCard summary={runtimeState.workflowSummary} /> : null}
                  {isActiveAssistant && runtimeState.automationBrain ? <AutomationBrainCard brain={runtimeState.automationBrain} /> : null}
                  {isActiveAssistant ? (
                    <IntegrationCards
                      cards={runtimeState.integrationCards}
                      onConnect={(provider) => onOpenIntegrationWizardAction?.([provider], sessionId.current)}
                    />
                  ) : null}
                  {isActiveAssistant && runtimeState.automationBrain?.credentialIntelligence && runtimeState.automationBrain.credentialIntelligence.length > 0 ? (
                    <CredentialIntelligenceCard
                      items={runtimeState.automationBrain.credentialIntelligence}
                      accessToken={accessToken}
                      onCredentialSaved={(provider) => {
                        setRuntimeState((prev) => {
                          const updatedCredIntel = prev.automationBrain?.credentialIntelligence?.map((c) =>
                            c.provider === provider ? { ...c, ready: true, missing: [] } : c
                          ) ?? [];
                          const credBlocked = updatedCredIntel.some((c) => !c.ready && c.missing.length > 0);
                          const intBlocked = prev.integrationCards.some((card) => !card.connected && card.requiredFields.length > 0);
                          return {
                            ...prev,
                            automationBrain: prev.automationBrain
                              ? { ...prev.automationBrain, credentialIntelligence: updatedCredIntel }
                              : prev.automationBrain,
                            deployState: {
                              ...prev.deployState,
                              blocked: credBlocked || intBlocked,
                              ready: Boolean(prev.workflowGraph) && !credBlocked && !intBlocked,
                            },
                          };
                        });
                      }}
                    />
                  ) : null}
                  {isActiveAssistant && runtimeState.workflowGraph && !runtimeState.deployState.workflowActive ? (
                    <DeployActionCard
                      blocked={runtimeState.deployState.blocked}
                      blockedReason={
                        runtimeState.deployState.blocked
                          ? runtimeState.automationBrain?.credentialIntelligence?.some((c) => !c.ready && c.missing.length > 0)
                            ? `Connect required integrations first: ${runtimeState.automationBrain.credentialIntelligence.filter((c) => !c.ready).map((c) => c.displayName).join(', ')}`
                            : 'Connect required integrations first, then approve deployment.'
                          : undefined
                      }
                      onDeploy={() => handleSend('Approve and deploy this workflow now.')}
                    />
                  ) : null}
                  {isActiveAssistant ? <ApprovalCards approvals={runtimeState.approvalState.requests} /> : null}
                  {isActiveAssistant && runtimeState.deployState.workflowUrl && runtimeState.deployState.workflowActive ? (
                    <WorkflowSuccessCard url={runtimeState.deployState.workflowUrl} />
                  ) : null}
                      </>
                    );
                  })()}
                </div>
              </div>
            )}
          </div>
        ))}

        {isThinking && <TypingIndicator label={thinkingLabel} />}

        {messages.length === 1 && !isThinking && (
          <div className="px-4 py-3">
            <div className="rounded-xl border border-border bg-muted/20 p-3 mb-2">
              <p className="text-sm font-medium">Ready to build something?</p>
              <p className="text-xs text-muted-foreground mt-1">Tell me what you want to automate and I'll handle the rest.</p>
            </div>
            <p className="text-xs text-muted-foreground mb-2">Some ideas:</p>
            <div className="flex flex-wrap gap-1.5">
              {PROMPT_EXAMPLES.slice(0, 4).map((example) => (
                <button
                  key={example}
                  onClick={() => handleSend(example)}
                  className="text-xs px-2.5 py-1.5 rounded-lg border border-border hover:border-primary/40 hover:bg-primary/5 text-muted-foreground hover:text-foreground transition-all flex items-center gap-1"
                >
                  <ChevronRight className="w-3 h-3" />
                  {example}
                </button>
              ))}
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div className="p-3 border-t border-border bg-muted/10 flex-shrink-0">
        <div className="flex gap-2 items-end">
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="What do you want to automate today?"
            className="resize-none text-base md:text-sm min-h-[42px] max-h-[120px] bg-background border-border focus:border-primary scrollbar-thin"
            rows={1}
            disabled={isThinking}
          />
          <Button
            onClick={() => handleSend()}
            disabled={!input.trim() || isThinking}
            size="icon"
            className="h-10 w-10 flex-shrink-0 shadow-md shadow-primary/20"
          >
            {isThinking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mt-1.5 px-1">
          Enter to send • Shift+Enter for new line
        </p>
      </div>
      </div>{/* end inner chat column */}
      <aside className="hidden lg:flex flex-col overflow-y-auto">
        <AutomationBrain prompt={input} accessToken={accessToken} />
      </aside>
    </div>
  );
}

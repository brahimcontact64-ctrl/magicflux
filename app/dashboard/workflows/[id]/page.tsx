'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import {
  ArrowLeft,
  Loader2,
  Pencil,
  Rocket,
  Copy,
  Trash2,
  Play,
  Sparkles,
  Save,
  FileJson,
  CircleAlert,
  ExternalLink,
  History,
  Clock,
  Pause,
  PlayCircle,
  Ban,
  Archive,
  CalendarClock,
  Webhook,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme-toggle';
import { supabase } from '@/lib/supabase-client';
import { requiredProvidersFromWorkflow } from '@/lib/integrations';
import { apiRequest } from '@/lib/api/client';
import { ExecutionStatusBadge } from '@/components/app/execution-status-badge';
import { SetupRequiredAlert } from '@/components/app/setup-required-alert';
import { WorkflowEditor } from '@/components/workflow-editor/WorkflowEditor';
import type { WorkflowJson } from '@/lib/workflow-editor/types';
import { validateWorkflow } from '@/lib/workflow-validator';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

type Workflow = {
  id: string;
  user_id: string;
  name: string;
  description: string;
  prompt: string;
  workflow_json: Record<string, unknown>;
  integrations: string[];
  status: 'draft' | 'deployed' | 'validating' | 'active' | 'paused' | 'disabled' | 'error' | 'archived';
  n8n_workflow_id: string | null;
  deployed_at?: string | null;
  active_deployment_version_id?: string | null;
  activated_at?: string | null;
  deployment_error?: string | null;
  deployed_version?: number | null;
  created_at: string;
  updated_at: string;
};

type WorkflowSchedule = {
  id: string;
  node_id: string;
  node_name: string;
  schedule_type: 'cron' | 'interval';
  cron_expression: string | null;
  interval_seconds: number | null;
  timezone: string;
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_error: string | null;
};

type TestStep = {
  nodeName: string;
  nodeType: string;
  status: 'success' | 'simulated_success' | 'failed' | 'skipped' | 'waiting';
  input: unknown;
  output: unknown;
  logs: string[];
  error?: string;
};

type TestResult = {
  success: boolean;
  status: 'success' | 'failed' | 'simulated_success';
  steps: TestStep[];
  finalOutput: unknown;
  previews: {
    emails: Array<Record<string, unknown>>;
    slackMessages: Array<Record<string, unknown>>;
    airtableRecords: Array<Record<string, unknown>>;
  };
  error?: string;
  runId?: string | null;
  simulated?: boolean;
  simulationMessage?: string | null;
  warnings?: string[];
};

type WorkflowRun = {
  id: string;
  status: 'success' | 'failed';
  logs: TestStep[];
  previews: {
    emails: Array<Record<string, unknown>>;
    slackMessages: Array<Record<string, unknown>>;
    airtableRecords: Array<Record<string, unknown>>;
  };
  final_output: unknown;
  error_message: string | null;
  created_at: string;
};

type ExecutionV2 = {
  id: string;
  status: 'running' | 'waiting' | 'success' | 'failed' | 'cancelled';
  display_status?: 'running' | 'waiting' | 'success' | 'simulated_success' | 'failed' | 'cancelled';
  mode: 'test' | 'live';
  current_node_id: string | null;
  error_message: string | null;
  retry_count: number;
  next_run_at: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
};

type ExecutionStepV2 = {
  id: string;
  node_id: string;
  node_name: string;
  node_type: string;
  status: string;
  input_data: unknown;
  output_data: unknown;
  logs: string[];
  error_message: string | null;
  attempt: number;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
};

type WorkflowIntegrationOption = {
  integrationId: string;
  name: string | null;
  attached: boolean;
};

type WorkflowIntegrationsPayload = {
  requiredProviders: string[];
  availableByProvider: Record<string, WorkflowIntegrationOption[]>;
  attached: Array<{ provider: string; integrationId: string }>;
};

function formatDate(iso: string | null | undefined) {
  if (!iso) return '-';
  const date = new Date(iso);
  return date.toLocaleString();
}

function parseJsonInput(value: string): Record<string, unknown> | null {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export default function WorkflowDetailsPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();

  const { session, refreshPlan } = useAuth();
  const [activatingPro, setActivatingPro] = useState(false);

  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [runningTest, setRunningTest] = useState(false);
  const [runningLiveTest, setRunningLiveTest] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [missingIntegrations, setMissingIntegrations] = useState<string[]>([]);
  const [executions, setExecutions] = useState<ExecutionV2[]>([]);
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null);
  const [executionSteps, setExecutionSteps] = useState<ExecutionStepV2[]>([]);
  const [loadingSteps, setLoadingSteps] = useState(false);
  const [workflowIntegrations, setWorkflowIntegrations] = useState<WorkflowIntegrationsPayload | null>(null);
  const [selectedIntegrationByProvider, setSelectedIntegrationByProvider] = useState<Record<string, string>>({});
  const [attachingProvider, setAttachingProvider] = useState<string | null>(null);
  const [schedules, setSchedules] = useState<WorkflowSchedule[]>([]);
  const [lifecycleBusy, setLifecycleBusy] = useState<string | null>(null);
  const [lifecycleErrors, setLifecycleErrors] = useState<string[]>([]);

  // Phase 9.3.1: previously hardcoded to `true` (SHOW_DEV), which forced
  // this dev-only control to render for every production user regardless
  // of the env var it claimed to be gated by. Now controlled solely by the
  // env var, matching /api/dev/activate-pro's own server-side gate.
  const devProEnabled = process.env.NEXT_PUBLIC_ENABLE_DEV_PRO_BUTTON === 'true';

  const handleDevActivatePro = useCallback(async () => {
    if (!session) return;
    setActivatingPro(true);
    try {
      const res = await fetch('/api/dev/activate-pro', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) throw new Error('Failed');
      await refreshPlan();
      toast.success('Pro activated for testing');
    } catch {
      toast.error('Dev activation failed');
    } finally {
      setActivatingPro(false);
    }
  }, [session, refreshPlan]);

  const [nameInput, setNameInput] = useState('');
  const [descriptionInput, setDescriptionInput] = useState('');
  const [promptInput, setPromptInput] = useState('');
  const [jsonInput, setJsonInput] = useState('{}');

  // Visual editor tab state
  const [activeTab, setActiveTab] = useState<'visual' | 'json'>('visual');
  // Incremented to force-remount the visual editor when the workflow is reloaded/regenerated
  const [editorKey, setEditorKey] = useState(0);

  const withAuthHeaders = useCallback(async (): Promise<HeadersInit | null> => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) {
      toast.error('Session expired. Please sign in again.');
      return null;
    }

    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };
  }, []);

  const loadWorkflow = useCallback(async () => {
    setLoading(true);
    try {
      const headers = await withAuthHeaders();
      if (!headers) return;

      const payload = await apiRequest<{ workflow?: Workflow; schedules?: WorkflowSchedule[] }>(
        `/api/workflows/${params.id}`,
        {
          headers,
          cache: 'no-store',
        },
        'Failed to load workflow'
      );
      const wf = payload?.workflow;
      if (!wf) throw new Error('Workflow not found');

      setWorkflow(wf);
      setSchedules(payload?.schedules ?? []);
      setNameInput(wf.name ?? '');
      setDescriptionInput(wf.description ?? '');
      setPromptInput(wf.prompt ?? '');
      setJsonInput(JSON.stringify(wf.workflow_json ?? {}, null, 2));
      setMissingIntegrations([]);
      setEditorKey((k) => k + 1); // remount visual editor with fresh data
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load workflow');
    } finally {
      setLoading(false);
    }
  }, [params.id, withAuthHeaders]);

  const loadRuns = useCallback(async () => {
    const headers = await withAuthHeaders();
    if (!headers) return;

    const payload = await apiRequest<{ runs?: WorkflowRun[] }>(
      `/api/workflows/${params.id}/runs`,
      {
        headers,
        cache: 'no-store',
      },
      'Failed to load runs'
    ).catch(() => null);
    if (!payload) return;

    setRuns(payload?.runs ?? []);
  }, [params.id, withAuthHeaders]);

  const loadExecutions = useCallback(async () => {
    const headers = await withAuthHeaders();
    if (!headers) return;

    const payload = await apiRequest<{ executions?: ExecutionV2[] }>(
      `/api/workflows/${params.id}/executions`,
      {
        headers,
        cache: 'no-store',
      },
      'Failed to load executions'
    ).catch(() => null);
    if (payload) setExecutions(payload.executions ?? []);
  }, [params.id, withAuthHeaders]);

  const loadExecutionSteps = useCallback(async (executionId: string) => {
    const headers = await withAuthHeaders();
    if (!headers) return;

    setLoadingSteps(true);
    try {
      const payload = await apiRequest<{ steps?: ExecutionStepV2[] }>(
        `/api/workflows/executions/${executionId}/steps`,
        {
          headers,
          cache: 'no-store',
        },
        'Failed to load execution steps'
      ).catch(() => null);
      if (payload) setExecutionSteps(payload.steps ?? []);
    } finally {
      setLoadingSteps(false);
    }
  }, [withAuthHeaders]);

  const loadWorkflowIntegrations = useCallback(async () => {
    const headers = await withAuthHeaders();
    if (!headers) return;

    const payload = await apiRequest<WorkflowIntegrationsPayload>(
      `/api/workflows/${params.id}/integrations`,
      {
        headers,
        cache: 'no-store',
      },
      'Failed to load workflow integrations'
    ).catch(() => null);
    if (!payload) return;

    setWorkflowIntegrations(payload);
    const selected: Record<string, string> = {};
    payload.requiredProviders.forEach((provider) => {
      const attached = payload.attached.find((item) => item.provider === provider);
      if (attached) {
        selected[provider] = attached.integrationId;
        return;
      }
      const options = payload.availableByProvider[provider] ?? [];
      if (options.length > 0) {
        selected[provider] = options[0].integrationId;
      }
    });
    setSelectedIntegrationByProvider(selected);
  }, [params.id, withAuthHeaders]);

  useEffect(() => {
    loadWorkflow();
    loadRuns();
    loadExecutions();
    loadWorkflowIntegrations();
  }, [loadWorkflow, loadRuns, loadExecutions, loadWorkflowIntegrations]);

  // Called by the visual editor's Save button.
  const handleSaveFromEditor = useCallback(async (wf: WorkflowJson) => {
    if (!workflow) return;

    const result = validateWorkflow(wf as unknown);
    if (!result.valid) {
      toast.error(`Cannot save: ${result.errors[0]?.message ?? 'validation failed'}`);
      return;
    }

    setSaving(true);
    try {
      const headers = await withAuthHeaders();
      if (!headers) return;

      const res = await fetch(`/api/workflows/${workflow.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          name: wf.name || nameInput.trim(),
          description: descriptionInput.trim(),
          prompt: promptInput,
          workflow_json: wf,
          status: 'draft',
        }),
      });

      const payload = await res.json().catch(() => null) as { workflow?: Workflow; error?: string } | null;
      if (!res.ok) throw new Error(payload?.error ?? 'Failed to save workflow');

      if (payload?.workflow) {
        setWorkflow(payload.workflow);
        setJsonInput(JSON.stringify(payload.workflow.workflow_json ?? {}, null, 2));
        setEditorKey((k) => k + 1);
      }
      toast.success('Workflow saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save workflow');
    } finally {
      setSaving(false);
    }
  }, [workflow, withAuthHeaders, nameInput, descriptionInput, promptInput]);

  const nodesCount = useMemo(() => {
    const nodes = workflow?.workflow_json?.nodes;
    return Array.isArray(nodes) ? nodes.length : 0;
  }, [workflow]);

  const integrationsUsed = useMemo(() => {
    if (!workflow) return [] as string[];
    return requiredProvidersFromWorkflow(workflow.workflow_json);
  }, [workflow]);

  const webhookInfo = useMemo(() => {
    const nodes = workflow?.workflow_json?.nodes;
    const list = Array.isArray(nodes) ? (nodes as Array<Record<string, unknown>>) : [];
    const webhookNode = list.find((n) => String(n.type ?? '').toLowerCase().includes('webhook') && !String(n.type ?? '').toLowerCase().includes('trigger.'));
    if (!webhookNode) return null;
    const method = String((webhookNode.parameters as Record<string, unknown> | undefined)?.httpMethod ?? 'POST').toUpperCase();
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    return {
      method,
      url: workflow ? `${origin}/api/workflows/${workflow.id}/webhook` : '',
      hasSecret: Boolean((((workflow?.workflow_json?.security ?? workflow?.workflow_json?.webhook_security) as Record<string, unknown> | undefined)?.webhook_secret)),
    };
  }, [workflow]);

  const handleCopyWebhookUrl = useCallback(() => {
    if (!webhookInfo?.url) return;
    navigator.clipboard.writeText(webhookInfo.url).then(() => toast.success('Webhook URL copied')).catch(() => toast.error('Copy failed'));
  }, [webhookInfo]);

  const latestRun = runs[0] ?? null;
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? null;

  const lifecycleStatus = useMemo<'Draft' | 'Simulated Test Passed' | 'Live Tested' | 'Running' | 'Waiting' | 'Deployed' | 'Failed'>(() => {
    if (!workflow) return 'Draft';

    const latestExec = executions[0];
    if (latestExec?.status === 'running') return 'Running';
    if (latestExec?.status === 'waiting') return 'Waiting';
    if (latestExec?.status === 'failed') return 'Failed';

    if (latestExec?.status === 'success') {
      return latestExec.mode === 'test' ? 'Simulated Test Passed' : 'Live Tested';
    }

    if (workflow.status === 'deployed') return 'Deployed';
    if (latestRun?.status === 'failed') return 'Failed';
    if (latestRun?.status === 'success') return 'Simulated Test Passed';
    return 'Draft';
  }, [workflow, executions, latestRun]);

  const handleSave = useCallback(async () => {
    if (!workflow) return;

    const parsedJson = parseJsonInput(jsonInput);
    if (!parsedJson) {
      toast.error('Workflow JSON is invalid');
      return;
    }

    setSaving(true);
    try {
      const headers = await withAuthHeaders();
      if (!headers) return;

      const nextIntegrations = requiredProvidersFromWorkflow(parsedJson);
      const res = await fetch(`/api/workflows/${workflow.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          name: nameInput.trim(),
          description: descriptionInput.trim(),
          prompt: promptInput,
          workflow_json: parsedJson,
          integrations: nextIntegrations,
          status: 'draft',
        }),
      });

      const payload = await res.json().catch(() => null) as { workflow?: Workflow; error?: string } | null;
      if (!res.ok) throw new Error(payload?.error ?? 'Failed to save workflow');

      if (payload?.workflow) {
        setWorkflow(payload.workflow);
        setJsonInput(JSON.stringify(payload.workflow.workflow_json ?? {}, null, 2));
      }

      setEditing(false);
      toast.success('Workflow updated');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save workflow');
    } finally {
      setSaving(false);
    }
  }, [workflow, jsonInput, withAuthHeaders, nameInput, descriptionInput, promptInput]);

  const handleRegenerate = useCallback(async () => {
    if (!workflow) return;
    if (!promptInput.trim()) {
      toast.error('Prompt is required to regenerate');
      return;
    }

    setRegenerating(true);
    try {
      const headers = await withAuthHeaders();
      if (!headers) return;

      const res = await fetch(`/api/workflows/${workflow.id}/regenerate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ prompt: promptInput.trim() }),
      });

      const payload = await res.json().catch(() => null) as {
        workflow?: Workflow;
        error?: string;
        generationAdjusted?: boolean;
        generationWarning?: string;
      } | null;
      if (!res.ok) throw new Error(payload?.error ?? 'Failed to save regenerated workflow');

      if (payload?.workflow) {
        setWorkflow(payload.workflow);
        setNameInput(payload.workflow.name ?? '');
        setDescriptionInput(payload.workflow.description ?? '');
        setJsonInput(JSON.stringify(payload.workflow.workflow_json ?? {}, null, 2));
      }

      if (payload?.generationAdjusted || payload?.generationWarning) {
        toast.warning(payload?.generationWarning ?? 'Workflow adjusted to match your request');
      }

      toast.success('Workflow regenerated with AI');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to regenerate workflow');
    } finally {
      setRegenerating(false);
    }
  }, [workflow, withAuthHeaders, promptInput]);

  const handleDuplicate = useCallback(async () => {
    if (!workflow) return;

    setDuplicating(true);
    try {
      const headers = await withAuthHeaders();
      if (!headers) return;

      const res = await fetch(`/api/workflows/${workflow.id}/duplicate`, {
        method: 'POST',
        headers,
      });
      const payload = await res.json().catch(() => null) as { workflow?: Workflow; error?: string } | null;
      if (!res.ok) throw new Error(payload?.error ?? 'Failed to duplicate workflow');

      toast.success('Workflow duplicated');
      const nextId = payload?.workflow?.id;
      if (nextId) router.push(`/dashboard/workflows/${nextId}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to duplicate workflow');
    } finally {
      setDuplicating(false);
    }
  }, [workflow, withAuthHeaders, router]);

  const handleLifecycleAction = useCallback(async (action: 'activate' | 'pause' | 'resume' | 'deactivate' | 'archive') => {
    if (!workflow) return;

    setLifecycleBusy(action);
    setLifecycleErrors([]);
    try {
      const headers = await withAuthHeaders();
      if (!headers) return;

      const res = await fetch(`/api/workflows/${workflow.id}/lifecycle`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action }),
      });
      const payload = await res.json().catch(() => null) as { success?: boolean; errors?: string[]; error?: string; message?: string; redirect?: string } | null;

      if (!res.ok || !payload?.success) {
        // PRO_REQUIRED carries a human-readable `message` (the entitlement
        // reason) separately from `error` (the machine code) — show the
        // message, and send the user straight to the place that resolves it.
        if (payload?.error === 'PRO_REQUIRED') {
          const reason = payload.message ?? 'This plan does not support live activation.';
          setLifecycleErrors([reason]);
          toast.error(reason);
          router.push(payload.redirect ?? '/pricing');
          return;
        }

        const errors = payload?.errors ?? (payload?.message ? [payload.message] : payload?.error ? [payload.error] : ['Action failed']);
        setLifecycleErrors(errors);
        toast.error(errors[0] ?? 'Action failed');
        await loadWorkflow();
        return;
      }

      const successLabel: Record<typeof action, string> = {
        activate: 'Workflow activated',
        pause: 'Workflow paused',
        resume: 'Workflow resumed',
        deactivate: 'Workflow deactivated',
        archive: 'Workflow archived',
      };
      toast.success(successLabel[action]);
      await loadWorkflow();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Action failed');
    } finally {
      setLifecycleBusy(null);
    }
  }, [workflow, withAuthHeaders, loadWorkflow, router]);

  const handleDelete = useCallback(async () => {
    if (!workflow) return;

    setDeleting(true);
    try {
      const headers = await withAuthHeaders();
      if (!headers) return;

      const res = await fetch(`/api/workflows/${workflow.id}`, {
        method: 'DELETE',
        headers,
      });
      const payload = await res.json().catch(() => null) as { error?: string } | null;
      if (!res.ok) throw new Error(payload?.error ?? 'Delete failed');

      toast.success('Workflow deleted');
      router.push('/dashboard');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Delete failed');
    } finally {
      setDeleting(false);
    }
  }, [workflow, withAuthHeaders, router]);

  const handleRunTest = useCallback(async () => {
    if (!workflow) return;

    setRunningTest(true);
    setTestResult(null);
    setMissingIntegrations([]);
    try {
      const headers = await withAuthHeaders();
      if (!headers) return;

      const res = await fetch(`/api/workflows/${workflow.id}/test`, {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });

      const payload = await res.json().catch(() => null) as {
        success?: boolean;
        status?: 'success' | 'failed' | 'waiting' | 'simulated_success';
        message?: string;
        steps?: TestStep[];
        finalOutput?: unknown;
        previews?: TestResult['previews'];
        error?: string;
        missingIntegrations?: string[];
        runId?: string | null;
        executionId?: string;
        nextRunAt?: string | null;
        simulated?: boolean;
        simulationMessage?: string | null;
        warnings?: string[];
      } | null;

      if (!res.ok) {
        if (payload?.error === 'SETUP_REQUIRED') {
          setMissingIntegrations(payload?.missingIntegrations ?? []);
          toast.error('Please configure integrations first');
          return;
        }

        throw new Error(payload?.error ?? 'Test run failed');
      }

      setTestResult({
        success: payload?.success === true,
        status: (payload?.status === 'waiting' ? 'failed' : payload?.status) ?? 'failed',
        steps: payload?.steps ?? [],
        finalOutput: payload?.finalOutput ?? null,
        previews: payload?.previews ?? { emails: [], slackMessages: [], airtableRecords: [] },
        error: payload?.error,
        runId: payload?.runId,
        simulated: payload?.simulated ?? true,
        simulationMessage: payload?.simulationMessage ?? null,
        warnings: payload?.warnings ?? [],
      });

      await loadRuns();
      await loadExecutions();
      if (payload?.status === 'simulated_success') {
        toast.warning('SIMULATED TEST: No real APIs were called.');
      } else {
        toast.success(payload?.status === 'waiting' ? 'Execution waiting (scheduled resume)' : 'Test execution completed');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Test run failed';
      setTestResult({
        success: false,
        status: 'failed',
        steps: [],
        finalOutput: null,
        previews: { emails: [], slackMessages: [], airtableRecords: [] },
        error: message,
      });
      toast.error(message);
    } finally {
      setRunningTest(false);
    }
  }, [workflow, withAuthHeaders, loadRuns, loadExecutions]);

  const handleRunLiveTest = useCallback(async () => {
    if (!workflow) return;

    const confirmed = window.confirm('This will call real APIs and may send real messages/emails. Continue?');
    if (!confirmed) return;

    setRunningLiveTest(true);
    setTestResult(null);
    setMissingIntegrations([]);
    try {
      const headers = await withAuthHeaders();
      if (!headers) return;

      const res = await fetch(`/api/workflows/${workflow.id}/live-test`, {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });

      const payload = await res.json().catch(() => null) as {
        success?: boolean;
        status?: 'success' | 'failed' | 'waiting' | 'simulated_success';
        message?: string;
        steps?: TestStep[];
        finalOutput?: unknown;
        error?: string;
        missingIntegrations?: string[];
        executionId?: string;
        nextRunAt?: string | null;
      } | null;

      if (!res.ok) {
        if (payload?.error === 'SETUP_REQUIRED') {
          setMissingIntegrations(payload?.missingIntegrations ?? []);
          toast.error('Live test blocked: integrations must be connected and valid.');
          return;
        }
        throw new Error(payload?.error ?? payload?.message ?? 'Live test failed');
      }

      setTestResult({
        success: payload?.status === 'success',
        status: (payload?.status as TestResult['status']) ?? 'failed',
        steps: payload?.steps ?? [],
        finalOutput: payload?.finalOutput ?? null,
        previews: { emails: [], slackMessages: [], airtableRecords: [] },
        error: payload?.error,
        simulated: false,
        simulationMessage: null,
        warnings: [],
      });

      await loadExecutions();
      if (payload?.status === 'success') {
        toast.success('LIVE SUCCESS');
      } else if (payload?.status === 'waiting') {
        toast.success('Execution waiting (scheduled resume)');
      } else {
        toast.error(payload?.message ?? 'Live execution failed');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Live test failed';
      setTestResult({
        success: false,
        status: 'failed',
        steps: [],
        finalOutput: null,
        previews: { emails: [], slackMessages: [], airtableRecords: [] },
        error: message,
      });
      toast.error(message);
    } finally {
      setRunningLiveTest(false);
    }
  }, [workflow, withAuthHeaders, loadExecutions]);

  const handleAttachIntegration = useCallback(async (provider: string) => {
    if (!workflowIntegrations) return;
    const integrationId = selectedIntegrationByProvider[provider];
    if (!integrationId) {
      toast.error(`Select an integration for ${provider}`);
      return;
    }

    setAttachingProvider(provider);
    try {
      const headers = await withAuthHeaders();
      if (!headers) return;

      const res = await fetch(`/api/workflows/${params.id}/integrations`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ provider, integrationId }),
      });
      const payload = await res.json().catch(() => null) as { error?: string } | null;
      if (!res.ok) throw new Error(payload?.error ?? 'Failed to attach integration');

      toast.success(`${provider} integration attached`);
      await loadWorkflowIntegrations();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to attach integration');
    } finally {
      setAttachingProvider(null);
    }
  }, [workflowIntegrations, selectedIntegrationByProvider, withAuthHeaders, params.id, loadWorkflowIntegrations]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!workflow) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-6">
        <div className="rounded-xl border border-border bg-card p-8 text-center max-w-md">
          <CircleAlert className="w-8 h-8 text-amber-400 mx-auto mb-3" />
          <p className="text-sm font-medium mb-1">Workflow not found</p>
          <p className="text-xs text-muted-foreground mb-4">It may have been deleted or you do not have access.</p>
          <Link href="/dashboard"><Button size="sm">Back to Dashboard</Button></Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="h-14 border-b border-border bg-card/50 backdrop-blur sticky top-0 z-10 flex items-center px-6 gap-4">
        <Link href="/dashboard" className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="w-3.5 h-3.5" />
          Dashboard
        </Link>
        <div className="w-px h-4 bg-border" />
        <span className="text-xs font-medium truncate">{workflow.name}</span>
        <div className="flex-1" />
        <ThemeToggle />
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8 space-y-5">
        <div className="rounded-xl border border-border bg-card p-4 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setEditing((v) => !v)}>
              <Pencil className="w-3.5 h-3.5" />
              Edit Workflow
            </Button>
            <a href="#workflow-integrations">
              <Button size="sm" variant="outline" className="gap-1.5">Attach Integrations</Button>
            </a>
            {devProEnabled && (
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 border-orange-500/50 bg-orange-500/10 text-orange-400 hover:bg-orange-500/20 hover:text-orange-300"
                onClick={handleDevActivatePro}
                disabled={activatingPro}
                title="Development only"
              >
                {activatingPro ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'DEV'}
                Activate Pro
              </Button>
            )}
            <Button size="sm" variant="secondary" className="gap-1.5" onClick={handleDuplicate} disabled={duplicating}>
              {duplicating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Copy className="w-3.5 h-3.5" />}
              Duplicate
            </Button>
            <Button size="sm" variant="outline" className="gap-1.5" onClick={handleRunTest} disabled={runningTest}>
              {runningTest ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
              Run Simulated Test
            </Button>
            <Button size="sm" variant="outline" className="gap-1.5" onClick={handleRunLiveTest} disabled={runningLiveTest}>
              {runningLiveTest ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Rocket className="w-3.5 h-3.5" />}
              Run Live Test
            </Button>

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="destructive" className="gap-1.5">
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this workflow?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This action cannot be undone. The workflow will be permanently removed from your dashboard.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleDelete} disabled={deleting}>
                    {deleting ? 'Deleting...' : 'Delete'}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-3 text-xs">
            <div className="rounded-lg border border-border bg-muted/20 px-3 py-2">
              <p className="text-muted-foreground">Name</p>
              <p className="font-medium truncate mt-0.5">{workflow.name}</p>
            </div>
            <div className="rounded-lg border border-border bg-muted/20 px-3 py-2">
              <p className="text-muted-foreground">Status</p>
              <p className="font-medium mt-0.5">{lifecycleStatus}</p>
            </div>
            <div className="rounded-lg border border-border bg-muted/20 px-3 py-2">
              <p className="text-muted-foreground">Nodes</p>
              <p className="font-medium mt-0.5">{nodesCount}</p>
            </div>
            <div className="rounded-lg border border-border bg-muted/20 px-3 py-2 sm:col-span-2 lg:col-span-2">
              <p className="text-muted-foreground">Integrations Used</p>
              <p className="font-medium mt-0.5 truncate">{integrationsUsed.length ? integrationsUsed.join(', ') : 'None'}</p>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs">
            <p className="text-muted-foreground">Description</p>
            <p className="mt-0.5">{workflow.description || 'No description'}</p>
          </div>

          {/* Phase 9.1.5: the "Open in n8n" post-deploy banner was removed
              along with the /api/workflows/[id]/deploy button above — that
              route is the legacy external-n8n path, no longer wired into
              this page. Production Control below (Activate/Pause/Resume)
              is the single, certified activation path now. */}
        </div>

        <div className="rounded-xl border border-border bg-card p-4 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold">Production Control</p>
            <span className={
              'text-[11px] px-2 py-1 rounded-full border ' +
              (workflow.status === 'active' ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                : workflow.status === 'paused' ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                : workflow.status === 'error' ? 'bg-red-500/15 text-red-300 border-red-500/30'
                : workflow.status === 'archived' ? 'bg-muted/40 text-muted-foreground border-border'
                : workflow.status === 'disabled' ? 'bg-muted/40 text-muted-foreground border-border'
                : 'bg-blue-500/15 text-blue-300 border-blue-500/30')
            }>
              {workflow.status}
            </span>
          </div>

          <div className="grid sm:grid-cols-3 gap-3 text-xs">
            <div className="rounded-lg border border-border bg-muted/20 px-3 py-2">
              <p className="text-muted-foreground">Deployed Version</p>
              <p className="font-medium mt-0.5">{workflow.deployed_version ?? '—'}</p>
            </div>
            <div className="rounded-lg border border-border bg-muted/20 px-3 py-2">
              <p className="text-muted-foreground">Activated At</p>
              <p className="font-medium mt-0.5">{formatDate(workflow.activated_at)}</p>
            </div>
            <div className="rounded-lg border border-border bg-muted/20 px-3 py-2">
              <p className="text-muted-foreground">Last Run</p>
              <p className="font-medium mt-0.5">{formatDate(executions[0]?.started_at)}</p>
            </div>
          </div>

          {workflow.status === 'error' && workflow.deployment_error && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {workflow.deployment_error}
            </div>
          )}

          {lifecycleErrors.length > 0 && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300 space-y-1">
              {lifecycleErrors.map((err, idx) => <p key={idx}>{err}</p>)}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {(workflow.status === 'draft' || workflow.status === 'disabled' || workflow.status === 'error') && (
              <Button size="sm" className="gap-1.5" onClick={() => handleLifecycleAction('activate')} disabled={lifecycleBusy !== null}>
                {lifecycleBusy === 'activate' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Rocket className="w-3.5 h-3.5" />}
                Activate
              </Button>
            )}
            {workflow.status === 'active' && (
              <>
                <Button size="sm" variant="outline" className="gap-1.5" onClick={() => handleLifecycleAction('pause')} disabled={lifecycleBusy !== null}>
                  {lifecycleBusy === 'pause' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Pause className="w-3.5 h-3.5" />}
                  Pause
                </Button>
                <Button size="sm" variant="outline" className="gap-1.5" onClick={() => handleLifecycleAction('deactivate')} disabled={lifecycleBusy !== null}>
                  {lifecycleBusy === 'deactivate' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Ban className="w-3.5 h-3.5" />}
                  Deactivate
                </Button>
              </>
            )}
            {workflow.status === 'paused' && (
              <>
                <Button size="sm" className="gap-1.5" onClick={() => handleLifecycleAction('resume')} disabled={lifecycleBusy !== null}>
                  {lifecycleBusy === 'resume' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlayCircle className="w-3.5 h-3.5" />}
                  Resume
                </Button>
                <Button size="sm" variant="outline" className="gap-1.5" onClick={() => handleLifecycleAction('deactivate')} disabled={lifecycleBusy !== null}>
                  {lifecycleBusy === 'deactivate' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Ban className="w-3.5 h-3.5" />}
                  Deactivate
                </Button>
              </>
            )}
            {workflow.status !== 'archived' && (
              <Button size="sm" variant="destructive" className="gap-1.5" onClick={() => handleLifecycleAction('archive')} disabled={lifecycleBusy !== null}>
                {lifecycleBusy === 'archive' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Archive className="w-3.5 h-3.5" />}
                Archive
              </Button>
            )}
          </div>

          {webhookInfo && (
            <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-1.5">
              <p className="text-xs font-medium flex items-center gap-1.5"><Webhook className="w-3.5 h-3.5" /> Production Webhook</p>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="px-1.5 py-0.5 rounded bg-muted/40 text-muted-foreground font-mono">{webhookInfo.method}</span>
                <code className="flex-1 min-w-[220px] truncate rounded bg-black/20 border border-border px-2 py-1">{webhookInfo.url}</code>
                <Button size="sm" variant="outline" className="gap-1.5 h-7" onClick={handleCopyWebhookUrl}>
                  <Copy className="w-3.5 h-3.5" /> Copy
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {webhookInfo.hasSecret ? 'Signature verification is configured for this webhook.' : 'No webhook secret configured — requests are accepted unsigned.'}
                {' '}Only fires while the workflow is Active.
              </p>
            </div>
          )}

          {schedules.length > 0 && (
            <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-2">
              <p className="text-xs font-medium flex items-center gap-1.5"><CalendarClock className="w-3.5 h-3.5" /> Schedules</p>
              {schedules.map((s) => (
                <div key={s.id} className="rounded-md border border-border bg-background/40 px-2.5 py-2 text-xs flex flex-wrap items-center gap-3">
                  <span className="font-medium">{s.node_name}</span>
                  <span className="px-1.5 py-0.5 rounded bg-muted/40 text-muted-foreground font-mono">
                    {s.schedule_type === 'cron' ? s.cron_expression : `every ${s.interval_seconds}s`}
                  </span>
                  <span className="text-muted-foreground">{s.timezone}</span>
                  <span className={s.enabled ? 'text-emerald-400' : 'text-muted-foreground'}>{s.enabled ? 'enabled' : 'disabled'}</span>
                  {s.next_run_at && <span className="text-muted-foreground">Next: {formatDate(s.next_run_at)}</span>}
                  {s.last_error && <span className="text-red-300 truncate max-w-[200px]">{s.last_error}</span>}
                </div>
              ))}
            </div>
          )}
        </div>

        <div id="workflow-integrations" className="rounded-xl border border-border bg-card p-4 space-y-3">
          <div>
            <p className="text-sm font-semibold">Workflow Integrations</p>
            <p className="text-xs text-muted-foreground mt-0.5">Attach which connected integration this workflow should use per provider.</p>
          </div>

          {workflowIntegrations?.requiredProviders?.length ? (
            <div className="space-y-3">
              {workflowIntegrations.requiredProviders.map((provider) => {
                const options = workflowIntegrations.availableByProvider[provider] ?? [];
                const attached = workflowIntegrations.attached.find((item) => item.provider === provider);
                const hasSelection = Boolean(attached?.integrationId || selectedIntegrationByProvider[provider]);

                return (
                  <div key={provider} className="rounded-lg border border-border bg-muted/20 p-3">
                    <div className="flex flex-wrap items-center gap-2 justify-between">
                      <div>
                        <p className="text-xs font-medium uppercase tracking-wide">{provider}</p>
                        <p className="text-[11px] text-muted-foreground mt-0.5">
                          {attached ? 'Attached and ready for deploy' : 'Attach an integration before deploy'}
                        </p>
                      </div>
                      {attached ? (
                        <span className="text-[11px] px-2 py-1 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">Attached</span>
                      ) : (
                        <span className="text-[11px] px-2 py-1 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30">Required</span>
                      )}
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <select
                        className="h-8 min-w-[220px] rounded-md border border-border bg-background px-2 text-xs"
                        value={selectedIntegrationByProvider[provider] ?? ''}
                        onChange={(e) => setSelectedIntegrationByProvider((prev) => ({ ...prev, [provider]: e.target.value }))}
                      >
                        {options.length === 0 ? <option value="">No connected integrations</option> : null}
                        {options.map((option) => (
                          <option key={option.integrationId} value={option.integrationId}>{option.name ?? 'Default integration'}</option>
                        ))}
                      </select>
                      <Button
                        size="sm"
                        onClick={() => handleAttachIntegration(provider)}
                        disabled={options.length === 0 || !hasSelection || attachingProvider === provider}
                      >
                        {attachingProvider === provider ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Attach Integration'}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">This workflow has no provider requirements.</p>
          )}
        </div>

        {/* ── Visual / JSON / Settings tabs ── */}
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          {/* Tab bar */}
          <div className="flex items-center border-b border-border bg-muted/20 px-4">
            {(['visual', 'json'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={
                  'px-4 py-3 text-xs font-medium border-b-2 transition-colors ' +
                  (activeTab === tab
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground')
                }
              >
                {tab === 'visual' ? 'Visual Editor' : 'JSON Editor'}
              </button>
            ))}

            {/* Regenerate (JSON tab) / Save (JSON tab) */}
            <div className="ml-auto flex items-center gap-2 py-2">
              {activeTab === 'json' && editing && (
                <>
                  <Button size="sm" variant="outline" className="gap-1.5 h-7" onClick={handleRegenerate} disabled={regenerating}>
                    {regenerating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                    Regenerate
                  </Button>
                  <Button size="sm" className="gap-1.5 h-7" onClick={handleSave} disabled={saving}>
                    {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                    Save
                  </Button>
                </>
              )}
            </div>
          </div>

          {/* Visual Editor tab */}
          {activeTab === 'visual' && (
            <div className="p-4">
              {workflow.workflow_json ? (
                <WorkflowEditor
                  key={editorKey}
                  initialWorkflow={workflow.workflow_json as unknown as WorkflowJson}
                  onWorkflowChange={(wf) => {
                    setJsonInput(JSON.stringify(wf, null, 2));
                  }}
                  showSaveButton
                  onSave={handleSaveFromEditor}
                  height="580px"
                />
              ) : (
                <p className="text-xs text-muted-foreground">No workflow data available.</p>
              )}
            </div>
          )}

          {/* JSON Editor tab */}
          {activeTab === 'json' && (
            <div className="p-4 space-y-3">
              {editing ? (
                <div className="space-y-3">
                  <div className="grid sm:grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-muted-foreground">Workflow Name</label>
                      <input
                        value={nameInput}
                        onChange={(e) => setNameInput(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:border-primary"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground">Description</label>
                      <input
                        value={descriptionInput}
                        onChange={(e) => setDescriptionInput(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:border-primary"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="text-xs text-muted-foreground">Prompt</label>
                    <textarea
                      value={promptInput}
                      onChange={(e) => setPromptInput(e.target.value)}
                      rows={3}
                      className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:border-primary resize-y"
                    />
                  </div>

                  <div>
                    <label className="text-xs text-muted-foreground">Editable Workflow JSON</label>
                    <textarea
                      value={jsonInput}
                      onChange={(e) => setJsonInput(e.target.value)}
                      rows={18}
                      className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-xs font-mono leading-relaxed focus:outline-none focus:border-primary resize-y"
                    />
                  </div>
                </div>
              ) : (
                <details className="rounded-lg border border-border bg-muted/20 p-3 text-xs">
                  <summary className="cursor-pointer font-medium text-foreground flex items-center gap-2">
                    <FileJson className="w-3.5 h-3.5 text-primary" />
                    Workflow JSON
                  </summary>
                  <pre className="mt-2 whitespace-pre-wrap break-words overflow-auto max-h-[560px]">
                    {JSON.stringify(workflow.workflow_json, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-border bg-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold">Test Runtime</p>
            <Button size="sm" variant="outline" className="gap-1.5" onClick={handleRunTest} disabled={runningTest}>
              {runningTest ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
              Run Simulated Test
            </Button>
            <Button size="sm" variant="outline" className="gap-1.5" onClick={handleRunLiveTest} disabled={runningLiveTest}>
              {runningLiveTest ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Rocket className="w-3.5 h-3.5" />}
              Run Live Test
            </Button>
          </div>

          <SetupRequiredAlert missingIntegrations={missingIntegrations} />

          {testResult && (
            <div className="rounded-lg border border-border p-3 space-y-3">
              <div className="flex items-center gap-2 text-sm">
                <ExecutionStatusBadge status={testResult.status === 'simulated_success' ? 'simulated_success' : testResult.status === 'success' ? 'success' : 'failed'} />
                {testResult.runId && <span className="text-xs text-muted-foreground">Run: {testResult.runId}</span>}
              </div>

              {testResult.error && <p className="text-xs text-red-300">{testResult.error}</p>}
              {testResult.simulated && (
                <p className="text-xs text-amber-300">No real APIs were called.</p>
              )}
              {(testResult.warnings ?? []).length > 0 && (
                <div className="rounded border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-200 space-y-1">
                  {(testResult.warnings ?? []).map((warning, idx) => (
                    <p key={`${warning}-${idx}`}>{warning}</p>
                  ))}
                </div>
              )}

              <div>
                <p className="text-xs font-semibold mb-2">Node Timeline</p>
                <div className="space-y-2">
                  {testResult.steps.map((step, idx) => (
                    <div key={`${step.nodeName}-${idx}`} className="rounded-md border border-border bg-muted/20 p-2 text-xs space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-medium truncate">{step.nodeName} ({step.nodeType})</p>
                        <span className={
                          step.status === 'failed'
                            ? 'text-red-400'
                            : step.status === 'skipped' || step.status === 'simulated_success'
                              ? 'text-amber-400'
                              : 'text-emerald-400'
                        }>
                          {step.status}
                        </span>
                      </div>
                      <pre className="rounded bg-black/20 border border-border p-2 overflow-auto max-h-24">{(step.logs ?? []).join('\n') || 'No logs'}</pre>
                      {step.error && <p className="text-red-300">{step.error}</p>}
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid md:grid-cols-3 gap-3">
                <div className="rounded-md border border-border bg-muted/20 p-2 text-xs">
                  <p className="font-semibold mb-1">Email Preview</p>
                  <pre className="overflow-auto max-h-40">{JSON.stringify(testResult.previews.emails, null, 2)}</pre>
                </div>
                <div className="rounded-md border border-border bg-muted/20 p-2 text-xs">
                  <p className="font-semibold mb-1">Slack Preview</p>
                  <pre className="overflow-auto max-h-40">{JSON.stringify(testResult.previews.slackMessages, null, 2)}</pre>
                </div>
                <div className="rounded-md border border-border bg-muted/20 p-2 text-xs">
                  <p className="font-semibold mb-1">Airtable Preview</p>
                  <pre className="overflow-auto max-h-40">{JSON.stringify(testResult.previews.airtableRecords, null, 2)}</pre>
                </div>
              </div>

              <div>
                <p className="text-xs font-semibold mb-1">Final JSON Output</p>
                <pre className="rounded bg-black/20 border border-border p-2 text-xs overflow-auto max-h-56">{JSON.stringify(testResult.finalOutput, null, 2)}</pre>
              </div>
            </div>
          )}
        </div>

        <div className="rounded-xl border border-border bg-card p-4 space-y-3">
          <p className="text-sm font-semibold flex items-center gap-2">
            <History className="w-4 h-4" />
            Executions
          </p>

          {executions.length === 0 ? (
            <p className="text-xs text-muted-foreground">No executions yet. Run a test to get started.</p>
          ) : (
            <div className="space-y-2">
              {executions.map((exec) => {
                const displayStatus = exec.display_status ?? exec.status;

                return (
                  <div key={exec.id} className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs flex flex-wrap items-center gap-3">
                    <ExecutionStatusBadge status={displayStatus} />
                    <span className="bg-muted/40 text-muted-foreground px-1.5 py-0.5 rounded text-[10px]">{exec.mode}</span>
                    {exec.current_node_id && (
                      <span className="text-muted-foreground truncate max-w-[120px]">@ {exec.current_node_id}</span>
                    )}
                    <span className="text-muted-foreground flex items-center gap-1">
                      <Clock className="w-3 h-3" />{formatDate(exec.started_at)}
                    </span>
                    {exec.completed_at && (
                      <span className="text-muted-foreground">→ {formatDate(exec.completed_at)}</span>
                    )}
                    {exec.next_run_at && (
                      <span className="text-amber-300 flex items-center gap-1">
                        <Clock className="w-3 h-3" />Resume: {formatDate(exec.next_run_at)}
                      </span>
                    )}
                    {exec.error_message && <span className="text-red-300 truncate max-w-[200px]">{exec.error_message}</span>}
                    <div className="flex-1" />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        if (selectedExecutionId === exec.id) {
                          setSelectedExecutionId(null);
                          setExecutionSteps([]);
                        } else {
                          setSelectedExecutionId(exec.id);
                          await loadExecutionSteps(exec.id);
                        }
                      }}
                    >
                      {selectedExecutionId === exec.id ? 'Hide Steps' : 'View Steps'}
                    </Button>
                  </div>
                );
              })}
            </div>
          )}

          {selectedExecutionId && (
            <div className="rounded-md border border-border p-3 space-y-2">
              <p className="text-xs font-semibold">Steps for execution {selectedExecutionId.slice(0, 8)}...</p>
              {loadingSteps ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="w-3 h-3 animate-spin" /> Loading steps...
                </div>
              ) : executionSteps.length === 0 ? (
                <p className="text-xs text-muted-foreground">No steps recorded.</p>
              ) : (
                <div className="space-y-2">
                  {executionSteps.map((step, idx) => {
                    const sc =
                      step.status === 'success' ? 'text-emerald-400'
                      : step.status === 'simulated_success' ? 'text-amber-400'
                      : step.status === 'failed' ? 'text-red-400'
                      : step.status === 'waiting' ? 'text-amber-400'
                      : step.status === 'skipped' ? 'text-muted-foreground'
                      : 'text-blue-400';

                    return (
                      <div key={step.id ?? idx} className="rounded-md border border-border bg-muted/10 p-2 text-xs space-y-1">
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <p className="font-medium">{step.node_name ?? step.node_id} <span className="text-muted-foreground">({step.node_type})</span></p>
                          <div className="flex items-center gap-2">
                            {step.attempt > 1 && <span className="text-amber-300 text-[10px]">attempt #{step.attempt}</span>}
                            <span className={`font-medium ${sc}`}>{step.status}</span>
                          </div>
                        </div>
                        <pre className="rounded bg-black/20 border border-border p-2 overflow-auto max-h-20">
                          {Array.isArray(step.logs) ? step.logs.join('\n') : String(step.logs ?? 'No logs')}
                        </pre>
                        {step.error_message && <p className="text-red-300">{step.error_message}</p>}
                        <details className="group">
                          <summary className="cursor-pointer text-[10px] text-muted-foreground select-none">Input / Output</summary>
                          <div className="mt-1 grid grid-cols-2 gap-2">
                            <div>
                              <p className="text-[10px] text-muted-foreground mb-0.5">Input</p>
                              <pre className="rounded bg-black/20 border border-border p-1.5 overflow-auto max-h-28 text-[10px]">{JSON.stringify(step.input_data, null, 2)}</pre>
                            </div>
                            <div>
                              <p className="text-[10px] text-muted-foreground mb-0.5">Output</p>
                              <pre className="rounded bg-black/20 border border-border p-1.5 overflow-auto max-h-28 text-[10px]">{JSON.stringify(step.output_data, null, 2)}</pre>
                            </div>
                          </div>
                        </details>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

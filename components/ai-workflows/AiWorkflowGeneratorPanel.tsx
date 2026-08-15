'use client';

import { useState, useCallback } from 'react';
import { Loader2, Sparkles, Wrench, CheckCircle2, AlertCircle } from 'lucide-react';

import { Button }   from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge }    from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { WorkflowEditor } from '@/components/workflow-editor/WorkflowEditor';
import type { WorkflowJson } from '@/lib/workflow-editor/types';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SafeExample {
  id:              string;
  naturalLanguage: string;
  intent:          string;
  tags:            string[];
}

// Matches both the generator API response shape and our WorkflowJson type.
type GeneratedWorkflow = WorkflowJson;

interface GenerateApiResponse {
  workflow:      GeneratedWorkflow;
  valid:         boolean;
  examplesUsed:  SafeExample[];
  repairApplied: boolean;
}

interface ApiError {
  error:    string;
  errors?:  Array<{ code: string; message: string; path?: string }>;
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface AiWorkflowGeneratorPanelProps {
  /** Called when the user clicks "Use this workflow". Receives the (possibly edited) workflow JSON. */
  onWorkflowGenerated?: (workflow: GeneratedWorkflow) => void | Promise<void>;
  /** Disable all interactive elements (e.g. while save is in progress). */
  disabled?: boolean;
  /** Additional className on the outer wrapper. */
  className?: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function AiWorkflowGeneratorPanel({
  onWorkflowGenerated,
  disabled = false,
  className,
}: AiWorkflowGeneratorPanelProps) {
  const [prompt,   setPrompt  ] = useState('');
  const [loading,  setLoading ] = useState(false);
  const [result,   setResult  ] = useState<GenerateApiResponse | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);

  // Tracks the (possibly user-edited) workflow — starts as the generated version,
  // updated live as the user edits the canvas.
  const [editingWorkflow, setEditingWorkflow] = useState<GeneratedWorkflow | null>(null);
  // Stable key: when a new workflow is generated we remount the editor.
  const [editorKey, setEditorKey] = useState(0);

  const generate = useCallback(async () => {
    if (!prompt.trim()) return;

    setLoading(true);
    setResult(null);
    setApiError(null);
    setEditingWorkflow(null);

    try {
      const res = await fetch('/api/ai/workflows/generate', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ prompt: prompt.trim() }),
      });

      const data: GenerateApiResponse | ApiError = await res.json();

      if (!res.ok) {
        const err = data as ApiError;
        setApiError(err.error ?? 'Generation failed. Please try again.');
        return;
      }

      const ok = data as GenerateApiResponse;
      setResult(ok);
      setEditingWorkflow(ok.workflow);
      setEditorKey((k) => k + 1); // remount editor with fresh workflow
    } catch {
      setApiError('Network error. Please check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, [prompt]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      void generate();
    }
  }, [generate]);

  const useWorkflow = useCallback(() => {
    if (editingWorkflow) onWorkflowGenerated?.(editingWorkflow);
  }, [editingWorkflow, onWorkflowGenerated]);

  return (
    <div className={className}>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-violet-500" />
            <CardTitle className="text-lg">AI Workflow Generator</CardTitle>
          </div>
          <CardDescription>
            Describe your automation in plain English. Press{' '}
            <kbd className="rounded border bg-muted px-1 py-0.5 text-xs font-mono">⌘ Enter</kbd>{' '}
            or click Generate.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* Prompt input */}
          <Textarea
            placeholder="e.g. When a Shopify order arrives, send a Slack message to #orders and log it in Airtable"
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={3}
            className="resize-none"
            disabled={loading || disabled}
            aria-label="Workflow prompt"
          />

          {/* Generate button */}
          <Button
            onClick={generate}
            disabled={loading || disabled || !prompt.trim()}
            className="w-full gap-2"
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Generating…
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4" />
                Generate workflow
              </>
            )}
          </Button>

          {/* Error state */}
          {apiError && !loading && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{apiError}</AlertDescription>
            </Alert>
          )}

          {/* Result: status badges + visual editor */}
          {result && editingWorkflow && !loading && (
            <div className="space-y-4 pt-1">

              {/* Status row */}
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant={result.valid ? 'default' : 'destructive'}
                  className="gap-1"
                >
                  <CheckCircle2 className="h-3 w-3" />
                  Valid workflow
                </Badge>

                {result.repairApplied && (
                  <Badge variant="secondary" className="gap-1">
                    <Wrench className="h-3 w-3" />
                    Auto-repaired
                  </Badge>
                )}

                <span className="text-xs text-muted-foreground ml-auto">
                  {editingWorkflow.nodes.length} node{editingWorkflow.nodes.length !== 1 ? 's' : ''}
                  {' · '}
                  {Object.keys(editingWorkflow.connections).length} connection{Object.keys(editingWorkflow.connections).length !== 1 ? 's' : ''}
                </span>
              </div>

              {/* Workflow name */}
              <p className="text-sm font-medium text-foreground">{editingWorkflow.name}</p>

              {/* Visual editor — user can modify before saving */}
              <WorkflowEditor
                key={editorKey}
                initialWorkflow={editingWorkflow}
                onWorkflowChange={setEditingWorkflow}
                height="400px"
                showSaveButton={false}
              />

              {/* Examples used */}
              {result.examplesUsed.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1.5 uppercase tracking-wide">
                    Based on
                  </p>
                  <ul className="space-y-1">
                    {result.examplesUsed.map(ex => (
                      <li key={ex.id} className="text-xs text-muted-foreground flex items-start gap-1.5">
                        <span className="mt-0.5 text-violet-400">›</span>
                        <span>{ex.naturalLanguage}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Use workflow button */}
              <Button
                onClick={useWorkflow}
                className="w-full"
                variant="default"
                disabled={!onWorkflowGenerated || disabled}
                title={!onWorkflowGenerated ? 'No handler registered for onWorkflowGenerated' : undefined}
              >
                Use this workflow
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

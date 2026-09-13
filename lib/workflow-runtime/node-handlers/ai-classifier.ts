/**
 * AI Structured Classifier -- magicflux-nodes.aiClassifier (Phase 9.9.1).
 *
 * The first real, reusable AI-inference runtime capability: takes workflow
 * input data plus a plain-language instruction and a fixed set of allowed
 * output labels, and produces a deterministic, schema-validated structured
 * result -- { classification, confidence, reason, needs_review, ...input }.
 * Generic by design (lead scoring, intent detection, sentiment/category
 * routing, confidence-gated review) -- nothing here is specific to any one
 * use case; the instruction/allowedLabels/extractFields parameters are what
 * make it concrete for a given workflow.
 *
 * Security/product-truth contract this handler exists to satisfy:
 *   - Uses ONLY the platform's own server-side OpenAI key
 *     (process.env.OPENAI_API_KEY, the same infrastructure
 *     generateWorkflowJson() already uses) -- never a user-connected
 *     integration credential, so there is no per-user API key exposure.
 *   - Input data is deep-redacted (lib/security/redact.ts's redact(), the
 *     one authoritative secret-scrubbing utility already used by every
 *     other handler/log path) before it ever reaches a prompt.
 *   - Output is JSON-only, schema-validated against allowedLabels and a
 *     numeric confidence strictly within [0,1] -- a model that invents an
 *     out-of-range confidence or an unlisted label is treated as malformed
 *     output, not accepted with a clamp/best-effort guess.
 *   - Bounded retries (malformed output only, never network/API errors) --
 *     fails closed with status:'failed' once exhausted, never fabricates a
 *     result.
 */

import OpenAI from 'openai';
import type { EngineNode, NodeHandlerContext, NodeHandlerResult } from '../types';
import { redact, redactText } from '@/lib/security/redact';
import { recordAiUsage } from '@/lib/agent/observability';

const MODEL = 'gpt-4o-mini';
const MAX_INPUT_CHARS = 4000;
const MAX_OUTPUT_TOKENS = 500;
const MAX_RETRIES = 2; // total attempts = 1 + MAX_RETRIES
const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;
const DEFAULT_OUTPUT_FIELD = 'classification';

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

type ExtractField = { name: string; description?: string };

type ClassifierParams = {
  instruction: string;
  allowedLabels: string[];
  inputFields: string[] | null;
  outputField: string;
  confidenceThreshold: number;
  extractFields: ExtractField[];
};

type ParamResult = { ok: true; params: ClassifierParams } | { ok: false; error: string };

function parseParams(node: EngineNode): ParamResult {
  const raw = asRecord(node.parameters);

  const instruction = typeof raw.instruction === 'string' ? raw.instruction.trim() : '';
  if (!instruction) {
    return { ok: false, error: 'AI Classifier: "instruction" is required (what to classify/decide and on what basis).' };
  }

  const allowedLabelsRaw = Array.isArray(raw.allowedLabels) ? raw.allowedLabels : [];
  const allowedLabels = allowedLabelsRaw.map((l) => String(l).trim()).filter(Boolean);
  if (allowedLabels.length === 0) {
    return { ok: false, error: 'AI Classifier: "allowedLabels" is required and must be a non-empty array of label strings.' };
  }

  const inputFieldsRaw = Array.isArray(raw.inputFields) ? raw.inputFields : null;
  const inputFields = inputFieldsRaw ? inputFieldsRaw.map((f) => String(f).trim()).filter(Boolean) : null;

  const outputField = typeof raw.outputField === 'string' && raw.outputField.trim() ? raw.outputField.trim() : DEFAULT_OUTPUT_FIELD;

  const thresholdRaw = raw.confidenceThreshold;
  const confidenceThreshold =
    typeof thresholdRaw === 'number' && Number.isFinite(thresholdRaw) && thresholdRaw >= 0 && thresholdRaw <= 1
      ? thresholdRaw
      : DEFAULT_CONFIDENCE_THRESHOLD;

  const extractFieldsRaw = Array.isArray(raw.extractFields) ? raw.extractFields : [];
  const extractFields: ExtractField[] = extractFieldsRaw
    .map((f) => asRecord(f))
    .map((f) => ({ name: String(f.name ?? '').trim(), description: typeof f.description === 'string' ? f.description : undefined }))
    .filter((f) => f.name.length > 0);

  return {
    ok: true,
    params: { instruction, allowedLabels, inputFields, outputField, confidenceThreshold, extractFields },
  };
}

/** Deep-redacts secrets (the one authoritative utility, shared with every other handler), then bounds size. */
function buildInputSnapshot(data: Record<string, unknown>, inputFields: string[] | null): string {
  const source = inputFields && inputFields.length > 0
    ? Object.fromEntries(inputFields.map((f) => [f, data[f]]))
    : data;
  const safe = redact(source);
  const json = JSON.stringify(safe);
  return json.length > MAX_INPUT_CHARS ? `${json.slice(0, MAX_INPUT_CHARS)}…[TRUNCATED]` : json;
}

function buildPrompt(params: ClassifierParams, inputJson: string, correctionNote?: string): string {
  const extractLine = params.extractFields.length > 0
    ? `Also include these additional fields in your JSON response: ${params.extractFields.map((f) => `"${f.name}"${f.description ? ` (${f.description})` : ''}`).join(', ')}.`
    : '';

  return `You are a deterministic structured-classification engine. Analyze the input data below and produce ONLY a JSON object -- no prose, no markdown, no explanation outside the JSON.

Classification criteria: ${params.instruction}

Allowed labels (the "classification" field MUST be EXACTLY one of these, verbatim): ${params.allowedLabels.map((l) => `"${l}"`).join(', ')}

Input data (JSON):
${inputJson}

Return ONLY a JSON object with this exact shape:
{
  "classification": "<one of the allowed labels, exactly>",
  "confidence": <a number between 0 and 1 inclusive, your genuine confidence in this classification -- never invent a value outside this range>,
  "reason": "<one short sentence explaining why>"
}
${extractLine}
If you are not confident which label applies, still choose your best-supported label but report a LOW confidence value honestly rather than guessing a high one.
${correctionNote ? `\nYour previous response was invalid: ${correctionNote}\nReturn ONLY corrected valid JSON matching the exact shape above.` : ''}`;
}

type ValidatedOutput = { classification: string; confidence: number; reason: string; extracted: Record<string, unknown> };
type ValidationResult = { ok: true; result: ValidatedOutput } | { ok: false; reason: string };

function validateModelOutput(raw: string, params: ClassifierParams): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'response was not valid JSON' };
  }

  const obj = asRecord(parsed);

  const classificationRaw = obj.classification;
  if (typeof classificationRaw !== 'string' || !classificationRaw.trim()) {
    return { ok: false, reason: '"classification" was missing or not a string' };
  }
  const matchedLabel = params.allowedLabels.find((l) => l.toLowerCase() === classificationRaw.trim().toLowerCase());
  if (!matchedLabel) {
    return { ok: false, reason: `"classification" value "${classificationRaw}" is not one of the allowed labels: ${params.allowedLabels.join(', ')}` };
  }

  const confidenceRaw = obj.confidence;
  const confidence = typeof confidenceRaw === 'number' ? confidenceRaw : Number(confidenceRaw);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { ok: false, reason: `"confidence" must be a number between 0 and 1 (got ${JSON.stringify(confidenceRaw)})` };
  }

  const reason = typeof obj.reason === 'string' ? obj.reason.trim() : '';

  const extracted: Record<string, unknown> = {};
  for (const field of params.extractFields) {
    if (!(field.name in obj)) {
      return { ok: false, reason: `required extracted field "${field.name}" was missing from the response` };
    }
    extracted[field.name] = obj[field.name];
  }

  return { ok: true, result: { classification: matchedLabel, confidence, reason, extracted } };
}

export async function aiClassifierHandler(
  node: EngineNode,
  inputData: unknown,
  context: NodeHandlerContext,
): Promise<NodeHandlerResult> {
  const logs: string[] = [];
  const data = asRecord(inputData);

  const parsedParams = parseParams(node);
  if (!parsedParams.ok) {
    return { status: 'failed', outputData: null, logs: [parsedParams.error], error: parsedParams.error };
  }
  const params = parsedParams.params;

  if (context.mode === 'test') {
    const simulatedConfidence = 0.75;
    const simulated: Record<string, unknown> = {
      [params.outputField]: params.allowedLabels[0],
      confidence: simulatedConfidence,
      reason: '[SIMULATED] Test-mode classification -- no real AI call was made.',
      needs_review: simulatedConfidence < params.confidenceThreshold,
    };
    for (const field of params.extractFields) simulated[field.name] = `[SIMULATED] ${field.name}`;
    logs.push('AI Classifier: simulated in test mode.');
    return { status: 'simulated_success', outputData: { ...data, ...simulated }, logs };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const error = 'AI classification is not available yet -- the platform AI provider is not configured.';
    logs.push(`AI Classifier: ${error}`);
    return { status: 'failed', outputData: null, logs, error };
  }

  const inputJson = buildInputSnapshot(data, params.inputFields);
  const openai = new OpenAI({ apiKey });

  let lastFailureReason = '';
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  const recordUsage = async () => {
    if (!context.userId) return;
    try {
      await recordAiUsage({
        userId: context.userId,
        sessionId: `workflow:${context.workflowId ?? 'unknown'}`,
        workflowId: context.workflowId,
        provider: 'openai',
        model: MODEL,
        agentName: 'runtime',
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
        metadata: { node: node.name ?? node.id ?? 'AI Classifier' },
      });
    } catch {
      // Usage accounting must never be the reason a workflow execution fails.
    }
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const prompt = buildPrompt(params, inputJson, attempt > 0 ? lastFailureReason : undefined);

    let raw = '';
    try {
      const completion = await openai.chat.completions.create({
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0,
        max_tokens: MAX_OUTPUT_TOKENS,
      });
      raw = completion.choices[0]?.message?.content ?? '';
      totalPromptTokens += completion.usage?.prompt_tokens ?? 0;
      totalCompletionTokens += completion.usage?.completion_tokens ?? 0;
    } catch (err) {
      // Network/API errors fail immediately -- only malformed MODEL OUTPUT is retried.
      const msg = redactText(err instanceof Error ? err.message : String(err));
      logs.push(`AI Classifier: API call failed: ${msg}`);
      await recordUsage();
      return { status: 'failed', outputData: null, logs, error: msg };
    }

    const validation = validateModelOutput(raw, params);
    if (validation.ok) {
      await recordUsage();
      const needsReview = validation.result.confidence < params.confidenceThreshold;
      logs.push(
        `AI Classifier: classified as "${validation.result.classification}" (confidence ${validation.result.confidence.toFixed(2)})` +
          `${needsReview ? ' -- below confidence threshold, flagged for review.' : '.'}`
      );
      return {
        status: 'success',
        outputData: {
          ...data,
          [params.outputField]: validation.result.classification,
          confidence: validation.result.confidence,
          reason: validation.result.reason,
          needs_review: needsReview,
          ...validation.result.extracted,
        },
        logs,
      };
    }

    lastFailureReason = validation.reason;
    logs.push(`AI Classifier: malformed output on attempt ${attempt + 1}/${MAX_RETRIES + 1} -- ${validation.reason}`);
  }

  await recordUsage();
  const error = `AI classification failed after ${MAX_RETRIES + 1} attempts: ${lastFailureReason}`;
  logs.push(`AI Classifier: ${error}`);
  return { status: 'failed', outputData: null, logs, error };
}

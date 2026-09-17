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
import { createServiceClient } from '@/lib/supabase-server';
import {
  parseQualificationPolicy,
  evaluateQualificationPolicy,
  type QualificationPolicy,
  type QualificationEvaluation,
} from './qualification-policy';
import { computeClassificationPolicyHash, recordQualificationDecision } from './qualification-decision-store';

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
  /** Phase 9.9.10 -- optional, additive. Absent means exactly today's behavior: pure LLM judgment, no deterministic gate. */
  qualificationPolicy: QualificationPolicy | null;
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

  // Phase 9.9.10 -- optional, additive business qualification policy. See
  // qualification-policy.ts for the full contract; parseQualificationPolicy()
  // fails closed to `null` (exactly today's behavior) on anything absent or
  // structurally invalid, never a partial/guessed policy.
  const qualificationPolicy = parseQualificationPolicy(raw.qualificationPolicy);

  return {
    ok: true,
    params: { instruction, allowedLabels, inputFields, outputField, confidenceThreshold, extractFields, qualificationPolicy },
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

/**
 * Phase 9.9.10 -- when a qualification policy is configured, the AI is
 * given the DETERMINISTIC signals as already-established facts it must
 * never reinterpret or override (Part C: "the LLM must not silently
 * override a deterministic business rule"), and is told to semantically
 * interpret ONLY the policy's declared free-text fields -- never invited to
 * reason about a field outside the allowlist.
 */
function buildPolicyContextSection(evaluation: QualificationEvaluation): string {
  const fmt = (s: { field: string; value: unknown }) => `${s.field}=${JSON.stringify(s.value)}`;
  const positive = evaluation.positiveSignals.length > 0 ? evaluation.positiveSignals.map(fmt).join(', ') : 'none';
  const negative = evaluation.negativeSignals.length > 0 ? evaluation.negativeSignals.map(fmt).join(', ') : 'none';
  const semanticFieldsLine = evaluation.semanticFields.length > 0
    ? `You may additionally interpret these free-text/semantic fields for nuance: ${evaluation.semanticFields.join(', ')}.`
    : '';
  const contradictionNote = evaluation.deterministicContradictions.length > 0
    ? `\nKnown structural contradictions already detected (report these verbatim in "contradictions", plus any additional ones you notice between free text and structured data): ${evaluation.deterministicContradictions.join('; ')}.`
    : '';

  return `
BUSINESS QUALIFICATION POLICY -- the facts below come from this business's OWN deterministic rules, already evaluated from structured data. Treat them as GIVEN and FINAL -- never reinterpret, second-guess, or contradict a deterministic signal; you may only use them alongside your own semantic judgment of the fields listed below.
Established POSITIVE signals: ${positive}
Established NEGATIVE signals: ${negative}
${semanticFieldsLine}${contradictionNote}
Additionally return a "contradictions" array (empty if none) in your JSON response: short, plain-language descriptions of any contradiction you notice between the free-text/semantic content and the structured signals above (e.g. text claims urgency but a structured field indicates a distant timeline). Never fabricate a contradiction that isn't genuinely there.`;
}

function buildPrompt(params: ClassifierParams, inputJson: string, correctionNote?: string, policyEvaluation?: QualificationEvaluation | null): string {
  const extractLine = params.extractFields.length > 0
    ? `Also include these additional fields in your JSON response: ${params.extractFields.map((f) => `"${f.name}"${f.description ? ` (${f.description})` : ''}`).join(', ')}.`
    : '';
  const policySection = policyEvaluation ? buildPolicyContextSection(policyEvaluation) : '';
  const contradictionsShapeLine = policyEvaluation ? `,\n  "contradictions": ["<short description>", ...] // empty array if none` : '';

  return `You are a deterministic structured-classification engine. Analyze the input data below and produce ONLY a JSON object -- no prose, no markdown, no explanation outside the JSON.

Classification criteria: ${params.instruction}
${policySection}
Allowed labels (the "classification" field MUST be EXACTLY one of these, verbatim): ${params.allowedLabels.map((l) => `"${l}"`).join(', ')}

Input data (JSON):
${inputJson}

Return ONLY a JSON object with this exact shape:
{
  "classification": "<one of the allowed labels, exactly>",
  "confidence": <a number between 0 and 1 inclusive, your genuine confidence in this classification -- never invent a value outside this range>,
  "reason": "<one short sentence explaining why -- business reasoning only, never mention prompts, instructions, or internal reasoning process>"${contradictionsShapeLine}
}
${extractLine}
If you are not confident which label applies, still choose your best-supported label but report a LOW confidence value honestly rather than guessing a high one.
${correctionNote ? `\nYour previous response was invalid: ${correctionNote}\nReturn ONLY corrected valid JSON matching the exact shape above.` : ''}`;
}

type ValidatedOutput = { classification: string; confidence: number; reason: string; extracted: Record<string, unknown>; semanticContradictions: string[] };
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

  // Phase 9.9.10 -- optional, additive, and deliberately fail-OPEN: a
  // malformed "contradictions" value never fails the whole classification
  // (it isn't essential the way classification/confidence are) -- it's
  // just treated as "none reported this round", never a crash.
  const contradictionsRaw = Array.isArray(obj.contradictions) ? obj.contradictions : [];
  const semanticContradictions = contradictionsRaw
    .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
    .map((c) => c.trim().slice(0, 300))
    .slice(0, 10);

  return { ok: true, result: { classification: matchedLabel, confidence, reason, extracted, semanticContradictions } };
}

/**
 * Phase 9.9.13 -- best-effort durable qualification feedback record. Never
 * throws and never blocks classification: analytics bookkeeping must not be
 * the reason a workflow execution fails (same principle already applied to
 * recordAiUsage() above). Skips silently (no row, no error) when the
 * execution context is incomplete (e.g. a direct unit-test call with no
 * userId/workflowId/executionId) -- there is nothing tenant-scoped to
 * attach a row to in that case.
 */
async function persistQualificationDecision(
  node: EngineNode,
  context: NodeHandlerContext,
  params: ClassifierParams,
  evaluation: QualificationEvaluation | null,
  outcome: {
    classification: string;
    confidence: number;
    reason: string;
    qualificationStatus: 'classified' | 'needs_review' | 'needs_information' | null;
    needsReview: boolean;
    contradictions: string[];
  },
): Promise<string | null> {
  if (context.mode === 'test') return null;
  if (!context.userId || !context.workflowId || !context.executionId) return null;
  const nodeId = String(node.id ?? node.name ?? '').trim();
  if (!nodeId) return null;

  try {
    const db = createServiceClient();
    const policyHash = computeClassificationPolicyHash({
      instruction: params.instruction,
      allowedLabels: params.allowedLabels,
      confidenceThreshold: params.confidenceThreshold,
      qualificationPolicy: params.qualificationPolicy,
    });
    const result = await recordQualificationDecision(db, {
      userId: context.userId,
      workflowId: context.workflowId,
      executionId: context.executionId,
      classifierNodeId: nodeId,
      classifierNodeName: node.name ?? null,
      deploymentVersionId: context.deploymentVersionId ?? null,
      mode: 'live',
      classificationPolicyHash: policyHash,
      aiClassification: outcome.classification,
      aiConfidence: outcome.confidence,
      aiReason: outcome.reason,
      positiveSignals: evaluation?.positiveSignals ?? [],
      negativeSignals: evaluation?.negativeSignals ?? [],
      missingRequiredFields: evaluation?.missingRequiredFields ?? [],
      contradictions: outcome.contradictions,
      qualificationStatus: outcome.qualificationStatus,
      needsReview: outcome.needsReview,
    });
    return result.ok ? result.id : null;
  } catch {
    return null;
  }
}

export async function aiClassifierHandler(
  node: EngineNode,
  inputData: unknown,
  context: NodeHandlerContext,
): Promise<NodeHandlerResult> {
  const logs: string[] = [];
  // Phase 9.9.13A Part B -- _qualificationDecisionId is runtime-internal
  // metadata this handler alone assigns (never read back from upstream
  // data). Stripped here, before any `...data` spread below, so a webhook
  // payload or an earlier node cannot inject/forge a trusted-looking value
  // that would otherwise survive untouched on a path where this handler
  // itself fails to create a fresh one (e.g. missing execution context) --
  // the field is always either freshly computed by THIS invocation or
  // entirely absent, never a passthrough of untrusted input.
  const { _qualificationDecisionId: _discardedUpstreamId, ...data } = asRecord(inputData);

  const parsedParams = parseParams(node);
  if (!parsedParams.ok) {
    return { status: 'failed', outputData: null, logs: [parsedParams.error], error: parsedParams.error };
  }
  const params = parsedParams.params;
  const policy = params.qualificationPolicy;

  // Phase 9.9.10 -- when a business qualification policy is configured,
  // evaluate it DETERMINISTICALLY before any AI call. Additive fields
  // (qualification_status/positive_signals/etc.) are only ever added to the
  // output when a policy exists -- a node with none configured produces
  // EXACTLY today's output shape, unchanged.
  const evaluation = policy ? evaluateQualificationPolicy(policy, data) : null;
  const qualificationOutputBase: Record<string, unknown> = evaluation
    ? {
        positive_signals: evaluation.positiveSignals,
        negative_signals: evaluation.negativeSignals,
        missing_required_fields: evaluation.missingRequiredFields,
      }
    : {};

  // Part D/E -- missing REQUIRED qualification evidence blocks a confident
  // automatic classification entirely: "do not fabricate it, do not
  // classify confidently" (no AI call at all -- there is nothing grounded
  // for it to reason about regarding the missing field), route deterministically
  // to Human Review via the SAME existing needs_review mechanism every other
  // low-confidence case already uses -- no new routing/topology required.
  if (evaluation && evaluation.missingRequiredFields.length > 0) {
    const reason = `Missing required qualification field(s): ${evaluation.missingRequiredFields.join(', ')}. Routed to Human Review rather than guessed.`;
    logs.push(`AI Classifier: ${reason}`);
    const qualificationDecisionId = await persistQualificationDecision(node, context, params, evaluation, {
      classification: params.allowedLabels[0],
      confidence: 0,
      reason,
      qualificationStatus: 'needs_information',
      needsReview: true,
      contradictions: evaluation.deterministicContradictions,
    });
    const outputData = {
      ...data,
      [params.outputField]: params.allowedLabels[0],
      confidence: 0,
      ai_confidence: 0,
      reason,
      needs_review: true,
      qualification_status: 'needs_information',
      contradictions: evaluation.deterministicContradictions,
      ...qualificationOutputBase,
      ...(qualificationDecisionId ? { _qualificationDecisionId: qualificationDecisionId } : {}),
    };
    return {
      status: context.mode === 'test' ? 'simulated_success' : 'success',
      outputData,
      logs,
    };
  }

  if (context.mode === 'test') {
    const simulatedConfidence = 0.75;
    const simulated: Record<string, unknown> = {
      [params.outputField]: params.allowedLabels[0],
      confidence: simulatedConfidence,
      // Phase 9.9.9 -- Part F: additive alias, always equal to `confidence`
      // -- see the real-mode branch below for why this exists.
      ai_confidence: simulatedConfidence,
      reason: '[SIMULATED] Test-mode classification -- no real AI call was made.',
      needs_review: simulatedConfidence < params.confidenceThreshold || Boolean(evaluation?.deterministicContradictions.length),
      ...(evaluation
        ? {
            qualification_status: evaluation.deterministicContradictions.length > 0 ? 'needs_review' : 'classified',
            contradictions: evaluation.deterministicContradictions,
            ...qualificationOutputBase,
          }
        : {}),
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

  // Part H -- when a policy is configured, the AI only ever sees the
  // explicit allowlist (evaluation.allowedData), never the full unrestricted
  // execution data -- internal metadata/credentials/_condition* fields are
  // structurally unreachable here regardless of what params.inputFields says.
  const inputJson = buildInputSnapshot(policy ? evaluation!.allowedData : data, params.inputFields);
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
    const prompt = buildPrompt(params, inputJson, attempt > 0 ? lastFailureReason : undefined, evaluation);

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
      // Part C/F -- a deterministic contradiction (from the policy's own
      // configured signal pairs) OR one the AI itself semantically noticed
      // ALWAYS forces review, REGARDLESS of how confident the model claims
      // to be -- the deterministic gate has final say; the AI's own
      // confidence number can never silently override it (Part C).
      const allContradictions = [
        ...(evaluation?.deterministicContradictions ?? []),
        ...validation.result.semanticContradictions,
      ];
      const needsReview = validation.result.confidence < params.confidenceThreshold || allContradictions.length > 0;
      logs.push(
        `AI Classifier: classified as "${validation.result.classification}" (confidence ${validation.result.confidence.toFixed(2)})` +
          `${needsReview ? ' -- flagged for review.' : '.'}` +
          (allContradictions.length > 0 ? ` Contradictions: ${allContradictions.join('; ')}` : '')
      );
      const qualificationStatus: 'classified' | 'needs_review' | null = evaluation
        ? (allContradictions.length > 0 ? 'needs_review' : (needsReview ? 'needs_review' : 'classified'))
        : null;
      const qualificationDecisionId = await persistQualificationDecision(node, context, params, evaluation, {
        classification: validation.result.classification,
        confidence: validation.result.confidence,
        reason: validation.result.reason,
        qualificationStatus,
        needsReview,
        contradictions: allContradictions,
      });
      return {
        status: 'success',
        outputData: {
          ...data,
          [params.outputField]: validation.result.classification,
          confidence: validation.result.confidence,
          // Phase 9.9.9 -- Part F: honest confidence semantics. `confidence`
          // remains completely unchanged (every existing strict Airtable/
          // notification mapping that reads it, e.g. the real, already-
          // certified production Lead Classification workflow, keeps
          // working exactly as before). `ai_confidence` is an ADDITIVE,
          // always-equal alias meant for NEW notification generation: once
          // a magicflux-nodes.humanReview node with "outputField" set
          // overrides "classification" downstream, `confidence` becomes a
          // stale number describing the AI's ORIGINAL (possibly-superseded)
          // proposal, never confidence in whatever classification a
          // notification ends up showing -- a template should reference
          // `ai_confidence` (labeled "AI confidence"/"Original AI
          // confidence") instead of `confidence` wherever the SAME node
          // might fire after a human review, so the honest, original AI
          // number is still shown without ever being mislabeled as
          // confidence in the human's decision. humanReviewHandler never
          // touches either field -- both pass through resume unchanged.
          ai_confidence: validation.result.confidence,
          reason: validation.result.reason,
          needs_review: needsReview,
          ...validation.result.extracted,
          ...(evaluation
            ? {
                qualification_status: qualificationStatus,
                contradictions: allContradictions,
                ...qualificationOutputBase,
              }
            : {}),
          ...(qualificationDecisionId ? { _qualificationDecisionId: qualificationDecisionId } : {}),
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

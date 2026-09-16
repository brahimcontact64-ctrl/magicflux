/**
 * Business Qualification Policy -- magicflux-nodes.aiClassifier's optional
 * "qualificationPolicy" parameter (Phase 9.9.10).
 *
 * Root cause this exists to fix: today the ONLY thing telling
 * aiClassifierHandler what "Hot"/"Warm"/"Cold" means for a given business is
 * a free-text `instruction` string handed straight to the LLM -- there is no
 * deterministic, business-owned definition of qualification at all. Two
 * concrete, confirmed problems follow from that: (1) a field the business
 * never asked the trigger to collect (e.g. desired_start) is simply ABSENT
 * from the object handed to the model, which has no way to distinguish
 * "this business doesn't use this signal" from "this lead failed to
 * provide it" -- nothing stops an absence from being silently read as a
 * negative signal; (2) contradictory evidence (very high budget + "just
 * browsing") has no structural place to surface -- the model just picks a
 * label and a number, and a confidently-wrong guess can slip straight
 * through to Airtable/Slack/Gmail with no review.
 *
 * This module is the DETERMINISTIC half of the fix: an explicit, declarative,
 * per-workflow policy describing which input fields matter, which ones are
 * REQUIRED evidence for a confident automatic classification, and which
 * numeric/enum values count as a positive or negative signal -- evaluated
 * with plain comparisons, never arbitrary JS/eval. Free-text/semantic
 * interpretation (a project description, ambiguous purchase-intent wording)
 * stays the AI's job; this module never attempts it.
 *
 * Additive and fully backward compatible: "qualificationPolicy" is OPTIONAL.
 * A node with none configured runs through aiClassifierHandler exactly as
 * it always has (verified in ai-classifier.ts) -- no existing, already-
 * certified workflow changes behavior just because this module now exists.
 */

export type QualificationFieldRule = {
  /** The real input field name this rule reads, e.g. "budget_max", "urgency". */
  field: string;
  /** Required evidence for a confident automatic Hot/Warm/Cold classification. Missing required evidence blocks the AI call entirely (see evaluateQualificationPolicy). */
  required: boolean;
  kind: 'numeric' | 'enum' | 'text';
  /** kind:'numeric' only -- present and >= this counts as a positive signal. */
  positiveMin?: number;
  /** kind:'numeric' only -- present and <= this counts as a negative signal. */
  negativeMax?: number;
  /** kind:'enum' only -- present and case-insensitively equal to one of these counts as a positive signal. */
  positiveValues?: string[];
  /** kind:'enum' only -- present and case-insensitively equal to one of these counts as a negative signal. */
  negativeValues?: string[];
  /** kind:'text' only -- this field's raw (already-redacted) value is handed to the AI as semantic context; never evaluated deterministically, never contributes a positive/negative signal on its own. */
};

export type QualificationContradictionRule = {
  /** A field whose deterministic evaluation triggered a POSITIVE signal. */
  positiveField: string;
  /** A field whose deterministic evaluation triggered a NEGATIVE signal. */
  negativeField: string;
  /** Short, human-readable description surfaced in the contradictions output, e.g. "High budget but low purchase intent". */
  note: string;
};

export type QualificationPolicy = {
  version: 1;
  /**
   * The explicit, exhaustive allowlist of input fields qualification may
   * ever read (Part H) -- a superset of every `field` named below. Nothing
   * outside this list is ever visible to the deterministic evaluator OR the
   * AI prompt, no matter what else the execution's raw input data contains
   * (internal metadata, credentials, headers, _condition* fields are never
   * eligible here regardless -- see isDenylistedFieldName() below).
   */
  allowedInputFields: string[];
  fields: QualificationFieldRule[];
  contradictions?: QualificationContradictionRule[];
};

export type QualificationSignal = { field: string; value: unknown; note?: string };

export type QualificationEvaluation = {
  /** Execution data narrowed to ONLY policy.allowedInputFields, minus any denylisted field name -- the one object both the deterministic evaluator and the AI prompt are built from. */
  allowedData: Record<string, unknown>;
  positiveSignals: QualificationSignal[];
  negativeSignals: QualificationSignal[];
  missingRequiredFields: string[];
  /** Deterministic contradictions only -- see mergeSemanticContradictions() for combining with AI-reported ones. */
  deterministicContradictions: string[];
  /** kind:'text' fields present in allowedData -- the ONLY fields the AI is invited to interpret semantically. */
  semanticFields: string[];
};

import { isDenylistedFieldName } from '@/lib/security/field-denylist';

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function isPresent(v: unknown): boolean {
  return v !== undefined && v !== null && v !== '';
}

/**
 * Parses and validates a raw "qualificationPolicy" node parameter.
 * Fails CLOSED to "no policy" (never throws, never partially applies a
 * malformed policy) on anything structurally invalid -- an aiClassifier
 * node with a broken policy behaves exactly as if none were configured,
 * rather than crashing the node or silently running a half-valid one.
 * Any field name that is denylisted (internal metadata/credential-shaped)
 * is dropped from the policy rather than trusted, even if a generator or a
 * hand-edited workflow tried to name one -- defense in depth on top of the
 * generation-time guard (see qualification-policy-guard.ts).
 */
export function parseQualificationPolicy(raw: unknown): QualificationPolicy | null {
  const obj = asRecord(raw);
  if (obj.version !== 1) return null; // Part J -- unrecognized/future version: ignore, never guess.

  const allowedInputFieldsRaw = Array.isArray(obj.allowedInputFields) ? obj.allowedInputFields : [];
  const allowedInputFields = Array.from(
    new Set(
      allowedInputFieldsRaw
        .map((f) => String(f).trim())
        .filter((f) => f.length > 0 && !isDenylistedFieldName(f))
    )
  );

  const fieldsRaw = Array.isArray(obj.fields) ? obj.fields : [];
  const fields: QualificationFieldRule[] = [];
  for (const f of fieldsRaw) {
    const rec = asRecord(f);
    const field = String(rec.field ?? '').trim();
    if (!field || isDenylistedFieldName(field) || !allowedInputFields.includes(field)) continue; // never trust a field not in the explicit allowlist
    const kind = rec.kind === 'numeric' || rec.kind === 'enum' || rec.kind === 'text' ? rec.kind : null;
    if (!kind) continue;
    fields.push({
      field,
      required: rec.required === true,
      kind,
      positiveMin: typeof rec.positiveMin === 'number' && Number.isFinite(rec.positiveMin) ? rec.positiveMin : undefined,
      negativeMax: typeof rec.negativeMax === 'number' && Number.isFinite(rec.negativeMax) ? rec.negativeMax : undefined,
      positiveValues: Array.isArray(rec.positiveValues) ? rec.positiveValues.map((v) => String(v)) : undefined,
      negativeValues: Array.isArray(rec.negativeValues) ? rec.negativeValues.map((v) => String(v)) : undefined,
    });
  }
  if (fields.length === 0) return null; // a policy that ends up governing nothing is not a policy.

  const fieldNames = new Set(fields.map((f) => f.field));
  const contradictionsRaw = Array.isArray(obj.contradictions) ? obj.contradictions : [];
  const contradictions: QualificationContradictionRule[] = contradictionsRaw
    .map((c) => asRecord(c))
    .map((c) => ({ positiveField: String(c.positiveField ?? ''), negativeField: String(c.negativeField ?? ''), note: String(c.note ?? '').trim() || 'Contradictory signals detected.' }))
    .filter((c) => fieldNames.has(c.positiveField) && fieldNames.has(c.negativeField));

  return { version: 1, allowedInputFields, fields, contradictions };
}

/**
 * The deterministic half of qualification: narrows the execution data to
 * the explicit allowlist (Part H), then evaluates every numeric/enum field
 * rule with plain comparisons only -- no arbitrary JS/eval. A field's
 * ABSENCE never produces a negative signal (Part D) -- it is either simply
 * omitted from both signal lists (optional) or recorded in
 * missingRequiredFields (required), which is a structurally different,
 * explicit outcome a caller must check before ever treating "no signal" as
 * "negative signal".
 */
export function evaluateQualificationPolicy(policy: QualificationPolicy, inputData: unknown): QualificationEvaluation {
  const data = asRecord(inputData);
  const allowedData: Record<string, unknown> = {};
  for (const field of policy.allowedInputFields) {
    if (field in data) allowedData[field] = data[field];
  }

  const positiveSignals: QualificationSignal[] = [];
  const negativeSignals: QualificationSignal[] = [];
  const missingRequiredFields: string[] = [];
  const semanticFields: string[] = [];
  const signalDirectionByField = new Map<string, 'positive' | 'negative'>();

  for (const rule of policy.fields) {
    const value = allowedData[rule.field];
    const present = isPresent(value);

    if (!present) {
      if (rule.required) missingRequiredFields.push(rule.field);
      continue; // Part D -- absence is NEVER scored as a negative signal.
    }

    if (rule.kind === 'text') {
      semanticFields.push(rule.field);
      continue; // free-text/semantic evidence is the AI's job, not scored here.
    }

    if (rule.kind === 'numeric') {
      const num = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(num)) continue; // malformed numeric value -- treated as no signal, never a crash, never a guessed negative.
      if (typeof rule.positiveMin === 'number' && num >= rule.positiveMin) {
        positiveSignals.push({ field: rule.field, value: num });
        signalDirectionByField.set(rule.field, 'positive');
      } else if (typeof rule.negativeMax === 'number' && num <= rule.negativeMax) {
        negativeSignals.push({ field: rule.field, value: num });
        signalDirectionByField.set(rule.field, 'negative');
      }
      continue;
    }

    // kind === 'enum'
    const strValue = String(value).trim().toLowerCase();
    if (rule.positiveValues?.some((v) => v.trim().toLowerCase() === strValue)) {
      positiveSignals.push({ field: rule.field, value });
      signalDirectionByField.set(rule.field, 'positive');
    } else if (rule.negativeValues?.some((v) => v.trim().toLowerCase() === strValue)) {
      negativeSignals.push({ field: rule.field, value });
      signalDirectionByField.set(rule.field, 'negative');
    }
    // An enum value that matches neither list is unknown/unmapped -- no
    // signal either way, never a guessed negative (covers test case
    // "unknown enum/value").
  }

  const deterministicContradictions: string[] = [];
  for (const rule of policy.contradictions ?? []) {
    const posDir = signalDirectionByField.get(rule.positiveField);
    const negDir = signalDirectionByField.get(rule.negativeField);
    if (posDir === 'positive' && negDir === 'negative') {
      deterministicContradictions.push(rule.note);
    }
  }

  return { allowedData, positiveSignals, negativeSignals, missingRequiredFields, deterministicContradictions, semanticFields };
}

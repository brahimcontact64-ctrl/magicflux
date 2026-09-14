/**
 * Phase 9.9.4A -- template-expression product-truth guard.
 *
 * The runtime's shared resolver (lib/workflow-runtime/node-handlers/
 * json-field-reference.ts) supports an explicit, narrow contract: a plain
 * literal, an exact `={{$json["field"]}}` whole-value expression, or one or
 * more `{{$json["field"]}}` references embedded inside a larger string.
 * Anything else inside `{{ ... }}` -- arithmetic, function calls, pipes,
 * general n8n/JS expression syntax -- is left completely inert at runtime
 * (never evaluated, never causes a crash) by design. That silence is safe
 * for the runtime but unhelpful for a user who wrote (or the generator
 * produced) something like `{{$json["name"].toUpperCase()}}` expecting it to
 * work: it would silently render as literal, un-interpolated text.
 *
 * This is a deterministic, fail-closed backstop: reject generation/
 * activation of a node whose message-style parameters (subject/text/body/
 * message) or Airtable field mapping contain a `{{ ... }}` occurrence
 * outside the supported grammar, so the gap is caught before persistence
 * or a live run rather than discovered as silently-wrong message content.
 */

import { hasUnsupportedTemplateSyntax } from '@/lib/workflow-runtime/node-handlers/json-field-reference';

export type TemplateExpressionValidation = { ok: true } | { ok: false; reason: string; node: string };

const MESSAGE_PARAM_KEYS = ['subject', 'text', 'html', 'message', 'body'];

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function collectTemplateStrings(node: Record<string, unknown>): Array<{ key: string; value: string }> {
  const params = asRecord(node.parameters);
  const found: Array<{ key: string; value: string }> = [];

  for (const key of MESSAGE_PARAM_KEYS) {
    const val = params[key];
    if (typeof val === 'string') found.push({ key, value: val });
  }

  const fields = asRecord(params.fields);
  for (const [fieldKey, val] of Object.entries(fields)) {
    if (typeof val === 'string') found.push({ key: `fields.${fieldKey}`, value: val });
  }

  return found;
}

/**
 * Rejects any node whose message-style parameters or Airtable field mapping
 * use `{{ ... }}` syntax outside the supported contract (literal / exact
 * `={{$json["field"]}}` / embedded `{{$json["field"]}}`). A node with no
 * such parameters, or with only supported syntax, always passes.
 */
export function validateSupportedTemplateSyntax(nodes: unknown[]): TemplateExpressionValidation {
  for (const raw of Array.isArray(nodes) ? nodes : []) {
    if (!raw || typeof raw !== 'object') continue;
    const node = raw as Record<string, unknown>;
    const name = String(node.name ?? node.id ?? '').trim();

    for (const { key, value } of collectTemplateStrings(node)) {
      if (hasUnsupportedTemplateSyntax(value)) {
        return {
          ok: false,
          node: name,
          reason:
            `Node "${name}" parameter "${key}" uses unsupported template syntax: ${JSON.stringify(value)}. ` +
            'Only a literal value, an exact ={{$json["field"]}} expression, or one or more {{$json["field"]}} ' +
            'references embedded inside a string are supported -- no arithmetic, function calls, pipes, or ' +
            'general expression syntax is evaluated.',
        };
      }
    }
  }

  return { ok: true };
}

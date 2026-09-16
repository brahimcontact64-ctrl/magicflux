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

import {
  hasUnsupportedTemplateSyntax,
  hasMalformedOptionalBlockSyntax,
} from '@/lib/workflow-runtime/node-handlers/json-field-reference';

export type TemplateExpressionValidation = { ok: true } | { ok: false; reason: string; node: string };

const MESSAGE_PARAM_KEYS = ['subject', 'text', 'html', 'message', 'body'];

// Phase 9.9.9 -- message-style params (never Airtable's `fields` mapping,
// which must keep the strict-only, no-optional-blocks contract: a missing
// value there should still fail closed rather than silently write an empty
// cell) may ALSO use the new `{{?field}}...{{/field}}` optional-block
// primitive from json-field-reference.ts. This strips well-formed blocks
// down to their inner content first (so a normal `{{$json["field"]}}`
// reference inside a block is still checked exactly like anywhere else),
// then re-uses the exact same strict check every other param already goes
// through. A malformed block (unpaired open/close, mismatched field names)
// is rejected outright -- it can never resolve at runtime and would
// otherwise leak literal `{{?...}}`/`{{/...}}` text into a real message.
function hasUnsupportedNotificationTemplateSyntax(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  if (hasMalformedOptionalBlockSyntax(raw)) return true;
  const withoutOptionalBlocks = raw
    .replace(/^[ \t]*\{\{\?([a-zA-Z0-9_]+)\}\}([\s\S]*?)\{\{\/\1\}\}[ \t]*\r?\n/gm, '$2\n')
    .replace(/\{\{\?([a-zA-Z0-9_]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, '$2');
  return hasUnsupportedTemplateSyntax(withoutOptionalBlocks);
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function collectTemplateStrings(node: Record<string, unknown>): Array<{ key: string; value: string; isMessageParam: boolean }> {
  const params = asRecord(node.parameters);
  const found: Array<{ key: string; value: string; isMessageParam: boolean }> = [];

  for (const key of MESSAGE_PARAM_KEYS) {
    const val = params[key];
    if (typeof val === 'string') found.push({ key, value: val, isMessageParam: true });
  }

  // Airtable's `fields` mapping deliberately keeps the strict-only contract
  // -- see hasUnsupportedNotificationTemplateSyntax()'s doc comment above --
  // never the notification-only optional-block primitive.
  const fields = asRecord(params.fields);
  for (const [fieldKey, val] of Object.entries(fields)) {
    if (typeof val === 'string') found.push({ key: `fields.${fieldKey}`, value: val, isMessageParam: false });
  }

  return found;
}

/**
 * Rejects any node whose message-style parameters or Airtable field mapping
 * use `{{ ... }}` syntax outside the supported contract (literal / exact
 * `={{$json["field"]}}` / embedded `{{$json["field"]}}`, or -- for
 * message-style params only -- a well-formed `{{?field}}...{{/field}}`
 * optional block). A node with no such parameters, or with only supported
 * syntax, always passes.
 */
export function validateSupportedTemplateSyntax(nodes: unknown[]): TemplateExpressionValidation {
  for (const raw of Array.isArray(nodes) ? nodes : []) {
    if (!raw || typeof raw !== 'object') continue;
    const node = raw as Record<string, unknown>;
    const name = String(node.name ?? node.id ?? '').trim();

    for (const { key, value, isMessageParam } of collectTemplateStrings(node)) {
      const unsupported = isMessageParam ? hasUnsupportedNotificationTemplateSyntax(value) : hasUnsupportedTemplateSyntax(value);
      if (unsupported) {
        return {
          ok: false,
          node: name,
          reason:
            `Node "${name}" parameter "${key}" uses unsupported template syntax: ${JSON.stringify(value)}. ` +
            'Only a literal value, an exact ={{$json["field"]}} expression, one or more {{$json["field"]}} ' +
            'references embedded inside a string' +
            (isMessageParam ? ', or a well-formed {{?field}}...{{/field}} optional block' : '') +
            ' are supported -- no arithmetic, function calls, pipes, or general expression syntax is evaluated.',
        };
      }
    }
  }

  return { ok: true };
}

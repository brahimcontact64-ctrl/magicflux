/**
 * Single source of truth for "can the certified native runtime actually
 * execute this node, safely, in production" — Phase 9.1.6.
 *
 * Consumed by:
 *   - lib/planner (must never GENERATE an unsupported/unsafe node)
 *   - lib/workflow-validator (must REJECT one if present — old/imported
 *     workflows, hand-edited JSON, or a future planner regression)
 *   - lib/workflow-runtime/node-handlers (dispatch agrees with this list)
 *   - the editor's node registry / palette (must not offer one as if it
 *     were functional)
 *
 * Two independent problems are covered here, and they are NOT the same
 * check:
 *
 *   1. "Unknown type" — pickHandler() in node-handlers/index.ts has no
 *      allowlist entry AND no generic substring match for this type, so it
 *      falls through to the UNSUPPORTED_NODE_TYPE fallback (clean failure
 *      in live mode, simulated in test mode). This is the PROVIDER_EXACT_TYPES
 *      / GENERIC_HANDLER_SUBSTRINGS data moved here (previously duplicated
 *      privately inside lib/workflow-validator) so every caller reads the
 *      same list instead of four independently-hand-synced copies.
 *
 *   2. "Known type, unsafe anyway" — a small, explicit BLOCKLIST for types
 *      (or type+parameter combinations) that DO reach a real dispatch path
 *      via the generic substring rules above, but where that path does not
 *      do the thing the node claims to do:
 *        - n8n-nodes-base.errorTrigger matches the generic 'trigger'
 *          substring and dispatches to webhookHandler (a passthrough), but
 *          nothing anywhere in the runtime ever fires because a workflow
 *          this node monitors failed — it is a silent no-op, not error
 *          handling.
 *        - n8n-nodes-base.gmailTrigger is explicitly routed to emailHandler
 *          (send-only — no Gmail-watching/polling exists anywhere). Worse:
 *          every node with no incoming edges is queued as a start node on
 *          EVERY execution of its workflow (see runtime/workflow-engine.ts
 *          findStartNodes()), so a workflow combining a real trigger with a
 *          gmailTrigger node would dispatch emailHandler with whatever
 *          garbage parameters sit on that node on every real run — a real
 *          live side effect, not a harmless no-op.
 *        - n8n-nodes-base.wait with parameters.resume === 'webhook' (the
 *          "Approval Step" block) is n8n's own resume-webhook mechanism.
 *          waitHandler (lib/workflow-runtime/node-handlers/wait.ts) only
 *          understands date/duration waits; resume:'webhook' matches none
 *          of its recognized parameter keys, so it silently falls through
 *          to "no wait time specified — continuing" and the workflow
 *          proceeds immediately, as if already approved. This is the most
 *          dangerous case found in this audit: a human approval gate that
 *          silently never gates anything.
 *        - n8n-nodes-base.googleDrive / googleDriveTrigger: the handler
 *          (googledrive.ts) already fails cleanly and honestly in live mode
 *          — that part is correct — but it is still user-addable from the
 *          editor's NodePalette as if it were a working action. Blocked
 *          here so generation/activation/editor all agree it isn't ready,
 *          on top of the handler's own honest live-mode failure.
 */

// ─── Layer 1: known-dispatchable types (moved from lib/workflow-validator,
//     kept in exact sync with pickHandler() in
//     lib/workflow-runtime/node-handlers/index.ts) ────────────────────────

export type NodeCapabilityResult =
  | { capable: true }
  | { capable: false; reason: string; userMessage: string };

/** Exact lowercase type strings that route to a credential-using provider handler. */
export const PROVIDER_EXACT_TYPES: ReadonlySet<string> = new Set([
  'n8n-nodes-base.shopify',
  'n8n-nodes-base.shopifytrigger',
  'n8n-nodes-base.slack',
  'n8n-nodes-base.slacktrigger',
  'n8n-nodes-base.airtable',
  'n8n-nodes-base.airtabletrigger',
  'n8n-nodes-base.emailsend',
  'n8n-nodes-base.emailreadimap',
  'n8n-nodes-base.gmail',
  'n8n-nodes-base.gmailtrigger',
  'n8n-nodes-base.googledrive',
  'n8n-nodes-base.googledrivetrigger',
  'n8n-nodes-base.openai',
  'n8n-nodes-base.httprequest',
]);

/**
 * Exact lowercase type strings with a real, non-credential deterministic
 * handler that is NOT reached via a generic substring match (so it must be
 * listed explicitly rather than relying on GENERIC_HANDLER_SUBSTRINGS).
 * Currently just 'set' (lib/workflow-runtime/node-handlers/set.ts).
 */
export const DETERMINISTIC_EXACT_TYPES: ReadonlySet<string> = new Set([
  'n8n-nodes-base.set',
]);

/** Lowercase substrings that route a type to a generic (credential-free) handler. */
export const GENERIC_HANDLER_SUBSTRINGS: ReadonlyArray<string> = [
  'webhook', 'trigger', 'manualtrigger',
  'code', 'function',
  'wait', 'pause', 'delay',
  'if', 'condition', 'switch', 'filter',
];

/**
 * Returns true when pickHandler() will route this type to something other
 * than the UNSUPPORTED_NODE_TYPE fallback. Does NOT mean the node is safe
 * to generate/activate — see the blocklist below for cases where a type is
 * "known" but still unsafe.
 */
export function isKnownNodeType(type: string): boolean {
  const lc = type.toLowerCase();
  if (PROVIDER_EXACT_TYPES.has(lc)) return true;
  if (DETERMINISTIC_EXACT_TYPES.has(lc)) return true;
  return GENERIC_HANDLER_SUBSTRINGS.some((s) => lc.includes(s));
}

// ─── Layer 2: explicit blocklist — known type, unsafe anyway ─────────────

type BlockRule = {
  /** Exact lowercase type string this rule applies to. Mutually exclusive with `substrings`. */
  type?: string;
  /**
   * Lowercase substrings; the rule applies if the node's type contains ANY
   * of these (case-insensitive). Mutually exclusive with `type`. Use this
   * form when a whole class of types shares one disabled handler via
   * pickHandler()'s own generic substring routing (node-handlers/index.ts)
   * — e.g. 'code'/'function' below — so the block is provably as broad as
   * the routing it's blocking, not a guessed/partial alias list.
   */
  substrings?: string[];
  /**
   * Optional parameter-level check. If present, the rule only applies when
   * this returns true for the node's `parameters`. Absent = applies to
   * every node this rule's type/substrings match, regardless of parameters.
   */
  matchesParameters?: (parameters: Record<string, unknown>) => boolean;
  /** Internal diagnostic reason (safe for logs, not necessarily for end users). */
  reason: string;
  /** Short, human, non-technical explanation safe to show a normal user. */
  userMessage: string;
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

const BLOCKLIST: ReadonlyArray<BlockRule> = [
  {
    type: 'n8n-nodes-base.errortrigger',
    reason: 'errorTrigger dispatches to webhookHandler (passthrough) via generic trigger routing, but nothing in the runtime ever fires it on another workflow\'s failure — it is a silent no-op, not error handling.',
    userMessage: 'Error-catching steps aren\'t available yet.',
  },
  {
    type: 'n8n-nodes-base.gmailtrigger',
    reason: 'No Gmail-watching/polling mechanism exists anywhere in the runtime. Worse: every no-incoming-edge node is queued as a start node on every execution (findStartNodes()), so a gmailTrigger node co-existing with a real trigger would run emailHandler (send-only) with whatever garbage parameters sit on it, on every real run.',
    userMessage: 'Watching Gmail for new messages isn\'t available yet — only sending email is supported right now.',
  },
  {
    type: 'n8n-nodes-base.googlesheets',
    reason: 'No handler in HANDLER_NODE_ALLOWLIST and no entry in PROVIDER_NODE_ALLOWLIST (lib/integrations.ts) — falls through to UNSUPPORTED_NODE_TYPE, and the UI never even flags it as needing a connection.',
    userMessage: 'Google Sheets isn\'t connected yet.',
  },
  {
    type: 'n8n-nodes-base.hubspot',
    reason: 'No handler, no credential registry entry — falls through to UNSUPPORTED_NODE_TYPE.',
    userMessage: 'HubSpot isn\'t connected yet.',
  },
  {
    type: 'n8n-nodes-base.twilio',
    reason: 'No handler, no credential registry entry — falls through to UNSUPPORTED_NODE_TYPE.',
    userMessage: 'SMS via Twilio isn\'t connected yet.',
  },
  {
    type: 'n8n-nodes-base.googledrive',
    reason: 'Handler is a known, honest stub (fails cleanly in live mode) but is still offered in the editor palette as if functional — blocked so planner/validator/editor agree with the handler\'s own admission.',
    userMessage: 'Google Drive isn\'t connected yet.',
  },
  {
    type: 'n8n-nodes-base.googledrivetrigger',
    reason: 'Same as googledrive, and additionally no watch/poll mechanism exists for it to ever fire.',
    userMessage: 'Watching Google Drive for changes isn\'t available yet.',
  },
  {
    type: 'n8n-nodes-base.wait',
    matchesParameters: (params) => String(params.resume ?? '').toLowerCase() === 'webhook',
    reason: 'waitHandler only understands date/duration waits; resume:"webhook" (the Approval Step block\'s n8n resume-webhook mechanism) matches none of its recognized keys, so it silently falls through to "no wait time specified — continuing" and the workflow proceeds immediately, as if already approved.',
    userMessage: 'Approval steps that pause for a person to respond aren\'t available yet — this step would not actually wait.',
  },
  {
    // Phase 9.5.1A — traced Blocks -> planner assembly -> node type ->
    // handler routing exactly, not guessed:
    //   lib/blocks/index.ts's `code_transform` block is the only Blocks-
    //   layer abstraction that emits a code-executing n8nType; its
    //   buildN8nNode() hardcodes n8nType: 'n8n-nodes-base.code'.
    //   pickHandler() (node-handlers/index.ts) routes ANY type containing
    //   the substring "code" OR "function" to codeHandler — not just
    //   n8n-nodes-base.code — so a hand-edited/imported workflow, or a
    //   legacy n8n export using the historical "Function"/"Function Item"
    //   node ('n8n-nodes-base.function' / 'n8n-nodes-base.functionItem'),
    //   reaches the exact same disabled handler. This rule uses the same
    //   substring predicate as that routing, so it is provably as broad as
    //   what it blocks — not a partial alias list that could drift.
    //   codeHandler (node-handlers/code.ts) permanently refuses to execute
    //   in live mode by product policy (Phase 9.5.1A: arbitrary JavaScript
    //   execution is not offered in V1, and is not safely sandboxable —
    //   see that file's own comment on vm.runInNewContext() not being a
    //   security boundary). This BLOCKLIST entry is the single authoritative
    //   place that fact is now recorded; CODE_NODES_DISABLED_LIVE_MODE in
    //   code.ts remains the runtime's own final defense-in-depth and is
    //   deliberately not removed.
    substrings: ['code', 'function'],
    reason: 'Matches pickHandler()\'s own "code"/"function" substring routing to codeHandler (node-handlers/code.ts), which is permanently disabled in live mode by product policy — arbitrary JavaScript execution is not offered in V1 and is not safely sandboxable.',
    userMessage: 'Custom code execution isn\'t available yet.',
  },
];

/**
 * The one function every caller (planner, validator, editor, and — via the
 * mirrored dispatch data above — the runtime itself) should use to decide
 * whether a node is safe to generate, keep, edit as functional, or activate.
 */
export function checkNodeCapability(node: { type: string; parameters?: unknown }): NodeCapabilityResult {
  const lc = String(node.type ?? '').toLowerCase();
  const parameters = asRecord(node.parameters);

  for (const rule of BLOCKLIST) {
    const typeMatches = rule.type !== undefined
      ? rule.type === lc
      : rule.substrings !== undefined
        ? rule.substrings.some((s) => lc.includes(s))
        : false;
    if (!typeMatches) continue;
    if (rule.matchesParameters && !rule.matchesParameters(parameters)) continue;
    return { capable: false, reason: rule.reason, userMessage: rule.userMessage };
  }

  if (!isKnownNodeType(lc)) {
    return {
      capable: false,
      reason: `No handler in HANDLER_NODE_ALLOWLIST and no generic-substring match for type "${node.type}" — would fail with UNSUPPORTED_NODE_TYPE in live mode.`,
      userMessage: 'This step type isn\'t available yet.',
    };
  }

  return { capable: true };
}

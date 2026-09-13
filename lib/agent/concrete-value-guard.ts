/**
 * Phase 9.8.7 -- deterministic, fail-closed guard against the AI generator
 * silently substituting placeholder text for a concrete value the user
 * actually provided (e.g. "Send an email now to nssmpro@gmail.com..."
 * generating parameters.to = "recipient@example.com"). The root cause was
 * upstream (generateWorkflowJson() never received the raw user text at
 * all -- see lib/agent/executor.ts), but even with that fixed, an LLM can
 * still occasionally drop or paraphrase a literal. This is the backstop:
 * a small set of reliable, literal extraction rules, not a general
 * semantic-similarity system.
 */

export type ConcreteValueCheckResult = { ok: true } | { ok: false; reason: string };

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Known-placeholder domains/strings the generator (or a human template)
// commonly falls back to when it has no real value to put in. Narrow and
// explicit -- not a fuzzy classifier.
const PLACEHOLDER_EMAIL_DOMAINS = ['example.com', 'example.org', 'example.net', 'yourdomain.com'];
const PLACEHOLDER_SUBJECTS = new Set(['your subject here', 'subject here', 'email subject', 'subject']);
const PLACEHOLDER_BODIES = new Set([
  'your message content here.',
  'your message content here',
  'email body content…',
  'email body content...',
  'automated message from magicflux.',
]);

function isPlaceholderEmail(value: string): boolean {
  const lc = value.trim().toLowerCase();
  if (!lc) return true;
  return PLACEHOLDER_EMAIL_DOMAINS.some((domain) => lc.endsWith(`@${domain}`));
}

function isPlaceholderText(value: string, knownSet: Set<string>): boolean {
  const lc = value.trim().toLowerCase();
  if (!lc) return true;
  if (knownSet.has(lc)) return true;
  // Generic "Your X Here" / "X here" template shape.
  return /^your .+ here\.?$/i.test(lc) || /^\[.+\]$/.test(lc);
}

/** Extracts the first quoted string following `keyword` within a short window, tolerating straight and curly quotes. */
function extractQuotedAfter(text: string, keyword: string): string | null {
  const re = new RegExp(`${keyword}[^"'“‘]{0,20}["'“‘]([^"'”’]+)["'”’]`, 'i');
  const match = text.match(re);
  return match ? match[1].trim() : null;
}

/** True when the raw text plausibly states an explicit subject/message for this keyword, even without extracting the exact text (covers phrasing extractQuotedAfter's narrower quote-matching might miss). */
function mentionsExplicitField(text: string, keyword: string): boolean {
  return new RegExp(`\\b${keyword}\\b`, 'i').test(text);
}

type EmailNodeLike = { type?: unknown; parameters?: Record<string, unknown> };

function findEmailNode(nodes: unknown[]): EmailNodeLike | undefined {
  return nodes.find((n) => {
    const type = String((n as EmailNodeLike)?.type ?? '').toLowerCase();
    return type === 'n8n-nodes-base.gmail' || type === 'n8n-nodes-base.emailsend';
  }) as EmailNodeLike | undefined;
}

/**
 * Checks that concrete literals present in the user's raw request survived
 * into the generated Email/Gmail node. Returns { ok: true } for any
 * workflow with no email node, or when the user's request contained no
 * extractable concrete email/subject/message literal to check against
 * (nothing to enforce). Never mutates its inputs.
 */
export function checkConcreteValuesPreserved(rawUserIntent: string, nodes: unknown[]): ConcreteValueCheckResult {
  if (!rawUserIntent || !Array.isArray(nodes) || nodes.length === 0) return { ok: true };

  const emailNode = findEmailNode(nodes);
  if (!emailNode) return { ok: true };

  const params = emailNode.parameters ?? {};
  const generatedTo = String(params.to ?? '').trim();
  const generatedSubject = String(params.subject ?? '').trim();
  const generatedBody = String(params.message ?? params.text ?? params.html ?? '').trim();

  // Recipient: exact-match enforced -- a wrong address is a real misdelivery,
  // not a cosmetic difference, so this is the one field checked for equality
  // rather than mere non-placeholder presence.
  const candidateEmails = rawUserIntent.match(EMAIL_REGEX) ?? [];
  const userRealEmail = candidateEmails.find((e) => !isPlaceholderEmail(e));
  if (userRealEmail) {
    if (!generatedTo || isPlaceholderEmail(generatedTo) || generatedTo.toLowerCase() !== userRealEmail.toLowerCase()) {
      return {
        ok: false,
        reason: `The request specified recipient "${userRealEmail}", but the generated Email node has "${generatedTo || '(empty)'}" instead.`,
      };
    }
  }

  // Subject/body: the user explicitly supplied one (detected via a quoted
  // literal, or the bare word "subject"/"message" appearing in the
  // request) -- the generated field must be non-empty and non-placeholder.
  // Not compared for exact equality: free-text extraction of the user's
  // exact intended wording is not reliable enough to enforce byte-identity
  // without risking false rejections, and the requirement is "don't silently
  // drop it to a placeholder," not "reproduce it character-for-character."
  const userSubject = extractQuotedAfter(rawUserIntent, 'subject');
  if (userSubject || mentionsExplicitField(rawUserIntent, 'subject')) {
    if (!generatedSubject || isPlaceholderText(generatedSubject, PLACEHOLDER_SUBJECTS)) {
      return {
        ok: false,
        reason: 'The request specified an explicit subject, but the generated Email node has no real subject (empty or placeholder).',
      };
    }
  }

  const userMessage = extractQuotedAfter(rawUserIntent, 'message') ?? extractQuotedAfter(rawUserIntent, 'body');
  if (userMessage || mentionsExplicitField(rawUserIntent, 'message') || mentionsExplicitField(rawUserIntent, 'body')) {
    if (!generatedBody || isPlaceholderText(generatedBody, PLACEHOLDER_BODIES)) {
      return {
        ok: false,
        reason: 'The request specified an explicit message/body, but the generated Email node has no real body (empty or placeholder).',
      };
    }
  }

  return { ok: true };
}

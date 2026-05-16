import { createHmac, timingSafeEqual, createHash } from 'crypto';

import { createServiceClient } from '@/lib/supabase-server';

type WebhookGuardInput = {
  workflowId: string;
  userId: string;
  rawBody: string;
  signature: string | null;
  timestamp: string | null;
  nonce: string | null;
  ipAddress: string | null;
  secret: string | null;
  allowedIps?: string[];
};

export type WebhookGuardResult = {
  allowed: boolean;
  reason?: string;
  suspiciousScore: number;
  requestHash: string;
};

const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

function nowIso(): string {
  return new Date().toISOString();
}

function hashBody(rawBody: string): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

function parseSignature(signature: string): string {
  if (signature.startsWith('sha256=')) {
    return signature.slice('sha256='.length);
  }
  return signature;
}

function safeCompareHex(aHex: string, bHex: string): boolean {
  try {
    const a = Buffer.from(aHex, 'hex');
    const b = Buffer.from(bHex, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function isIpAllowed(ipAddress: string | null, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  if (!ipAddress) return false;
  return allowlist.some((allowed) => ipAddress === allowed || ipAddress.startsWith(`${allowed}.`));
}

async function checkRateLimit(params: {
  workflowId: string;
  ipAddress: string | null;
  maxPerMinute: number;
}): Promise<boolean> {
  const db = createServiceClient();
  const since = new Date(Date.now() - 60 * 1000).toISOString();
  let query = db
    .from('runtime_webhook_request_log')
    .select('*', { count: 'exact', head: true })
    .eq('workflow_id', params.workflowId)
    .gte('created_at', since);

  if (params.ipAddress) {
    query = query.eq('ip_address', params.ipAddress);
  }

  const { count } = await query;
  return Number(count ?? 0) < params.maxPerMinute;
}

async function markNonce(params: {
  workflowId: string;
  nonce: string;
  requestHash: string;
}): Promise<{ ok: boolean; replayed: boolean }> {
  const db = createServiceClient();
  const expiresAt = new Date(Date.now() + MAX_TIMESTAMP_SKEW_MS).toISOString();

  const { error } = await db.from('runtime_webhook_nonces').insert({
    workflow_id: params.workflowId,
    nonce: params.nonce,
    request_hash: params.requestHash,
    expires_at: expiresAt,
    created_at: nowIso(),
  });

  if (!error) return { ok: true, replayed: false };

  if (error.code === '23505') {
    return { ok: false, replayed: true };
  }

  return { ok: false, replayed: false };
}

export function suspiciousExecutionScore(inputData: Record<string, unknown>): number {
  const joined = JSON.stringify(inputData).toLowerCase();
  let score = 0;

  const highRiskSignals = [
    'ignore previous instructions',
    'developer mode',
    'system prompt',
    'exfiltrate',
    'bypass',
    'override safety',
    'execute shell',
    'api key',
    'secret',
  ];

  for (const signal of highRiskSignals) {
    if (joined.includes(signal)) score += 15;
  }

  if (joined.length > 25000) score += 10;
  return Math.min(100, score);
}

export async function guardWebhookRequest(input: WebhookGuardInput): Promise<WebhookGuardResult> {
  const db = createServiceClient();
  const requestHash = hashBody(input.rawBody || '');

  const bad = async (reason: string, suspiciousScore: number, signatureValid = false) => {
    await db.from('runtime_webhook_request_log').insert({
      workflow_id: input.workflowId,
      user_id: input.userId,
      ip_address: input.ipAddress,
      signature_valid: signatureValid,
      blocked: true,
      block_reason: reason,
      request_hash: requestHash,
      suspicious_score: suspiciousScore,
      created_at: nowIso(),
    });

    if (suspiciousScore >= 60 || reason.includes('replay')) {
      await db.from('runtime_security_alerts').insert({
        user_id: input.userId,
        workflow_id: input.workflowId,
        alert_type: reason.includes('replay') ? 'webhook_replay' : 'unsafe_execution',
        severity: suspiciousScore >= 80 ? 'critical' : 'warning',
        score: suspiciousScore,
        details: { reason, ipAddress: input.ipAddress },
        created_at: nowIso(),
      });
    }

    return {
      allowed: false,
      reason,
      suspiciousScore,
      requestHash,
    } satisfies WebhookGuardResult;
  };

  if (!isIpAllowed(input.ipAddress, input.allowedIps ?? [])) {
    return bad('IP_NOT_ALLOWED', 40);
  }

  const rateLimitOk = await checkRateLimit({
    workflowId: input.workflowId,
    ipAddress: input.ipAddress,
    maxPerMinute: 60,
  });

  if (!rateLimitOk) {
    return bad('RATE_LIMIT_EXCEEDED', 55);
  }

  if (input.secret) {
    if (!input.signature || !input.timestamp || !input.nonce) {
      return bad('MISSING_SIGNATURE_HEADERS', 70);
    }

    const ts = Number(input.timestamp);
    if (!Number.isFinite(ts)) {
      return bad('INVALID_TIMESTAMP', 70);
    }

    const skew = Math.abs(Date.now() - ts * 1000);
    if (skew > MAX_TIMESTAMP_SKEW_MS) {
      return bad('TIMESTAMP_OUT_OF_WINDOW', 75);
    }

    const canonical = `${input.timestamp}.${input.nonce}.${input.rawBody}`;
    const expected = createHmac('sha256', input.secret).update(canonical).digest('hex');
    const provided = parseSignature(input.signature);
    const signatureValid = safeCompareHex(expected, provided);

    if (!signatureValid) {
      return bad('INVALID_SIGNATURE', 85);
    }

    const nonceResult = await markNonce({
      workflowId: input.workflowId,
      nonce: input.nonce,
      requestHash,
    });

    if (!nonceResult.ok && nonceResult.replayed) {
      return bad('REPLAY_ATTACK_DETECTED', 95, true);
    }
  }

  await db.from('runtime_webhook_request_log').insert({
    workflow_id: input.workflowId,
    user_id: input.userId,
    ip_address: input.ipAddress,
    signature_valid: Boolean(input.secret),
    blocked: false,
    request_hash: requestHash,
    suspicious_score: 0,
    created_at: nowIso(),
  });

  return {
    allowed: true,
    suspiciousScore: 0,
    requestHash,
  };
}

import 'server-only';

import { createServiceClient } from '@/lib/supabase-server';

export type AlertConditionType =
  | 'queue_overload'
  | 'worker_crash'
  | 'incident_explosion'
  | 'replay_corruption'
  | 'sla_violation';

export type AlertChannel = 'dashboard' | 'email' | 'webhook' | 'slack' | 'telegram';

export type AlertChannelConfig = {
  email?:             string;
  webhook_url?:       string;
  slack_webhook?:     string;
  telegram_bot_token?: string;
  telegram_chat_id?:  string;
};

export type AlertRule = {
  id:             string;
  name:           string;
  condition_type: AlertConditionType;
  threshold:      number;
  window_minutes: number;
  severity:       string;
  channels:       AlertChannel[];
  channel_config: AlertChannelConfig;
  is_active:      boolean;
  created_by:     string | null;
  created_at:     string;
  updated_at:     string;
};

export type AlertFiring = {
  id:            string;
  rule_id:       string;
  fired_at:      string;
  resolved_at:   string | null;
  payload:       Record<string, unknown>;
  channels_sent: AlertChannel[];
};

export async function listAlertRules(): Promise<AlertRule[]> {
  const db = createServiceClient();
  const { data } = await db
    .from('runtime_alert_rules')
    .select('*')
    .order('created_at', { ascending: false });

  return (data ?? []) as AlertRule[];
}

export async function getAlertRule(id: string): Promise<AlertRule | null> {
  const db = createServiceClient();
  const { data } = await db
    .from('runtime_alert_rules')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  return data as AlertRule | null;
}

export async function createAlertRule(params: {
  name:           string;
  conditionType:  AlertConditionType;
  threshold:      number;
  windowMinutes:  number;
  severity:       string;
  channels:       AlertChannel[];
  channelConfig:  AlertChannelConfig;
  createdBy:      string;
}): Promise<AlertRule> {
  const db = createServiceClient();
  const now = new Date().toISOString();

  const { data, error } = await db
    .from('runtime_alert_rules')
    .insert({
      name:           params.name,
      condition_type: params.conditionType,
      threshold:      params.threshold,
      window_minutes: params.windowMinutes,
      severity:       params.severity,
      channels:       params.channels,
      channel_config: params.channelConfig,
      is_active:      true,
      created_by:     params.createdBy,
      created_at:     now,
      updated_at:     now,
    })
    .select()
    .single();

  if (error || !data) throw new Error(`Failed to create alert rule: ${error?.message}`);
  return data as AlertRule;
}

export async function updateAlertRule(
  id: string,
  patch: Partial<Pick<AlertRule,
    'name' | 'threshold' | 'window_minutes' | 'severity' |
    'channels' | 'channel_config' | 'is_active'
  >>
): Promise<boolean> {
  const db = createServiceClient();
  const { error } = await db
    .from('runtime_alert_rules')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id);

  return !error;
}

export async function deleteAlertRule(id: string): Promise<boolean> {
  const db = createServiceClient();
  const { error } = await db
    .from('runtime_alert_rules')
    .delete()
    .eq('id', id);

  return !error;
}

export async function getRecentFirings(params?: {
  ruleId?: string;
  limit?:  number;
}): Promise<AlertFiring[]> {
  const db = createServiceClient();
  const limit = Math.min(params?.limit ?? 100, 500);

  let query = db
    .from('runtime_alert_firings')
    .select('*')
    .order('fired_at', { ascending: false })
    .limit(limit);

  if (params?.ruleId) {
    query = query.eq('rule_id', params.ruleId);
  }

  const { data } = await query;
  return (data ?? []) as AlertFiring[];
}

async function recordFiring(params: {
  ruleId:       string;
  payload:      Record<string, unknown>;
  channelsSent: AlertChannel[];
}): Promise<string> {
  const db = createServiceClient();
  const { data } = await db
    .from('runtime_alert_firings')
    .insert({
      rule_id:       params.ruleId,
      payload:       params.payload,
      channels_sent: params.channelsSent,
    })
    .select('id')
    .single();

  return data?.id ?? '';
}

async function deliverToEmail(
  toAddress: string,
  subject:   string,
  body:      string
): Promise<void> {
  const nodemailer = await import('nodemailer');
  const transporter = nodemailer.default.createTransport({
    host:   process.env.SMTP_HOST    ?? 'localhost',
    port:   Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth:   process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? '' }
      : undefined,
  });

  await transporter.sendMail({
    from:    process.env.SMTP_FROM ?? 'alerts@magicflux.io',
    to:      toAddress,
    subject,
    text:    body,
  });
}

const DELIVERY_TIMEOUT_MS = 10_000;

async function deliverToWebhook(
  webhookUrl: string,
  payload:    Record<string, unknown>
): Promise<void> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const res = await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  abort.signal,
    });
    if (!res.ok) throw new Error(`Webhook delivery failed: HTTP ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}

async function deliverToSlack(webhookUrl: string, text: string): Promise<void> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const res = await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text }),
      signal:  abort.signal,
    });
    if (!res.ok) throw new Error(`Slack delivery failed: HTTP ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}

async function deliverToTelegram(
  botToken: string,
  chatId:   string,
  text:     string
): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      signal:  abort.signal,
    });
    if (!res.ok) throw new Error(`Telegram delivery failed: HTTP ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function fireAlert(
  rule:    AlertRule,
  payload: Record<string, unknown>
): Promise<string> {
  const subject = `[${rule.severity.toUpperCase()}] MagicFlux Alert: ${rule.name}`;
  const body    = `${rule.name}\n\nCondition: ${rule.condition_type}\nSeverity: ${rule.severity}\nDetails: ${JSON.stringify(payload, null, 2)}`;
  const channelsSent: AlertChannel[] = [];

  for (const channel of rule.channels) {
    try {
      if (channel === 'dashboard') {
        channelsSent.push('dashboard');
      } else if (channel === 'email' && rule.channel_config.email) {
        await deliverToEmail(rule.channel_config.email, subject, body);
        channelsSent.push('email');
      } else if (channel === 'webhook' && rule.channel_config.webhook_url) {
        await deliverToWebhook(rule.channel_config.webhook_url, { rule, payload, firedAt: new Date().toISOString() });
        channelsSent.push('webhook');
      } else if (channel === 'slack' && rule.channel_config.slack_webhook) {
        await deliverToSlack(rule.channel_config.slack_webhook, `*${subject}*\n${body}`);
        channelsSent.push('slack');
      } else if (
        channel === 'telegram' &&
        rule.channel_config.telegram_bot_token &&
        rule.channel_config.telegram_chat_id
      ) {
        await deliverToTelegram(
          rule.channel_config.telegram_bot_token,
          rule.channel_config.telegram_chat_id,
          `<b>${subject}</b>\n${body}`
        );
        channelsSent.push('telegram');
      }
    } catch {
      // Delivery failure is non-fatal; continue with other channels.
    }
  }

  return recordFiring({ ruleId: rule.id, payload, channelsSent });
}

// Returns the most recent firing timestamp for each rule_id among the given IDs.
async function getLastFiringTimes(
  db:      ReturnType<typeof createServiceClient>,
  ruleIds: string[]
): Promise<Map<string, number>> {
  if (ruleIds.length === 0) return new Map();

  const { data } = await db
    .from('runtime_alert_firings')
    .select('rule_id, fired_at')
    .in('rule_id', ruleIds)
    .order('fired_at', { ascending: false })
    .limit(ruleIds.length * 2);

  const map = new Map<string, number>();
  for (const row of data ?? []) {
    const rid = String(row.rule_id);
    if (!map.has(rid)) {
      map.set(rid, new Date(String(row.fired_at)).getTime());
    }
  }
  return map;
}

export async function evaluateAlertRules(): Promise<number> {
  const db = createServiceClient();
  const staleWorkerCutoff = new Date(Date.now() - 90_000).toISOString();

  const [rules, crashedWorkersRes, pendingCommandsRes, recentIncidentsRes, slaViolationsRes] =
    await Promise.all([
      listAlertRules().then(rs => rs.filter(r => r.is_active)),
      db
        .from('runtime_workers')
        .select('worker_id', { count: 'exact', head: true })
        .eq('status', 'crashed')
        .gte('heartbeat_at', staleWorkerCutoff),
      db
        .from('runtime_execution_commands')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending'),
      db
        .from('runtime_incidents')
        .select('id', { count: 'exact', head: true })
        .in('status', ['open', 'investigating']),
      db
        .from('runtime_sla_violations')
        .select('id', { count: 'exact', head: true })
        .gte('recorded_at', new Date(Date.now() - 10 * 60_000).toISOString()),
    ]);

  const crashedWorkers  = Number(crashedWorkersRes.count  ?? 0);
  const pendingCommands = Number(pendingCommandsRes.count  ?? 0);
  const openIncidents   = Number(recentIncidentsRes.count  ?? 0);
  const slaViolations   = Number(slaViolationsRes.count    ?? 0);

  const activeRules = rules as AlertRule[];

  // Load last firing times for all active rules to enforce per-rule cooldown.
  const lastFired = await getLastFiringTimes(db, activeRules.map(r => r.id));

  let firedCount = 0;

  for (const rule of activeRules) {
    // Cooldown: skip if this rule already fired within its evaluation window.
    const cooldownMs   = rule.window_minutes * 60_000;
    const lastFiredAt  = lastFired.get(rule.id) ?? 0;
    if (Date.now() - lastFiredAt < cooldownMs) continue;

    let currentValue = 0;
    let shouldFire   = false;

    switch (rule.condition_type) {
      case 'queue_overload':
        currentValue = pendingCommands;
        shouldFire   = currentValue >= rule.threshold;
        break;
      case 'worker_crash':
        currentValue = crashedWorkers;
        shouldFire   = currentValue >= rule.threshold;
        break;
      case 'incident_explosion':
        currentValue = openIncidents;
        shouldFire   = currentValue >= rule.threshold;
        break;
      case 'sla_violation':
        currentValue = slaViolations;
        shouldFire   = currentValue >= rule.threshold;
        break;
      case 'replay_corruption': {
        // Check replay integrity via recent failed executions
        const since = new Date(Date.now() - rule.window_minutes * 60_000).toISOString();
        const { count } = await db
          .from('workflow_executions_v2')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'failed')
          .gte('completed_at', since);
        currentValue = Number(count ?? 0);
        shouldFire   = currentValue >= rule.threshold;
        break;
      }
    }

    if (shouldFire) {
      await fireAlert(rule, { current_value: currentValue, threshold: rule.threshold, condition_type: rule.condition_type }).catch(() => undefined);
      firedCount++;
    }
  }

  return firedCount;
}

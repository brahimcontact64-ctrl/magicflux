/**
 * Billing System: Plan Limits Helper
 * Handles all plan-based restrictions and usage tracking
 */

import { createServiceClient } from '@/lib/supabase-server';
import { getMonthlyAiTokenUsage } from '@/lib/runtime/usage-metering';

export type PlanSlug = "free" | "pro" | "business";
export type SubscriptionStatus = "active" | "inactive" | "trialing" | "past_due" | "canceled";

export interface Plan {
  id: string;
  slug: PlanSlug;
  name: string;
  price_monthly: number;
  integrations_limit: number; // -1 = unlimited
  workflows_limit: number; // -1 = unlimited
  executions_limit: number; // -1 = unlimited
  deploy_enabled: boolean;
  created_at: string;
}

export interface UserSubscription {
  id: string;
  user_id: string;
  plan_id: string;
  status: SubscriptionStatus;
  current_period_end: string | null;
  created_at: string;
  updated_at: string;
  plan?: Plan;
}

export interface UsageMetrics {
  connected_integrations: number;
  workflows: number;
  executions_this_month: number;
}

const FREE_DEFAULT_PLAN: Plan = {
  id: "free-default",
  slug: "free",
  name: "Free",
  price_monthly: 0,
  integrations_limit: 1,
  workflows_limit: 3,
  executions_limit: 20,
  deploy_enabled: false,
  created_at: new Date().toISOString(),
};

export type PlanResolutionSource =
  | "active_subscription" // real, active, unexpired paid (or free) plan on file
  | "no_subscription"     // no subscriptions row at all -- legitimately free
  | "inactive_subscription" // row exists but status/expiration doesn't currently entitle
  | "resolution_error";   // DB/query failure -- fell back to free, but this is NOT a normal free user

export interface PlanResolution {
  plan: Plan;
  source: PlanResolutionSource;
}

/**
 * Resolve a user's real, current plan.
 *
 * Phase 9.3.1 fix. The previous query used `plan!inner(...)` -- an alias
 * ("plan", singular) that matches neither the real FK constraint name
 * (`subscriptions_plan_id_fkey`) nor PostgREST's auto-detected relationship
 * name (the referenced table, `plans`, plural). Every call failed with
 * PGRST200 ("Could not find a relationship"), so `subError` was truthy on
 * every single invocation and this function silently returned the free
 * default for every user, always, regardless of real subscription state --
 * the entitlement gate could never recognize anyone as Pro/Business.
 *
 * This does NOT copy the client-side fetchPlan() (lib/auth-context.tsx)
 * fallback behavior of trusting the raw, unverified `subscriptions.plan`
 * text column when the relational join comes back empty -- that column can
 * drift from `plan_id`/`plans` (as the 25 dev/e2e-seeded rows in production
 * demonstrate: plan:'pro' text with plan_id NULL) and is fine for a
 * display-only badge but not for a security-sensitive entitlement decision.
 * A plan is only ever returned here if the real FK-joined `plans` row
 * resolved AND the subscription is active AND unexpired.
 */
export async function resolveUserPlan(userId: string): Promise<PlanResolution> {
  const supabase = createServiceClient();

  const { data: sub, error: subError } = await supabase
    .from("subscriptions")
    .select(
      "status, current_period_end, plan_id, plan:plans!subscriptions_plan_id_fkey(id, slug, name, price_monthly, integrations_limit, workflows_limit, executions_limit, deploy_enabled, created_at)"
    )
    .eq("user_id", userId)
    .maybeSingle();

  if (subError) {
    // Fail safe (free), but MUST be observable -- a billing resolver
    // failure must never quietly masquerade as a normal free user forever.
    // No alerting/metrics pipeline exists yet to page on this (out of
    // scope for this gate); a structured, greppable log line is the
    // proportionate signal today, and `source: "resolution_error"` lets
    // any future/observable caller (e.g. an ops dashboard) distinguish
    // this from a legitimate free account.
    console.error("[billing:resolveUserPlan:RESOLVER_FAILURE]", { userId, error: subError });
    return { plan: FREE_DEFAULT_PLAN, source: "resolution_error" };
  }

  if (!sub) {
    // No subscriptions row at all -- legitimately free, not an error.
    return { plan: FREE_DEFAULT_PLAN, source: "no_subscription" };
  }

  const planRow = (sub.plan as unknown as Plan | null) ?? null;

  // Malformed/dangling subscription (e.g. plan_id set but the joined plan
  // row can't be found, or plan_id is NULL as on the legacy dev/e2e rows)
  // -- fail safe to free rather than trusting anything else on the row.
  if (!planRow) {
    return { plan: FREE_DEFAULT_PLAN, source: "inactive_subscription" };
  }

  // Server-side subscription-status semantics (Phase 9.3.1 Step D).
  // Only "active" currently entitles. "trialing" is not yet a real product
  // concept anywhere in the app (no trial-granting code path exists) so it
  // is deliberately NOT treated as entitling here -- inventing that
  // behavior ahead of an actual trial feature would be exactly the kind of
  // premature Stripe-shaped guess this phase says not to make.
  // "past_due" / "canceled" / "unpaid" all correctly fall through to free.
  if (sub.status !== "active") {
    return { plan: FREE_DEFAULT_PLAN, source: "inactive_subscription" };
  }

  // Expiration: current_period_end in the past means entitlement has
  // lapsed even if status hasn't been transitioned yet (no webhook exists
  // yet to do that transition -- see Phase 9.3 audit). A NULL
  // current_period_end is treated as "no expiration recorded" (true today
  // for every existing row, since no code path currently sets it on the
  // canonical upgrade path) rather than auto-expiring everyone.
  if (sub.current_period_end && new Date(sub.current_period_end).getTime() <= Date.now()) {
    return { plan: FREE_DEFAULT_PLAN, source: "inactive_subscription" };
  }

  return { plan: planRow, source: "active_subscription" };
}

/**
 * Get user's current plan. Thin wrapper around resolveUserPlan() for the
 * majority of call sites that only need the plan, not the resolution
 * source. Never returns null -- always resolves to at least the free
 * default.
 */
export async function getUserPlan(userId: string): Promise<Plan> {
  return (await resolveUserPlan(userId)).plan;
}

/**
 * Get full plan details with limits
 */
export async function getPlanLimits(userId: string): Promise<Plan> {
  const plan = await getUserPlan(userId);
  return plan!;
}

/**
 * Get current integration usage count
 */
export async function getIntegrationUsage(userId: string): Promise<number> {
  const supabase = createServiceClient();

  const { count, error } = await supabase
    .from("user_integrations")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("status", "connected");

  if (error) {
    console.error("Error getting integration usage:", error);
    return 0;
  }

  return count || 0;
}

/**
 * Get current workflow usage count
 */
export async function getWorkflowUsage(userId: string): Promise<number> {
  const supabase = createServiceClient();

  const { count, error } = await supabase
    .from("workflows")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);

  if (error) {
    console.error("Error getting workflow usage:", error);
    return 0;
  }

  return count || 0;
}

/**
 * Get monthly execution usage count.
 *
 * Counts workflow_executions_v2 (the runtime engine's own execution table,
 * written for EVERY execution mode — test, live, webhook, schedule — by
 * runtime/workflow-engine.ts's initializeExecution()) rather than the legacy
 * workflow_runs table, which only the two manual "Test" routes ever insert
 * into. Before this fix, live executions (webhook triggers, live-test) never
 * counted against the monthly plan limit at all — a user could run unlimited
 * real webhook-triggered workflows while only clicking "Test" tripped quota.
 */
export async function getExecutionUsage(userId: string): Promise<number> {
  const supabase = createServiceClient();

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const { count, error } = await supabase
    .from("workflow_executions_v2")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", monthStart.toISOString());

  if (error) {
    console.error("Error getting execution usage:", error);
    return 0;
  }

  return count || 0;
}

/**
 * Get all usage metrics for a user
 */
export async function getUsageMetrics(userId: string): Promise<UsageMetrics> {
  const [integrations, workflows, executions] = await Promise.all([
    getIntegrationUsage(userId),
    getWorkflowUsage(userId),
    getExecutionUsage(userId),
  ]);

  return {
    connected_integrations: integrations,
    workflows,
    executions_this_month: executions,
  };
}

/**
 * Check if user can add a new integration
 */
export async function canAddIntegration(userId: string): Promise<{ allowed: boolean; reason?: string }> {
  const [plan, usage] = await Promise.all([getPlanLimits(userId), getIntegrationUsage(userId)]);

  if (plan.integrations_limit === -1) {
    // Unlimited
    return { allowed: true };
  }

  if (usage >= plan.integrations_limit) {
    return {
      allowed: false,
      reason: `Your ${plan.name} plan allows only ${plan.integrations_limit} integration${plan.integrations_limit !== 1 ? "s" : ""}.`,
    };
  }

  return { allowed: true };
}

/**
 * Check if user can create a new workflow
 */
export async function canCreateWorkflow(userId: string): Promise<{ allowed: boolean; reason?: string }> {
  const [plan, usage] = await Promise.all([getPlanLimits(userId), getWorkflowUsage(userId)]);

  if (plan.workflows_limit === -1) {
    // Unlimited
    return { allowed: true };
  }

  if (usage >= plan.workflows_limit) {
    return {
      allowed: false,
      reason: `Your ${plan.name} plan allows only ${plan.workflows_limit} workflow${plan.workflows_limit !== 1 ? "s" : ""}.`,
    };
  }

  return { allowed: true };
}

/**
 * Check if user can execute a workflow (monthly execution limit)
 */
export async function canExecuteWorkflow(userId: string): Promise<{ allowed: boolean; reason?: string }> {
  const [plan, usage] = await Promise.all([getPlanLimits(userId), getExecutionUsage(userId)]);

  if (plan.executions_limit === -1) {
    // Unlimited
    return { allowed: true };
  }

  if (usage >= plan.executions_limit) {
    return {
      allowed: false,
      reason: `Your ${plan.name} plan allows only ${plan.executions_limit} execution${plan.executions_limit !== 1 ? "s" : ""} per month.`,
    };
  }

  return { allowed: true };
}

/**
 * Check if user can deploy workflows
 */
export async function canDeployWorkflow(userId: string): Promise<{ allowed: boolean; reason?: string }> {
  const plan = await getPlanLimits(userId);

  if (!plan.deploy_enabled) {
    return {
      allowed: false,
      reason: `Your ${plan.name} plan does not support live workflow deployment. Upgrade to Pro or higher.`,
    };
  }

  return { allowed: true };
}

/**
 * Assert that action is allowed or throw error
 */
export async function assertPlanAllowsIntegration(userId: string): Promise<void> {
  const check = await canAddIntegration(userId);
  if (!check.allowed) {
    const error = new Error(check.reason || "Plan limit reached") as any;
    error.code = "PLAN_LIMIT_REACHED";
    error.redirect = "/pricing";
    throw error;
  }
}

/**
 * Assert that workflow creation is allowed or throw error
 */
export async function assertPlanAllowsWorkflow(userId: string): Promise<void> {
  const check = await canCreateWorkflow(userId);
  if (!check.allowed) {
    const error = new Error(check.reason || "Plan limit reached") as any;
    error.code = "PLAN_LIMIT_REACHED";
    error.redirect = "/pricing";
    throw error;
  }
}

/**
 * Assert that deploy is allowed or throw error
 */
export async function assertPlanAllowsDeploy(userId: string): Promise<void> {
  const check = await canDeployWorkflow(userId);
  if (!check.allowed) {
    const error = new Error(check.reason || "Deploy not available on this plan") as any;
    error.code = "PRO_REQUIRED";
    error.redirect = "/pricing";
    throw error;
  }
}

/**
 * Ensure user has active subscription on plan
 */
export async function ensureActiveSubscription(userId: string): Promise<UserSubscription> {
  const supabase = createServiceClient();

  let { data: sub, error } = await supabase
    .from("subscriptions")
    .select("*")
    .eq("user_id", userId)
    .single();

  // User doesn't have subscription, create free plan subscription
  if (error && error.code === "PGRST116") {
    const { data: freePlan } = await supabase.from("plans").select("id").eq("slug", "free").single();

    if (!freePlan) {
      throw new Error("Free plan not found");
    }

    const { data: newSub, error: insertError } = await supabase
      .from("subscriptions")
      .insert({
        user_id: userId,
        plan_id: freePlan.id,
        status: "active",
        current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .select()
      .single();

    if (insertError) {
      throw insertError;
    }

    return newSub as UserSubscription;
  }

  if (error) {
    throw error;
  }

  return sub as UserSubscription;
}

/**
 * Phase 8.1 quota-integration status.
 *
 * Reports every quota dimension the brief asked about against its REAL
 * source of truth, and is explicit about which dimensions are actually
 * enforced today vs. only observable:
 *
 *   - executionsMonthly: ENFORCED. getExecutionUsage() (fixed in Phase 8 to
 *     read workflow_executions_v2, not the legacy workflow_runs table)
 *     against plan.executions_limit, via canExecuteWorkflow().
 *   - activeWorkflows: ENFORCED. getWorkflowUsage() against
 *     plan.workflows_limit, via canCreateWorkflow().
 *   - concurrentExecutions: ENFORCED, but NOT through this plan-quota
 *     abstraction — lib/runtime/concurrency-guard.ts's
 *     reserve_concurrency_slot() atomically caps concurrent runs per-user
 *     and per-workflow via RUNTIME_MAX_CONCURRENT_PER_USER /
 *     RUNTIME_MAX_CONCURRENT_PER_WORKFLOW env vars. There is no per-plan
 *     concurrent-execution column on `plans` yet, so higher-tier plans
 *     cannot currently get a higher concurrency ceiling than lower tiers —
 *     documented gap, not silently faked.
 *   - aiTokensMonthly: NOT ENFORCED. getMonthlyAiTokenUsage() (real data,
 *     wired via runtime_usage_events in Phase 8.1) is exposed here so a
 *     future limit can be enforced the moment product/pricing decides on a
 *     `plans.ai_tokens_limit` column and a value — no such column exists
 *     today, and Phase 8.1 does not invent one (pricing decisions are out
 *     of scope for this closure phase). Enforcing against a nonexistent
 *     limit would mean either always-allow (fake enforcement) or an
 *     arbitrary hardcoded number (exactly what "do NOT hardcode commercial
 *     prices" forbids) — reporting the gap is the honest option.
 */
export type QuotaStatus = {
  executionsMonthly: { used: number; limit: number; enforced: true };
  activeWorkflows: { used: number; limit: number; enforced: true };
  concurrentExecutions: { enforced: true; enforcedVia: 'reserve_concurrency_slot (per-user/per-workflow env-configured, not plan-scoped)' };
  aiTokensMonthly: { used: number; limit: null; enforced: false; reason: 'No plans.ai_tokens_limit column exists yet — usage is tracked, not capped.' };
};

export async function getQuotaStatus(userId: string): Promise<QuotaStatus> {
  const [plan, executionsUsed, workflowsUsed, aiTokensUsed] = await Promise.all([
    getPlanLimits(userId),
    getExecutionUsage(userId),
    getWorkflowUsage(userId),
    getMonthlyAiTokenUsage(userId),
  ]);

  return {
    executionsMonthly: { used: executionsUsed, limit: plan.executions_limit, enforced: true },
    activeWorkflows: { used: workflowsUsed, limit: plan.workflows_limit, enforced: true },
    concurrentExecutions: { enforced: true, enforcedVia: 'reserve_concurrency_slot (per-user/per-workflow env-configured, not plan-scoped)' },
    aiTokensMonthly: { used: aiTokensUsed, limit: null, enforced: false, reason: 'No plans.ai_tokens_limit column exists yet — usage is tracked, not capped.' },
  };
}

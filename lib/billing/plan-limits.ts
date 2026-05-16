/**
 * Billing System: Plan Limits Helper
 * Handles all plan-based restrictions and usage tracking
 */

import { createServiceClient } from '@/lib/supabase-server';

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

/**
 * Get user's current plan
 */
export async function getUserPlan(userId: string): Promise<Plan | null> {
  const supabase = createServiceClient();

  const { data: sub, error: subError } = await supabase
    .from("subscriptions")
    .select("plan_id, plan!inner(id, slug, name, price_monthly, integrations_limit, workflows_limit, executions_limit, deploy_enabled, created_at)")
    .eq("user_id", userId)
    .single();

  if (subError || !sub) {
    // If no subscription exists, user is on free plan by default
    return {
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
  }

  return (sub.plan as unknown as Plan) || null;
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
 * Get monthly execution usage count
 */
export async function getExecutionUsage(userId: string): Promise<number> {
  const supabase = createServiceClient();

  // Get count of workflow runs from current month
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const { count, error } = await supabase
    .from("workflow_runs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("executed_at", monthStart.toISOString());

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

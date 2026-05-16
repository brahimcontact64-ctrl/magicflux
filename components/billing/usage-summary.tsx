/**
 * Usage Summary Component
 * Shows plan, usage, and limits in a compact widget
 */

'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertTriangle } from 'lucide-react';
import { UsageMeter } from '@/components/app/usage-meter';
import { PlanBadge } from '@/components/app/plan-badge';

interface UsageSummary {
  plan_name: string;
  connected_integrations: number;
  integrations_limit: number;
  workflows: number;
  workflows_limit: number;
  executions_this_month: number;
  executions_limit: number;
  deploy_enabled: boolean;
}

export function UsageSummaryWidget() {
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchUsage() {
      try {
        const res = await fetch('/api/billing/usage');
        if (res.ok) {
          const data = await res.json();
          setUsage(data);
        }
      } catch (err) {
        console.error('Failed to load usage:', err);
      } finally {
        setLoading(false);
      }
    }

    fetchUsage();
  }, []);

  if (loading || !usage) {
    return <div className="text-sm text-slate-500">Loading usage...</div>;
  }

  const integrationsAtLimit =
    usage.integrations_limit !== -1 && usage.connected_integrations >= usage.integrations_limit;
  const workflowsAtLimit =
    usage.workflows_limit !== -1 && usage.workflows >= usage.workflows_limit;
  const executionNearLimit =
    usage.executions_limit !== -1 && usage.executions_this_month >= Math.floor(usage.executions_limit * 0.9);

  const planSlug = usage.plan_name.toLowerCase();
  const safePlan = planSlug === 'free' || planSlug === 'pro' || planSlug === 'business' ? planSlug : 'free';

  return (
    <div className="space-y-4 text-sm">
      <div className="flex items-center justify-between">
        <PlanBadge plan={safePlan} />
        <span className="text-xs text-muted-foreground">{usage.deploy_enabled ? 'Deploy enabled' : 'Deploy disabled'}</span>
      </div>

      <UsageMeter label="Integrations" used={usage.connected_integrations} limit={usage.integrations_limit} />
      <UsageMeter label="Workflows" used={usage.workflows} limit={usage.workflows_limit} />
      <UsageMeter label="Executions (this month)" used={usage.executions_this_month} limit={usage.executions_limit} />

      {/* Warnings */}
      {(integrationsAtLimit || workflowsAtLimit || executionNearLimit) && (
        <Alert className="border-orange-200 bg-orange-50">
          <AlertTriangle className="h-4 w-4 text-orange-600" />
          <AlertDescription className="text-orange-800">
            {integrationsAtLimit && <p>You've reached your integration limit.</p>}
            {workflowsAtLimit && <p>You've reached your workflow limit.</p>}
            {executionNearLimit && <p>Your monthly execution usage is near the plan limit.</p>}
            <Link href="/pricing" className="underline font-semibold">
              Upgrade your plan
            </Link>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

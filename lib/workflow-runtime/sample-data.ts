/**
 * Generates representative sample input data for a workflow based on the
 * node types present. Used by test/preview execution endpoints to produce
 * meaningful test payloads without requiring real data from upstream systems.
 *
 * Note: the substring checks here detect workflow THEME for sample-data
 * generation only — they have no connection to credential routing or provider
 * authentication. The security-critical allowlists live in lib/integrations.ts
 * and lib/workflow-runtime/node-handlers/index.ts.
 */

type SampleWorkflowNode = { name?: string; type?: string };

export function createSampleDataForWorkflow(workflowJson: unknown): Record<string, unknown> {
  const workflow = (workflowJson ?? {}) as { nodes?: SampleWorkflowNode[] };
  const nodes = workflow.nodes ?? [];
  const combinedText = nodes
    .map((node) => `${String(node.name ?? '')} ${String(node.type ?? '')}`.toLowerCase())
    .join(' ');

  if (combinedText.includes('shopify')) {
    return {
      order_id: '1001',
      customer_email: 'customer@example.com',
      total_price: '49.99',
      currency: 'USD',
      line_items: [
        { sku: 'SKU-001', title: 'Demo Product', quantity: 1, price: '49.99' },
      ],
    };
  }

  if (
    combinedText.includes('airbnb') ||
    combinedText.includes('booking') ||
    combinedText.includes('reservation')
  ) {
    return {
      guest_name: 'Test Guest',
      guest_email: 'guest@example.com',
      confirmation_code: 'ABC123',
      check_in_date: '2026-06-01',
      check_out_date: '2026-06-05',
      listing_name: 'MagicFlux Demo Apartment',
    };
  }

  return {
    name: 'Test User',
    email: 'test@example.com',
    message: 'This is a test event',
  };
}

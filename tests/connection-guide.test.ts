/**
 * Phase 9.9.21 -- Connection Guide unit coverage: field derivation must
 * come from the workflow's OWN JSON (never a hardcoded global list), the
 * platform registry must be internally consistent, and generated code
 * snippets/developer handoff must never leak more than intended.
 */

import { describe, it, expect } from 'vitest';
import { deriveTriggerFields, buildSamplePayload } from '@/lib/connection-guide/trigger-fields';
import { PLATFORM_GUIDES, getPlatformGuide } from '@/lib/connection-guide/platform-registry';
import { buildCodeSnippets, buildDeveloperHandoff } from '@/lib/connection-guide/code-snippets';

describe('deriveTriggerFields()', () => {
  it('derives Workflow #1-shaped fields (name/email/budget/urgency/purchase_intent) from ITS OWN json -- not hardcoded', () => {
    const workflowJson = {
      nodes: [
        { id: '1', type: 'n8n-nodes-base.webhook', parameters: { httpMethod: 'POST', path: 'sigma-plus' } },
        {
          id: '2',
          type: 'magicflux-nodes.aiClassifier',
          parameters: { inputFields: ['budget', 'urgency', 'purchase_intent'], allowedLabels: ['Hot', 'Warm', 'Cold'] },
        },
        {
          id: '3',
          type: 'n8n-nodes-base.airtable',
          parameters: { fields: { Name: '={{$json["name"]}}', Email: '={{$json["email"]}}' } },
        },
      ],
    };

    const fields = deriveTriggerFields(workflowJson);
    const names = fields.map((f) => f.name).sort();
    expect(names).toEqual(['budget', 'email', 'name', 'purchase_intent', 'urgency'].sort());

    const required = fields.filter((f) => f.required).map((f) => f.name);
    expect(required).toEqual(expect.arrayContaining(['name', 'email']));
  });

  it('a DIFFERENT workflow gets DIFFERENT fields -- proves no global hardcoding', () => {
    const workflowJson = {
      nodes: [
        { id: '1', type: 'n8n-nodes-base.webhook', parameters: {} },
        { id: '2', type: 'n8n-nodes-base.slack', parameters: { text: '={{$json["order_id"]}} shipped to {{$json.customer_address}}' } },
      ],
    };
    const names = deriveTriggerFields(workflowJson).map((f) => f.name).sort();
    expect(names).toEqual(['customer_address', 'order_id']);
    expect(names).not.toContain('email');
    expect(names).not.toContain('budget');
  });

  it('a field referenced ONLY inside an optional {{?field}}...{{/field}} block is optional, not required', () => {
    const workflowJson = {
      nodes: [
        { id: '1', type: 'n8n-nodes-base.webhook', parameters: {} },
        {
          id: '2',
          type: 'n8n-nodes-base.slack',
          parameters: { text: 'Lead: ={{$json["email"]}} {{?company}}from {{$json["company"]}}{{/company}}' },
        },
      ],
    };
    const fields = deriveTriggerFields(workflowJson);
    const email = fields.find((f) => f.name === 'email');
    const company = fields.find((f) => f.name === 'company');
    expect(email?.required).toBe(true);
    expect(company?.required).toBe(false);
  });

  it('a field referenced BOTH strictly and inside an optional block elsewhere is required (required wins)', () => {
    const workflowJson = {
      nodes: [
        { id: '1', type: 'n8n-nodes-base.webhook', parameters: {} },
        { id: '2', type: 'n8n-nodes-base.slack', parameters: { text: '={{$json["email"]}}' } },
        { id: '3', type: 'n8n-nodes-base.gmail', parameters: { subject: '{{?email}}cc {{$json["email"]}}{{/email}}' } },
      ],
    };
    const fields = deriveTriggerFields(workflowJson);
    expect(fields.find((f) => f.name === 'email')?.required).toBe(true);
  });

  it('an empty/schema-less workflow (no downstream references) derives zero fields', () => {
    const workflowJson = { nodes: [{ id: '1', type: 'n8n-nodes-base.webhook', parameters: { httpMethod: 'POST' } }] };
    expect(deriveTriggerFields(workflowJson)).toEqual([]);
  });
});

describe('buildSamplePayload()', () => {
  it('builds a realistic, non-generic example value per field name', () => {
    const payload = buildSamplePayload([
      { name: 'email', required: true, source: 'template' },
      { name: 'budget', required: true, source: 'template' },
    ]);
    expect(payload.email).toBe('jane@example.com');
    expect(typeof payload.budget).toBe('number');
  });
});

describe('PLATFORM_GUIDES registry', () => {
  it('every entry has the required shape and at least one step', () => {
    for (const guide of PLATFORM_GUIDES) {
      expect(guide.id).toBeTruthy();
      expect(guide.label).toBeTruthy();
      expect(guide.summary).toBeTruthy();
      expect(guide.steps.length).toBeGreaterThan(0);
      expect(['native', 'connector_pending', 'plugin', 'intermediary', 'requires_relay', 'custom_api']).toContain(guide.connectionType);
    }
  });

  it('Phase 9.9.22 Part A: no platform is claimed "native" without a genuine, verified, relay-free MagicFlux receiver -- today that is none of them (Custom/API is its own honest "custom_api" category, not "native")', () => {
    const nativeClaims = PLATFORM_GUIDES.filter((p) => p.connectionType === 'native').map((p) => p.id);
    expect(nativeClaims).toEqual([]);
  });

  it('Phase 9.9.22 Part A: Shopify/ClickFunnels/Webflow/Wix/Framer are corrected to "requires_relay", not "native"', () => {
    for (const id of ['shopify', 'clickfunnels', 'webflow', 'wix', 'framer']) {
      expect(getPlatformGuide(id)?.connectionType).toBe('requires_relay');
    }
  });

  it('Phase 9.9.22 Part A: WooCommerce is "connector_pending" (a real connector exists in code, not yet certified/migrated) -- never "native" before certification', () => {
    expect(getPlatformGuide('woocommerce')?.connectionType).toBe('connector_pending');
  });

  it('every officialDocs URL is https', () => {
    for (const guide of PLATFORM_GUIDES) {
      for (const doc of guide.officialDocs) {
        expect(doc.url.startsWith('https://')).toBe(true);
      }
    }
  });

  it('covers every platform the product spec names', () => {
    const ids = PLATFORM_GUIDES.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining([
      'custom', 'wordpress', 'woocommerce', 'shopify', 'clickfunnels', 'webflow', 'wix', 'squarespace', 'framer', 'other',
    ]));
  });

  it('Squarespace is truthfully NOT claimed native -- its Form Block has no generic webhook destination', () => {
    expect(getPlatformGuide('squarespace')?.connectionType).toBe('intermediary');
  });

  it('WordPress (plain core) is truthfully NOT claimed native -- requires a plugin', () => {
    expect(getPlatformGuide('wordpress')?.connectionType).toBe('plugin');
  });

  it('every platform claimed "native" or "plugin" links at least one official doc backing the claim (except the deliberately generic "other")', () => {
    for (const guide of PLATFORM_GUIDES) {
      if (guide.id === 'other' || guide.id === 'custom') continue;
      expect(guide.officialDocs.length).toBeGreaterThan(0);
    }
  });
});

describe('buildCodeSnippets()', () => {
  const snippets = buildCodeSnippets({
    webhookUrl: 'https://www.magicflux.ai/api/workflows/wf-1/webhook',
    method: 'POST',
    secretHeaderName: 'X-MagicFlux-Webhook-Secret',
    secretValue: 'SECRET_SHOULD_NOT_LEAK',
    samplePayload: { email: 'jane@example.com' },
  });

  it('covers JS fetch, HTML+server, Next.js, Node, PHP, Python', () => {
    const ids = snippets.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(['browser-fetch', 'html-form', 'nextjs', 'nodejs', 'php', 'python']));
  });

  it('the browser-facing snippet NEVER embeds the raw secret value -- only env var references', () => {
    const browser = snippets.find((s) => s.id === 'browser-fetch')!;
    expect(browser.code).not.toContain('SECRET_SHOULD_NOT_LEAK');
    expect(browser.code).toContain('process.env.MAGICFLUX_WEBHOOK_SECRET');
  });

  it('every server-side snippet references the real webhook URL (html-form intentionally posts to the SITE\'S OWN endpoint instead, never the webhook directly from a public form)', () => {
    for (const s of snippets) {
      if (s.id === 'html-form') continue;
      expect(s.code).toContain('https://www.magicflux.ai/api/workflows/wf-1/webhook');
    }
  });
});

describe('buildDeveloperHandoff()', () => {
  it('omits the secret value by default (null)', () => {
    const handoff = buildDeveloperHandoff({
      webhookUrl: 'https://www.magicflux.ai/api/workflows/wf-1/webhook',
      method: 'POST',
      secretHeaderName: 'X-MagicFlux-Webhook-Secret',
      secretValue: null,
      requiredFields: ['email'],
      optionalFields: [],
      samplePayload: { email: 'jane@example.com' },
    });
    expect(handoff).not.toContain('REAL_SECRET');
    expect(handoff).toContain('not included here');
  });

  it('includes the secret value only when explicitly passed', () => {
    const handoff = buildDeveloperHandoff({
      webhookUrl: 'https://www.magicflux.ai/api/workflows/wf-1/webhook',
      method: 'POST',
      secretHeaderName: 'X-MagicFlux-Webhook-Secret',
      secretValue: 'REAL_SECRET_VALUE',
      requiredFields: ['email'],
      optionalFields: [],
      samplePayload: { email: 'jane@example.com' },
    });
    expect(handoff).toContain('REAL_SECRET_VALUE');
  });
});

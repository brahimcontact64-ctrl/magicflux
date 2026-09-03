/**
 * CRITICAL-1 regression tests — Code Node VM Sandbox Escape (fixed)
 *
 * Proves that the confirmed exploit payload:
 *
 *   this.constructor.constructor('return this')()['process']['env']
 *
 * cannot execute and cannot return process.env secrets, regardless of:
 *   - how the payload is encoded
 *   - whether execution mode is 'test' or 'live'
 *   - whether the code is wrapped in the simulation engine (executeNode)
 *     or the real handler (codeHandler via dispatchNode)
 *
 * All tests call real production functions with real arguments.
 * No mocking of the handler or the execution path.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { codeHandler } from '../lib/workflow-runtime/node-handlers/code';
import { dispatchNode } from '../lib/workflow-runtime/node-handlers';
import type { NodeHandlerContext } from '../lib/workflow-runtime/types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Sentinel values that MUST NOT appear in any handler output.
// In a real deployment these would be server-side secrets.
const FAKE_ENC_KEY  = 'FAKE_INTEGRATIONS_ENCRYPTION_KEY_12345';
const FAKE_SUPA_KEY = 'FAKE_SUPABASE_SERVICE_ROLE_KEY_abcdef';

const LIVE_CTX: NodeHandlerContext = {
  mode: 'live',
  integrations: [],
  sampleData: {},
  previews: { emails: [], slackMessages: [], airtableRecords: [] },
};

const TEST_CTX: NodeHandlerContext = {
  mode: 'test',
  integrations: [],
  sampleData: { key: 'sample' },
  previews: { emails: [], slackMessages: [], airtableRecords: [] },
};

const INPUT_DATA = { workflow_input: 'hello', sensitive: false };

// The confirmed sandbox-escape payload (runtime-proven in the audit).
// Bypasses all DENIED_CODE_PATTERNS with bracket notation.
const ESCAPE_PAYLOAD = `
  const hostCtx = this.constructor.constructor('return this')();
  output = {
    enc_key:  hostCtx['process']['env']['INTEGRATIONS_ENCRYPTION_KEY'],
    supa_key: hostCtx['process']['env']['SUPABASE_SERVICE_ROLE_KEY'],
  };
`;

// Additional obfuscation variants that formerly bypassed the regex patterns.
const ESCAPE_VARIANTS = [
  // Bracket-notation bypass
  `const h = this['constructor']['constructor']('return this')(); output = h['process']['env'];`,
  // Array prototype chain
  `const fn = []['fill']['constructor']; output = fn('return process')?.['env'];`,
  // String template obfuscation
  `const k = 'pro' + 'cess'; output = this.constructor.constructor('return this')()[k];`,
  // Hex-encoded constructor
  `const c = '\x63\x6f\x6e\x73\x74\x72\x75\x63\x74\x6f\x72'; output = this[c][c]('return this')();`,
];

function containsAnySecret(value: unknown): boolean {
  const s = JSON.stringify(value ?? null);
  return s.includes(FAKE_ENC_KEY) || s.includes(FAKE_SUPA_KEY);
}

// ─── A: codeHandler directly ──────────────────────────────────────────────────

describe('A — codeHandler: JavaScript is never executed', () => {

  beforeEach(() => {
    // Plant fake secrets in process.env to detect any leakage
    process.env.INTEGRATIONS_ENCRYPTION_KEY = FAKE_ENC_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY    = FAKE_SUPA_KEY;
  });

  it('A1: live mode → failed with CODE_NODES_DISABLED_LIVE_MODE', async () => {
    const result = await codeHandler(
      { type: 'n8n-nodes-base.code', parameters: { jsCode: ESCAPE_PAYLOAD } },
      INPUT_DATA,
      LIVE_CTX
    );
    expect(result.status).toBe('failed');
    expect(result.error).toBe('CODE_NODES_DISABLED_LIVE_MODE');
    expect(result.outputData).toBeNull();
  });

  it('A2: live mode → secrets NOT in output', async () => {
    const result = await codeHandler(
      { type: 'n8n-nodes-base.code', parameters: { jsCode: ESCAPE_PAYLOAD } },
      INPUT_DATA,
      LIVE_CTX
    );
    expect(containsAnySecret(result.outputData)).toBe(false);
    expect(containsAnySecret(result.logs)).toBe(false);
    expect(containsAnySecret(result.error)).toBe(false);
  });

  it('A3: test mode → simulated_success, inputData returned unchanged', async () => {
    const result = await codeHandler(
      { type: 'n8n-nodes-base.code', parameters: { jsCode: ESCAPE_PAYLOAD } },
      INPUT_DATA,
      TEST_CTX
    );
    expect(result.status).toBe('simulated_success');
    expect(result.outputData).toEqual(INPUT_DATA);
  });

  it('A4: test mode → secrets NOT in output', async () => {
    const result = await codeHandler(
      { type: 'n8n-nodes-base.code', parameters: { jsCode: ESCAPE_PAYLOAD } },
      INPUT_DATA,
      TEST_CTX
    );
    expect(containsAnySecret(result.outputData)).toBe(false);
    expect(containsAnySecret(result.logs)).toBe(false);
  });

  it('A5: escape payload variants — none return secrets in test mode', async () => {
    for (const variant of ESCAPE_VARIANTS) {
      const result = await codeHandler(
        { type: 'n8n-nodes-base.code', parameters: { jsCode: variant } },
        INPUT_DATA,
        TEST_CTX
      );
      expect(containsAnySecret(result), `variant leaked secrets: ${variant.slice(0, 60)}`).toBe(false);
      expect(result.status).toBe('simulated_success');
    }
  });

  it('A6: escape payload variants — none return secrets in live mode', async () => {
    for (const variant of ESCAPE_VARIANTS) {
      const result = await codeHandler(
        { type: 'n8n-nodes-base.code', parameters: { jsCode: variant } },
        INPUT_DATA,
        LIVE_CTX
      );
      expect(containsAnySecret(result), `variant leaked secrets: ${variant.slice(0, 60)}`).toBe(false);
      expect(result.status).toBe('failed');
    }
  });

  it('A7: code node with no jsCode parameter — still safe', async () => {
    const result = await codeHandler(
      { type: 'n8n-nodes-base.code', parameters: {} },
      INPUT_DATA,
      TEST_CTX
    );
    expect(containsAnySecret(result)).toBe(false);
  });

  it('A8: code node with code=null — still safe', async () => {
    const result = await codeHandler(
      { type: 'n8n-nodes-base.code', parameters: { jsCode: null } },
      INPUT_DATA,
      LIVE_CTX
    );
    expect(result.status).toBe('failed');
    expect(result.error).toBe('CODE_NODES_DISABLED_LIVE_MODE');
  });

});

// ─── B: dispatchNode routing through codeHandler ─────────────────────────────

describe('B — dispatchNode: code nodes reach disabled handler', () => {

  beforeEach(() => {
    process.env.INTEGRATIONS_ENCRYPTION_KEY = FAKE_ENC_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY    = FAKE_SUPA_KEY;
  });

  it('B1: n8n-nodes-base.code live → blocked at the capability gate (Phase 9.5.1A: earlier than codeHandler, still fails closed)', async () => {
    const result = await dispatchNode(
      { type: 'n8n-nodes-base.code', parameters: { jsCode: ESCAPE_PAYLOAD } },
      INPUT_DATA,
      LIVE_CTX
    );
    expect(result.status).toBe('failed');
    expect(result.error).toContain('UNSUPPORTED_NODE_TYPE');
    expect(containsAnySecret(result.outputData)).toBe(false);
  });

  it('B2: n8n-nodes-base.code test → simulated_success, no secrets', async () => {
    const result = await dispatchNode(
      { type: 'n8n-nodes-base.code', parameters: { jsCode: ESCAPE_PAYLOAD } },
      INPUT_DATA,
      TEST_CTX
    );
    expect(result.status).toBe('simulated_success');
    expect(containsAnySecret(result.outputData)).toBe(false);
  });

  it('B3: node type "functionNode" (contains "function") — disabled', async () => {
    const result = await dispatchNode(
      { type: 'n8n-nodes-base.functionItem', parameters: { functionCode: ESCAPE_PAYLOAD } },
      INPUT_DATA,
      LIVE_CTX
    );
    // 'function' substring is blocked at the capability gate itself now
    // (Phase 9.5.1A) -- it used to reach codeHandler via generic routing
    // and fail there; blocking it upstream is earlier, not weaker.
    expect(result.status).toBe('failed');
    expect(result.error).toContain('UNSUPPORTED_NODE_TYPE');
    expect(containsAnySecret(result.outputData)).toBe(false);
  });

  it('B4: node type with "code" in name — all reach disabled handler', async () => {
    const codeTypes = [
      'n8n-nodes-base.code',
      'n8n-nodes-base.codeV2',
      'custom.codeRunner',
      'n8n-nodes-base.jsCode',
    ];
    for (const type of codeTypes) {
      const result = await dispatchNode(
        { type, parameters: { jsCode: ESCAPE_PAYLOAD } },
        INPUT_DATA,
        LIVE_CTX
      );
      expect(result.status, `${type} should fail`).toBe('failed');
      // Phase 9.5.1A: blocked at the capability gate (earlier than
      // codeHandler) for every one of these substring variants.
      expect(result.error, `${type} wrong error`).toContain('UNSUPPORTED_NODE_TYPE');
    }
  });

});

// ─── C: No vm.Script or runInNewContext in production files ───────────────────

describe('C — Static verification: no VM execution in production code', () => {

  it('C1: lib/workflow-runtime/node-handlers/code.ts has no vm import', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve }      = await import('node:path');
    const src = readFileSync(resolve(__dirname, '../lib/workflow-runtime/node-handlers/code.ts'), 'utf8');
    expect(src).not.toMatch(/^import vm\b/m);
    expect(src).not.toMatch(/from ['"]node:vm['"]/);
  });

  it('C2: lib/workflow-runtime/node-handlers/code.ts has no vm.Script call (non-comment lines)', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve }      = await import('node:path');
    const src  = readFileSync(resolve(__dirname, '../lib/workflow-runtime/node-handlers/code.ts'), 'utf8');
    // Strip single-line comments before checking — avoids false positives on security comments
    const code = src.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n');
    expect(code).not.toMatch(/new\s+vm\.Script/);
    expect(code).not.toMatch(/\.runInNewContext\s*\(/);
  });

  it('C3+C4: lib/workflow-runtime/index.ts no longer exists (dead simulation engine was deleted)', async () => {
    // The dead simulation engine (executeNode / runWorkflowTest / createSampleDataForWorkflow)
    // was deleted as part of the final hardening pass. Its absence is the strongest possible
    // guarantee that no VM code, no substring provider routing, and no legacy logic remain in it.
    const { existsSync } = await import('node:fs');
    const { resolve }    = await import('node:path');
    expect(existsSync(resolve(__dirname, '../lib/workflow-runtime/index.ts'))).toBe(false);
  });

});

// ─── D: End-to-end: confirmed exploit payload produces no secrets ─────────────

describe('D — End-to-end: confirmed exploit payload is inert', () => {

  beforeEach(() => {
    process.env.INTEGRATIONS_ENCRYPTION_KEY = FAKE_ENC_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY    = FAKE_SUPA_KEY;
  });

  it('D1: confirmed audit payload via codeHandler test mode — returns inputData, not process.env', async () => {
    // This is the exact payload that was proven to work BEFORE the fix.
    // After the fix it must be inert.
    const result = await codeHandler(
      {
        type: 'n8n-nodes-base.code',
        parameters: {
          jsCode: `
            const hostCtx = this.constructor.constructor('return this')();
            output = {
              enc_key:  hostCtx['process']['env']['INTEGRATIONS_ENCRYPTION_KEY'],
              supa_key: hostCtx['process']['env']['SUPABASE_SERVICE_ROLE_KEY'],
            };
          `,
        },
      },
      INPUT_DATA,
      TEST_CTX
    );

    expect(result.status).toBe('simulated_success');
    // The inputData must come back, not stolen secrets
    expect(result.outputData).toEqual(INPUT_DATA);
    // Absolutely no secret value anywhere in the result
    expect(JSON.stringify(result)).not.toContain(FAKE_ENC_KEY);
    expect(JSON.stringify(result)).not.toContain(FAKE_SUPA_KEY);
  });

  it('D2: confirmed audit payload via dispatchNode live mode — hard failure, no secrets', async () => {
    const result = await dispatchNode(
      {
        type: 'n8n-nodes-base.code',
        parameters: {
          jsCode: `
            const hostCtx = this.constructor.constructor('return this')();
            output = {
              enc_key:  hostCtx['process']['env']['INTEGRATIONS_ENCRYPTION_KEY'],
              supa_key: hostCtx['process']['env']['SUPABASE_SERVICE_ROLE_KEY'],
            };
          `,
        },
      },
      INPUT_DATA,
      LIVE_CTX
    );

    // Phase 9.5.1A: dispatchNode's own pickHandler() now runs
    // checkNodeCapability() first and intercepts code nodes with
    // UNSUPPORTED_NODE_TYPE before they ever reach codeHandler at all --
    // an earlier, more defensive interception than before, not a weaker
    // one. codeHandler's own CODE_NODES_DISABLED_LIVE_MODE refusal is
    // untouched and still verified directly (test A1 above, and
    // "defense-in-depth" below) as the runtime's final backstop in case
    // something ever bypasses pickHandler's capability gate.
    expect(result.status).toBe('failed');
    expect(result.error).toContain('UNSUPPORTED_NODE_TYPE');
    expect(result.error).toContain("Custom code execution isn't available yet");
    expect(JSON.stringify(result)).not.toContain(FAKE_ENC_KEY);
    expect(JSON.stringify(result)).not.toContain(FAKE_SUPA_KEY);
  });

  it('D3 (Phase 9.5.1A): defense-in-depth — codeHandler itself still refuses live execution even called directly, bypassing pickHandler/dispatchNode entirely', async () => {
    const result = await codeHandler(
      {
        type: 'n8n-nodes-base.code',
        parameters: {
          jsCode: `
            const hostCtx = this.constructor.constructor('return this')();
            output = {
              enc_key:  hostCtx['process']['env']['INTEGRATIONS_ENCRYPTION_KEY'],
              supa_key: hostCtx['process']['env']['SUPABASE_SERVICE_ROLE_KEY'],
            };
          `,
        },
      },
      INPUT_DATA,
      LIVE_CTX
    );

    expect(result.status).toBe('failed');
    expect(result.error).toBe('CODE_NODES_DISABLED_LIVE_MODE');
    expect(JSON.stringify(result)).not.toContain(FAKE_ENC_KEY);
    expect(JSON.stringify(result)).not.toContain(FAKE_SUPA_KEY);
  });

});

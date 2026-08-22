# Phase 8.7 — External Provider Certification & Release Freeze

Date: 2026-08-22
Starting branch/HEAD: `main` @ `e53f28ea8149adee3b5cd271be00766507717894`
Baseline: Phase 8.6 certified `PRODUCTION READY WITH EXTERNAL PROVIDER VALIDATION PENDING`.

## Scope

Certify that MagicFlux's real credential storage and runtime paths work end-to-end
against real external providers where credentials are available, using a
disposable minimal live stack (Postgres 17 + PostgREST + Redis + a local
`/rest/v1` proxy, following the same pattern established and proven in Phase
8.6). No mocks for any runtime code path. Real, disposable/synthetic
credentials only — no production customer data.

## Provider credential inventory (names checked, values never printed)

| Provider | Status |
|---|---|
| OpenAI | **CONFIGURED** — real key present in `.env`/`.env.local` |
| Slack | NOT CONFIGURED |
| Gmail | NOT CONFIGURED |
| Airtable | NOT CONFIGURED |
| Shopify | NOT CONFIGURED |
| Generic API Key / HTTP | N/A — no external credential needed; certified against a locally-controlled test server |

Per the explicit certification rule: providers with no configured credential
are reported **BLOCKED**, not fabricated as passing or failing. Their
storage/encryption/resolution *mechanics* were still certified live (Step 1)
using synthetic credential values, since that requires no real third-party
account — only their *positive-path live API call* (Steps 3–6) is blocked.

## Step 1 — Credential path certification (all 6 providers)

For openai, slack, shopify, airtable, and gmail: real `saveProviderCredentials()`
→ confirmed ciphertext at rest in `integration_credentials` → real
`getUserIntegrations()` bridge → confirmed correct decrypted round-trip →
real live execution referencing each provider's node type → confirmed the
credential never appears in `workflow_json`, the real BullMQ queue payload,
or `workflow_execution_steps`. All 5 **PASS**.

Bonus finding: with synthetic (invalid) credentials, the live execution
environment reached real OpenAI/Slack/Airtable/Gmail API endpoints and
received real 401/404 responses — confirming genuine outbound network
reachability and correct graceful error handling, independent of credential
validity.

## Step 2 — OpenAI live test: **PASS**

Real workflow (Webhook → OpenAI, prompt "Reply with exactly: MAGICFLUX_OK")
run through the actual `openaiHandler` against the real OpenAI API:
- Real response received: `"MAGICFLUX_OK"`.
- Model correctly recorded: `gpt-4o-mini`.
- Real usage metadata captured: 15 prompt + 5 completion = 20 total tokens.
- Execution reached `success`; output persisted correctly.
- API key confirmed absent from `workflow_json`, the execution row, the
  queue payload, and `workflow_execution_steps` (exhaustive re-check in
  Step 10 additionally scanned `runtime_usage_events` and
  `runtime_worker_registry` — 7 locations total, zero leaks).

## Steps 3–6 — Slack / Airtable / Gmail / Shopify: **BLOCKED (no credential available)**

Explicitly distinguished from a certification failure: no real credential
exists anywhere in this environment for these four providers. Their
credential-path *mechanics* (Step 1) passed; their live positive-path API
calls (post a real Slack message, CRUD a real Airtable record, send a real
Gmail message, read real Shopify shop metadata) could not be attempted
without fabricating validation, per explicit instruction.

## Step 7 — Generic API Key / HTTP live test: **PASS (with one real bug found and fixed)**

Certified against a locally-controlled Node test server (no external
dependency): GET, POST with header-name+prefix credential injection, retry
on a controlled 5xx (succeeds on attempt 2), permanent-5xx failure (4
attempts, "Node failed permanently"), timeout (no hang, fails cleanly),
response-size-limit enforcement (5MB cap, no unbounded buffering), and
credential-leakage checks against `workflow_json`/queue payload. 7/7 pass
after two fixes described below.

### Bug found and fixed: Generic/custom HTTP credential injection was dead code

`httpHandler` (`lib/workflow-runtime/node-handlers/http.ts`) has fully-built
credential-injection logic for the `custom` provider (configurable header
name + optional prefix), and `lib/credentials/provider-registry.ts` has
complete UI field definitions for it — but `lib/integrations.ts`'s
`PROVIDER_NODE_ALLOWLIST` (the single source of truth three separate systems
derive from) never had an entry for `custom`/`n8n-nodes-base.httpRequest`.
Confirmed live: before the fix, a configured custom API-key credential was
never injected into any HTTP node's request, in any workflow, ever.

Fix required three coordinated, minimal edits:
1. `lib/integrations.ts` — add `custom → n8n-nodes-base.httprequest` to
   `PROVIDER_NODE_ALLOWLIST`.
2. `lib/workflow-runtime/node-handlers/index.ts` — add the matching entry to
   `HANDLER_NODE_ALLOWLIST` (a separate allowlist with its own bidirectional
   consistency test, `tests/allowlist-consistency.security.test.ts`).
3. `lib/user-integrations.ts` — make `resolveWorkflowIntegrations()` treat
   `custom` as *optional* (never throws `SETUP_REQUIRED`), since `httpHandler`
   itself already treats an absent `custom` credential as "nothing to
   inject," not an error. Without this, every existing HTTP node calling an
   unauthenticated public API would have started hard-failing the moment
   `custom` became a recognized required provider.

A related latent bug was also fixed in `lib/integrations.ts`'s legacy
`injectCredentialsIntoWorkflow()`: without a `RUNTIME_ONLY_PROVIDERS` guard,
routing `custom`/`openai` nodes through `deepInject()` caused any
`{{ $env.SHOPIFY_ACCESS_TOKEN }}`-style text those nodes happened to contain
to be silently blanked to an empty string (the shared placeholder-replace
regex matches globally regardless of node scope). Guarded so those two
runtime-only providers skip legacy injection entirely, exactly as they
already should.

Two existing test files were updated to match the new, correct, intentional
behavior (not weakened — the crafted/malicious-node-type security invariant
they protect is fully preserved and still tested):
`tests/required-providers.security.test.ts` (`n8n-nodes-base.httpRequest`
removed from three stale "requires nothing" lists it was swept into before
the `custom` provider concept existed — mirroring how `openai` was never in
those lists either — plus one new explicit positive-path assertion added)
and `tests/final-verification.test.ts` (mechanical allowlist-size count
13→14).

## Step 8 — Provider failure matrix: **PASS**

- **OpenAI, invalid credential**: real live 401 from the actual API
  ("Incorrect API key provided"), the OpenAI SDK's own masking confirmed
  (`sk-phase**********************************0000`), full key never
  exposed, bounded elapsed time.
- **Generic HTTP, 401 / 403**: fail immediately, zero retry attempts
  (`isRetryableStatus()` correctly excludes them).
- **Generic HTTP, 429**: correctly retried (rate-limit is retryable),
  eventually fails predictably, bounded elapsed time (~18s, not infinite).

429/403/401/5xx/timeout/oversized-body were all exercised; 403/429 credential
never leaked in any case.

## Step 9 — Multi-provider chained workflow: **NOT MET (precondition not satisfied)**

Requires "at least OpenAI + one messaging/storage provider." Only OpenAI has
a real credential; Slack and Airtable (the two messaging/storage candidates)
are both BLOCKED. Per the explicit instruction against fabricating
validation, this step was not attempted with a substitute. Not a failure —
a precondition genuinely unmet in this environment.

## Step 10 — Security re-certification: **PASS**

- Exhaustive real-OpenAI-key leakage scan across 7 locations a real live
  execution touches: `workflows`, `workflow_executions_v2`,
  `workflow_execution_steps`, `runtime_queue_jobs`, `runtime_usage_events`,
  `runtime_worker_registry`, and the `integration_credentials` at-rest row
  (ciphertext-only check). Zero leaks in all 7.
- Cross-tenant: tenant B's `getUserIntegrations()` never includes tenant A's
  OpenAI credential; direct ownership-assertion helper correctly denies
  tenant B any access to tenant A's workflow.
- Full pre-existing suite re-run (1433/1433 passing), including
  `tests/ssrf-guard.test.ts` (redirect-to-metadata regression, mocked
  DNS/fetch, `httpHandler`-level), `tests/credential-injection*.test.ts`,
  `tests/allowlist-consistency.security.test.ts`,
  `tests/required-providers.security.test.ts`, and all Phase 8.6 cross-tenant
  / replay / forged-webhook suites.

## Known, pre-existing, NOT-fixed finding: execution-level retry scheduling has no consumer

Discovered live while certifying the Generic HTTP node's persistent-failure
behavior, but **confirmed provider-agnostic and pre-existing** — not
introduced by any Phase 8.7 change, and not specific to HTTP nodes.

`runtime/workflow-engine.ts` (~L590–627): when a node exhausts its own
internal retry budget (`runtime/node-runner.ts`'s 4-attempt loop — verified
correct and working via `workflow_execution_steps`: 4 attempts, "Node failed
permanently", correct sanitized error), the engine separately checks an
execution-level `retryCount` against `maxRetries` and, if not yet exhausted,
sets the execution to `status:'waiting'` with a computed `next_run_at`,
persists a checkpoint, and returns — expecting an external process to later
call `resumeExecution()`. A full-codebase search for any query matching
`status='waiting' AND next_run_at <= now()` returned zero matches: **no
cron, poller, or scheduler anywhere consumes these scheduled retries.**

Live-confirmed impact: a workflow whose node persistently fails (5xx,
timeout, or any other non-immediately-permanent error) reaches the correct
node-level terminal state, but the **execution row itself gets stuck at
`'waiting'` indefinitely** — it never becomes `'success'` or `'failed'` on
its own. The only eventual recovery is the self-heal cron's
`markOrphanExecutionsFailed` (10-minute staleness window, see
`docs/release` Phase 8.4/8.6 notes), which mislabels the failure reason as
`"worker timeout"` rather than the real underlying error.

**Not fixed in this phase**: a correct fix means building new
retry-poller/scheduler infrastructure, which is out of bounds for a minimal,
safe, root-cause-scoped change under this phase's explicit "do not redesign
the architecture" constraint. Flagged here prominently as the primary
recommended follow-up for whichever phase next owns runtime
retry/scheduling work. This is why the final verdict below is qualified
rather than an unconditional "fully certified."

## Gate results

- TypeScript (`tsc --noEmit`): **0 errors**.
- Vitest full suite: **1433/1433 passing** (52 files), including all new
  Phase 8.7 assertions, zero regressions from any fix.
- `next build`: **succeeds**, all 86 routes generated cleanly.
- Secret scan of the full diff: **clean** (only synthetic/disposable test
  strings, never printed as real credential values).
- Disk: stable throughout (~8.1GB free at close, same range as start) — no
  repeat of the Phase 8.4/8.5 disk-exhaustion incidents.
- Unrelated Docker containers/networks: verified untouched.

## Files changed this phase (Phase 8.6 + 8.7 combined, all previously uncommitted)

- `lib/runtime/queue.ts` — Phase 8.6: BullMQ job-ID colon-collision fix.
- `runtime/runtime-state.ts` — Phase 8.6: usage-event quantity-unit fix.
- `runtime/hardening-layer.ts` — Phase 8.6: execution-lock idempotency-key collision fix.
- `lib/integrations.ts` — Phase 8.7: `custom` provider allowlist wiring + `RUNTIME_ONLY_PROVIDERS` guard.
- `lib/user-integrations.ts` — Phase 8.7: `custom` provider treated as optional in `resolveWorkflowIntegrations()`.
- `lib/workflow-runtime/node-handlers/index.ts` — Phase 8.7: `HANDLER_NODE_ALLOWLIST` entry for the generic HTTP node.
- `tests/required-providers.security.test.ts`, `tests/final-verification.test.ts` — Phase 8.7: updated to match the new, correct, intentional behavior.
- 12 migration files, `app/api/cron/self-heal/`, `tests/self-heal-cron.security.test.ts`, `tests/ssrf-guard.test.ts`, `vercel.json`, `docs/release/phase8_3-*.md` — carried forward unmodified from Phase 8.4, preserved throughout.

## Final verdict

**PHASE 8.7: PRODUCTION READY — EXTERNAL PROVIDERS PARTIALLY UNVERIFIED**

Core runtime (webhook/scheduler/versioning/usage/BullMQ/self-heal/security —
Phase 8.6) remains fully certified. This phase adds: real OpenAI
certification (PASS), real generic-HTTP certification (PASS, one dead
feature fixed), a real provider-failure matrix (PASS), and a security
re-certification with zero secret leakage found (PASS). Slack, Gmail,
Airtable, and Shopify remain genuinely unverified for lack of any real
credential — explicitly not a certification failure. One pre-existing,
provider-agnostic execution-retry-scheduling gap was discovered and
documented, not fixed, as the primary recommended follow-up.

**DO NOT BEGIN PHASE 9.**

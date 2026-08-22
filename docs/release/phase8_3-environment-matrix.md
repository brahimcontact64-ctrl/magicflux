# Phase 8.3 — Environment Contract Matrix

No secret values are reproduced anywhere in this document — only variable
names, classification, and where each one is validated in code.

Classification legend:
- **REQUIRED_FOR_BOOT** — the app (or the specific runtime process: web vs worker) will not function at all without it, and fails at the earliest point that value is used.
- **REQUIRED_FOR_PRODUCTION** — the app boots and most routes work without it, but a specific production-critical path (webhook signature verification, cron auth, real async execution) is unsafe or disabled without it.
- **OPTIONAL_PROVIDER** — only gates one integration provider; its absence never blocks boot or unrelated features.
- **TEST_ONLY** — read only by test/dev/CI scripts, never by production route/runtime code.
- **LEGACY** — referenced by code paths superseded by newer systems (kept for backward compatibility, not part of the Phase 8/8.1 production path).

| Variable | Classification | Used by | Validation |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | REQUIRED_FOR_BOOT | `lib/supabase-server.ts` (every DB call, web + worker) | `!` non-null assertion; missing value throws inside the Supabase SDK's client constructor at first use, not a custom message |
| `SUPABASE_SERVICE_ROLE_KEY` | REQUIRED_FOR_BOOT | `lib/supabase-server.ts` | same as above |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | REQUIRED_FOR_BOOT | client-side Supabase auth | validated by Supabase SDK |
| `INTEGRATIONS_ENCRYPTION_KEY` | REQUIRED_FOR_PRODUCTION | `lib/security/encryption.ts`, `lib/credentials/oauth-state.ts` | explicit `throw new Error('INTEGRATIONS_ENCRYPTION_KEY is required for encryption')` — lazy (on first credential encrypt/decrypt), not at boot; correct for a serverless-route architecture where a single eager top-level throw would crash unrelated routes |
| `REDIS_URL` | REQUIRED_FOR_PRODUCTION | `lib/runtime/redis.ts`, all of `lib/runtime/queue.ts`/`worker.ts` | `canUseRuntimeRedis()` returns `false`, `getRedisConnection()` returns `null` gracefully when absent — app boots, but async dispatch/scheduler/queue features are inert (enqueue calls report `enqueued:false`, webhook route returns 503 rather than crashing) |
| `CRON_SECRET` | REQUIRED_FOR_PRODUCTION | `app/api/cron/dispatch-schedules/route.ts`, `app/api/cron/reverify-credentials/route.ts` | explicit `500` with `{error: 'CRON_SECRET environment variable is not configured'}` if absent (verified by test) — cron routes fail closed, not open |
| `MAGICFLUX_WEBHOOK_SECRET` | OPTIONAL_PROVIDER (per-workflow override exists) | `app/api/workflows/[id]/webhook/route.ts` | falls back to `null`; a workflow can also set its own `security.webhook_secret` in `workflow_json`. If neither is set, `guardWebhookRequest` allows unsigned requests — this is a **known, pre-existing, permissive default**, not a Phase 8/8.1 regression; flagged in Step 10 |
| `RUNTIME_WORKER_ENABLED` | REQUIRED_FOR_PRODUCTION (worker process only) | `lib/runtime/worker.ts`'s `startRuntimeWorkers` | defaults to not starting workers unless `'true'` or `explicitStart` — safe default (no accidental worker startup in web processes) |
| `RUNTIME_MAX_CONCURRENT_PER_USER` | OPTIONAL_PROVIDER | `lib/runtime/concurrency-guard.ts` | defaults to `10` |
| `RUNTIME_MAX_CONCURRENT_PER_WORKFLOW` | OPTIONAL_PROVIDER | same | defaults to `3` |
| `RUNTIME_CONCURRENCY_RESERVATION_TTL_SECONDS` | OPTIONAL_PROVIDER | same | defaults to `1800` (30 min) |
| `RUNTIME_MAX_WEBHOOK_BODY_BYTES` | OPTIONAL_PROVIDER | webhook route | defaults to `1048576` (1MB) |
| `RUNTIME_MAX_INPUT_BYTES` | OPTIONAL_PROVIDER | `runtime/workflow-engine.ts` | defaults to `1048576` |
| `RUNTIME_MAX_EXECUTION_DURATION_MS` | OPTIONAL_PROVIDER | `runtime/workflow-engine.ts` | defaults to `300000` (5 min) |
| `RUNTIME_HTTP_MAX_RESPONSE_BYTES` | OPTIONAL_PROVIDER | HTTP node handler | defaults to `5242880` (5MB) |
| `RUNTIME_HTTP_ALLOW_PRIVATE_NETWORKS` | OPTIONAL_PROVIDER (dev-only escape hatch) | `lib/workflow-runtime/node-handlers/ssrf-guard.ts` | must be explicitly enabled; defaults to blocking private-network targets — **must never be `true` in production**, see Step 10 |
| `OPENAI_API_KEY` | LEGACY | some older/global fallback paths | superseded by per-user `integration_credentials` rows for the `openai` node handler in live mode; a global key is not required for the production execution path |
| `N8N_API_URL` / `N8N_API_KEY` | LEGACY | `lib/deployment/deployment-manager.ts`, `lib/runtime/worker.ts`'s legacy `deploy_workflow_to_n8n`/`activate_workflow`/`test_workflow` task types | only exercised by the pre-Phase-8 external-n8n deployment path; the Phase 8 native lifecycle (`lib/workflow/lifecycle.ts`) and Phase 8.1 async dispatch do not call n8n at all |
| `TEST_OPENAI_API_KEY`, `TEST_SLACK_BOT_TOKEN`, `TEST_GMAIL_ACCESS_TOKEN`, `TEST_AIRTABLE_TOKEN`, `TEST_AIRTABLE_BASE_ID`, `TEST_AIRTABLE_TABLE`, `TEST_SHOPIFY_ACCESS_TOKEN`, `TEST_SHOPIFY_DOMAIN`, `TEST_STRIPE_SECRET_KEY`, `TEST_TELEGRAM_BOT_TOKEN`, `TEST_TELEGRAM_CHAT_ID` | TEST_ONLY | `scripts/test-*.ts`, `scripts/smoke-test-providers.ts` | never read by `app/`, `lib/` (production route/runtime) code — confirmed via grep, only appear under `scripts/` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OPTIONAL_PROVIDER | `app/api/oauth/*`, `lib/credentials/oauth-providers.ts` | gates Google/Gmail OAuth connect only |
| `CANVA_CLIENT_ID` / `CANVA_CLIENT_SECRET` | OPTIONAL_PROVIDER | `lib/credentials/oauth-providers.ts` | Canva is not a handled node type (`HANDLER_NODE_ALLOWLIST` has no Canva entry) — this OAuth provider config exists ahead of feature support |
| `STRIPE_SECRET_KEY`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_SANDBOX` | OPTIONAL_PROVIDER | billing/payment routes | not part of the Phase 8/8.1 execution path; gates payment features only |
| `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`SMTP_FROM`/`SMTP_SECURE` | OPTIONAL_PROVIDER | email-sending node handler fallback | only used when a workflow's email node has no per-user credential attached |
| `NEXT_PUBLIC_SITE_URL` / `NEXT_PUBLIC_APP_URL` / `BASE_URL` | OPTIONAL_PROVIDER | webhook URL display (UI), deploy route | used for cosmetic/display URL construction; falls back to request `Host` header |
| `AI_PLANNER_MODE`, `STRICT_PROVIDER_MODE` / `NEXT_PUBLIC_STRICT_PROVIDER_MODE`, `ENABLE_DEV_PRO_BUTTON` / `NEXT_PUBLIC_ENABLE_DEV_PRO_BUTTON`, `DRY_RUN`, `TIERS` | OPTIONAL_PROVIDER / dev-flag | AI builder, dev tooling | feature flags, no security impact if absent |
| `NEXT_PHASE`, `NEXT_RUNTIME`, `NODE_ENV` | REQUIRED_FOR_BOOT (framework-managed) | Next.js itself, `lib/runtime/worker.ts`'s `canStartWorkers()` build-phase guard | set automatically by Next.js/Vercel, never user-configured |
| `SEED_CONFIRM`, `SEED_PREFIX`, `MF_BUILD_ISOLATE_*` | TEST_ONLY | `scripts/seed-large-dataset.ts` and isolated build-check scripts | not read by production code |

## Findings

1. **No hardcoded secret defaults found.** Every `process.env.X ?? <fallback>` pattern for a genuinely sensitive variable (`N8N_API_KEY`, `INTEGRATIONS_ENCRYPTION_KEY`, `MAGICFLUX_WEBHOOK_SECRET`) falls back to `''` or `null`, never a literal secret-shaped string.
2. **Boot-time validation is SDK-delegated, not custom, for Supabase.** `lib/supabase-server.ts` uses `!` assertions; a missing `NEXT_PUBLIC_SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` will throw from inside `@supabase/supabase-js`'s client constructor on first use, with that library's own error message — functionally explicit, but not a MagicFlux-authored message. Not a blocker; noted for completeness.
3. **Optional-provider credentials correctly never block boot** — confirmed for Redis (`canUseRuntimeRedis()`), and by construction for every per-provider OAuth/API-key variable (each only gates its own node handler / connect route).
4. **`RUNTIME_HTTP_ALLOW_PRIVATE_NETWORKS` is the one variable that is actively dangerous if misconfigured** — flagged for the Step 10 security section, not a defect in the default (which is correctly restrictive).

# MagicFlux — Production Deployment Checklist

## 0. Pre-deployment prerequisites

Before deploying, ensure you have:

- [ ] Supabase production project created
- [ ] Vercel project linked to the repository
- [ ] Google Cloud OAuth app created with production credentials (Gmail / Sheets / Drive)
- [ ] Canva Developer App created (if using the Canva integration)
- [ ] Production n8n instance accessible over HTTPS (if using the Deploy to n8n feature)
- [ ] Redis / Upstash instance URL available (required for BullMQ runtime queues)
- [ ] New `INTEGRATIONS_ENCRYPTION_KEY` generated for production (never reuse the development key)
- [ ] New `CRON_SECRET` generated for the cron route

---

## 1. Supabase: Run migrations in order

Apply all migrations via the Supabase dashboard SQL editor or `supabase db push`.
**Order is critical** — later migrations depend on tables and functions created by earlier ones.

| # | File | Purpose |
|---|------|---------|
| 1 | `20260507110000_phase5_execution_safety_observability.sql` | Execution safety tables |
| 2 | `20260507140000_phase6_event_bus_queues.sql` | Event bus and queue tables |
| 3 | `20260507180000_phase7_runtime_infra_hardening.sql` | Runtime infrastructure hardening |
| 4 | `20260508000000_phase8_autonomous_ai_builder.sql` | AI builder tables |
| 5 | `20260509090000_phase9_real_autonomous_execution_engine.sql` | Execution engine (`runtime_execution_controls`, `runtime_node_states`) |
| 6 | `20260509130000_phase10_15_runtime_hardening_security_observability.sql` | Runtime security + `runtime_execution_snapshots` |
| 7 | `20260509190000_phase16_dynamic_provider_intelligence.sql` | Provider intelligence tables |
| 8 | `20260510102000_phase16_dynamic_provider_constraint_fix.sql` | Provider constraint fix |
| 9 | `20260510123000_expand_deployment_versions_statuses.sql` | Deployment version/status fields |
| 10 | `20260510124000_add_workflow_id_to_automation_conversations.sql` | Conversation wiring |
| 11 | `20260514110000_phase17_automation_brain_capability_engine.sql` | Automation capability engine |
| 12 | `20260518000001_add_pattern_kind_classification.sql` | Pattern kind classification |
| 13 | `20260520000001_integration_credentials.sql` | Per-key credential storage + RLS |
| 14 | `20260520000002_credential_verifications.sql` | Credential health tracking |
| 15 | `20260520000003_save_credentials_with_verification_fn.sql` | Atomic credential + verification RPC |
| 16 | `20260520000004_get_stale_credential_users_fn.sql` | Cron batch user selection function |
| 17 | `20260522000001_migrate_google_oauth_credential_keys.sql` | Google credential key isolation (gmail / sheets / drive) |
| 18 | `20260522000002_ownership_rls_hardening.sql` | RLS hardening (removes `USING(true)` policies) |
| 19 | `20260522000003_workflow_deployments_rls.sql` | `workflow_deployments` table + RLS |
| 20 | `20260523000001_runtime_multitenant_hardening.sql` | Runtime UPSERT tenant isolation indexes |

All migrations are idempotent where noted (`CREATE TABLE IF NOT EXISTS`, `CREATE UNIQUE INDEX IF NOT EXISTS`).
Take a Supabase database backup before applying to a live instance.

---

## 2. Vercel: Required Environment Variables

Set all variables in **Vercel Project Settings → Environment Variables**.
Variables marked **Server** must never be assigned a `NEXT_PUBLIC_` prefix.

### Core

| Variable | Scope | Required | Notes |
|----------|-------|----------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | Client + Server | ✓ | Your Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Client + Server | ✓ | Supabase anon/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only | ✓ | Never expose to client. Do not prefix with `NEXT_PUBLIC_`. |
| `NEXT_PUBLIC_APP_URL` | Client + Server | ✓ | Production URL, e.g. `https://magicflux.ai`. **Used by OAuth start + callback for redirect URIs. Must be set separately from `NEXT_PUBLIC_SITE_URL`.** |
| `NEXT_PUBLIC_SITE_URL` | Client + Server | ✓ | Production URL (used by Stripe, PayPal, deploy routes). Set to the same value as `NEXT_PUBLIC_APP_URL`. |
| `INTEGRATIONS_ENCRYPTION_KEY` | Server only | ✓ | 64-char hex key (AES-256-GCM). **Generate a new key for production — never reuse the development key.** See §3. |
| `CRON_SECRET` | Server only | ✓ | Bearer token for Vercel cron route authentication. See §6. |

### OAuth

| Variable | Scope | Required | Notes |
|----------|-------|----------|-------|
| `GOOGLE_CLIENT_ID` | Server only | For Gmail / Sheets / Drive | From Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | Server only | For Gmail / Sheets / Drive | From Google Cloud Console |
| `CANVA_CLIENT_ID` | Server only | For Canva | From Canva Developer Portal |
| `CANVA_CLIENT_SECRET` | Server only | For Canva | From Canva Developer Portal |

### AI / Automation

| Variable | Scope | Required | Notes |
|----------|-------|----------|-------|
| `OPENAI_API_KEY` | Server only | Optional | Falls back to deterministic planner when unset |
| `AI_PLANNER_MODE` | Server only | Optional | `openai` or `deterministic` (default: `deterministic`) |

### Payments

| Variable | Scope | Required | Notes |
|----------|-------|----------|-------|
| `PAYPAL_CLIENT_ID` | Server only | For PayPal billing | PayPal REST API client ID (production app) |
| `PAYPAL_CLIENT_SECRET` | Server only | For PayPal billing | PayPal REST API client secret (production app) |
| `STRIPE_SECRET_KEY` | Server only | For Stripe billing | Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` | Server only | For Stripe webhooks | From Stripe dashboard → Webhooks |

### n8n

| Variable | Scope | Required | Notes |
|----------|-------|----------|-------|
| `N8N_API_URL` | Server only | For n8n deploy | **Must start with `https://` in production.** Enforced at runtime. |
| `N8N_API_KEY` | Server only | For n8n deploy | n8n API key with workflow + credential write access |

### Infrastructure

| Variable | Scope | Required | Notes |
|----------|-------|----------|-------|
| `REDIS_URL` | Server only | For queue features | `redis://` or `rediss://` URL (Upstash, Railway, etc.). Required for BullMQ runtime queues. |
| `RESEND_API_KEY` | Server only | For email | Resend API key for transactional email |

### Dev-only variables — MUST NOT be set in production

| Variable | Action |
|----------|--------|
| `NEXT_PUBLIC_ENABLE_DEV_PRO_BUTTON` | Remove from Vercel env vars before go-live |
| `ENABLE_DEV_PRO_BUTTON` | Remove from Vercel env vars before go-live |
| `PAYPAL_SANDBOX` | Remove or set to `false` — `true` routes payments to sandbox |

---

## 3. Critical: NEXT_PUBLIC_APP_URL

The OAuth start and callback routes construct redirect URIs using this variable:

```
${NEXT_PUBLIC_APP_URL}/api/oauth/callback
```

**This is not the same as `NEXT_PUBLIC_SITE_URL`** (used by Stripe/PayPal routes).

If `NEXT_PUBLIC_APP_URL` is not set in production:
- `POST /api/oauth/start` returns `503 { error: "APP_URL is not configured" }`
- Gmail, Google Sheets, Google Drive, and Canva OAuth flows all fail at the start step

**Action:** Set both `NEXT_PUBLIC_APP_URL` and `NEXT_PUBLIC_SITE_URL` to your production domain in Vercel.

---

## 4. Critical: INTEGRATIONS_ENCRYPTION_KEY

All OAuth tokens and API credentials stored in `integration_credentials` are encrypted at rest with AES-256-GCM using this key. The same key is used for HMAC-SHA256 signing of OAuth CSRF state tokens.

Requirements:
- Exactly **64 hexadecimal characters** (32 bytes = 256-bit key)
- **Must be different from the development key** in `.env.local`
- Generated once per environment; if rotated, all stored credentials become unreadable and users must reconnect
- Store only in Vercel env vars — never commit to git

Generate a production key:
```bash
openssl rand -hex 32
```

---

## 5. OAuth Provider Setup

### 5.1 Google Cloud Console (Gmail, Google Sheets, Google Drive)

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create or select a project
3. Enable the following APIs: **Gmail API**, **Google Sheets API**, **Google Drive API**
4. Go to **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**
5. Application type: **Web application**
6. Under **Authorized redirect URIs**, add exactly:
   ```
   https://YOUR_DOMAIN/api/oauth/callback
   ```
   where `YOUR_DOMAIN` matches the value of `NEXT_PUBLIC_APP_URL` (no trailing slash)
7. Copy **Client ID** → set as `GOOGLE_CLIENT_ID` in Vercel
8. Copy **Client secret** → set as `GOOGLE_CLIENT_SECRET` in Vercel
9. In **OAuth consent screen**: add scopes (`gmail.send`, `gmail.readonly`, `spreadsheets`, `drive`), set app status to **Published**

> One client ID/secret pair covers all three Google providers (gmail, google_sheets, google_drive).

### 5.2 Canva Developer Portal

1. Go to [www.canva.com/developers](https://www.canva.com/developers)
2. Create or select an integration app
3. Under **OAuth**, add the redirect URL:
   ```
   https://YOUR_DOMAIN/api/oauth/callback
   ```
4. Copy **Client ID** → set as `CANVA_CLIENT_ID` in Vercel
5. Copy **Client secret** → set as `CANVA_CLIENT_SECRET` in Vercel
6. Request scopes: `asset:read`, `asset:write`, `design:content:read`, `design:content:write`

---

## 6. Vercel Cron

The credential re-verifier runs daily at **03:00 UTC** and re-validates stored credentials
against each integration's real API, updating `credential_verifications` with the outcome.

`vercel.json` (already committed):
```json
{
  "crons": [
    { "path": "/api/cron/reverify-credentials", "schedule": "0 3 * * *" }
  ]
}
```

**Setup:**
1. Generate a secret: `openssl rand -hex 32`
2. Set as `CRON_SECRET` in Vercel env vars
3. Vercel automatically sends `Authorization: Bearer <CRON_SECRET>` when invoking the route
4. The route returns `500` when `CRON_SECRET` is not configured, `401` when the token is wrong

> Vercel cron is available on **Pro and above** plans.

---

## 7. Smoke Test Commands

Run after every production deploy to verify the deployment is healthy.

```bash
# 1. Runtime health check
curl -s https://YOUR_DOMAIN/api/health/runtime | jq .

# 2. OAuth start — must return { redirectUrl: "https://accounts.google.com/..." }
curl -s -X POST https://YOUR_DOMAIN/api/oauth/start \
  -H "Authorization: Bearer <USER_JWT>" \
  -H "Content-Type: application/json" \
  -d '{"provider":"gmail"}' | jq .

# 3. Cron auth check — must return processedUsers/reverifiedProviders (not 401/500)
curl -s https://YOUR_DOMAIN/api/cron/reverify-credentials \
  -H "Authorization: Bearer <CRON_SECRET>" | jq .

# 4. Authenticated workflow list — confirms Supabase connectivity
curl -s https://YOUR_DOMAIN/api/workflows \
  -H "Authorization: Bearer <USER_JWT>" | jq .

# 5. Local pre-deploy checks
npx tsc --noEmit
npm run build
npx tsx scripts/test-ownership-security.ts
npx tsx scripts/test-production-readiness.ts
```

---

## 8. Post-Deploy Checks

After each production deploy, verify manually:

- [ ] Supabase → Table Editor: all 20 migrations applied, all tables visible
- [ ] Supabase → Auth → Policies: RLS enabled on `integration_credentials`, `credential_verifications`, `workflow_executions_v2`, `runtime_execution_controls`, `runtime_node_states`, `runtime_execution_snapshots`, `workflow_deployments`
- [ ] `/api/health/runtime` returns `200`
- [ ] OAuth connect flow (Gmail) completes end-to-end: start → Google consent → callback → credential stored
- [ ] Vercel dashboard → Functions: no build errors
- [ ] Vercel dashboard → Cron Jobs: `reverify-credentials` shows as scheduled
- [ ] `NEXT_PUBLIC_ENABLE_DEV_PRO_BUTTON` is absent from production Vercel env vars
- [ ] `PAYPAL_SANDBOX` is absent or `false` in production Vercel env vars
- [ ] `N8N_API_URL` is an `https://` URL (not localhost)
- [ ] Stripe and PayPal webhook endpoints registered and pointing to `https://YOUR_DOMAIN/api/...`

---

## 9. Rollback Notes

### Application rollback
Vercel dashboard → Deployments → select previous deployment → **Promote to Production**.

### Database rollback
Migrations are not automatically reversible. Before each production deploy:
1. Supabase dashboard → Settings → Database → Backups → **Trigger backup**
2. For point-in-time recovery (requires Supabase Pro): use the PITR restore feature

### Credential key rotation
If `INTEGRATIONS_ENCRYPTION_KEY` must be rotated:
- All stored credentials become unreadable with the new key
- All users must reconnect their integrations after the rotation
- There is no automated re-encryption path
- **Do not rotate this key unless absolutely required** (e.g., security incident)

### n8n workflow rollback
Workflows deployed to n8n via the orchestrate endpoint are not removed on Vercel rollback.
Deactivate or delete stale workflows manually in your n8n instance.

---

## 10. Security Checklist

- [ ] `SUPABASE_SERVICE_ROLE_KEY` is not in any `NEXT_PUBLIC_*` variable
- [ ] `INTEGRATIONS_ENCRYPTION_KEY` is not committed to git (`git log --all -- .env .env.local`)
- [ ] RLS is enabled on all tables containing user data (check Supabase dashboard)
- [ ] `N8N_API_URL` uses HTTPS in production
- [ ] `PAYPAL_SANDBOX` is not `true`
- [ ] `/api/dev/*` routes are not accessible in production (or are behind admin auth)
- [ ] Cron route returns `401` for requests without the correct `CRON_SECRET`
- [ ] OAuth `state` tokens expire after 600 seconds (enforced in `lib/credentials/oauth-state.ts`)
- [ ] No JWT is passed via URL query parameters (`?token=` pattern absent from OAuth flow)

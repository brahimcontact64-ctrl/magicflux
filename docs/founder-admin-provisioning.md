# Founder / Admin account provisioning

## What this grants

MagicFlux has one privilege signal: `app_metadata.role === 'admin'` on a
Supabase auth user, checked server-side by `isAdminUser()`
([lib/supabase-server.ts](../lib/supabase-server.ts)). Every "Founder",
"Admin", or "Dogfood" capability in the product is this same check,
called fresh on every request — there is no cached "the admin" singleton
and no code path that treats a specific user ID, email, or name as
special. Any number of independent accounts can hold this flag at once,
and granting or revoking it for one account never affects any other. This
is pinned as an executable, CI-enforced invariant in
[tests/founder-privilege-scope.security.test.ts](../tests/founder-privilege-scope.security.test.ts).

Holding `app_metadata.role: 'admin'` grants, and *only* grants:

- Access to `/admin`, `/admin/feedback`, `/admin/beta` (gated by `middleware.ts`)
- Access to the admin API routes: `/api/admin/feedback`, `/api/admin/beta-metrics`,
  `/api/admin/dev/assign-pro`, `/api/admin/deploy`, `/api/admin/generate`, `/api/admin/requests`
- A bypass of the **commercial** daily AI token/cost cap
  (`lib/agent/safety.ts`'s `evaluateToolSafety()`)
- A bypass of the **commercial** plan limits (integrations/workflows/executions/deploy;
  `lib/billing/plan-limits.ts`'s `resolveUserPlan()` — computed per-request,
  never persisted as a fake `subscriptions` row)

It does **not**, and structurally cannot, bypass:

- Capability validation or the Code/Function node prohibition
  (`lib/workflow-runtime/node-capabilities.ts` has no reference to admin
  status at all)
- Tenant isolation (RLS + explicit `user_id` scoping on every
  `/api/workflows/*` route — none of them import `isAdminUser`)
- SSRF protection, secret redaction, or credential encryption
  (`lib/security/ssrf-guard.ts`, `redact.ts`, `encryption.ts` — none of
  them reference admin status)
- Runtime dispatch safety (mode gates, approval requirements,
  duplicate/rate-limit/loop-detection guards in `evaluateToolSafety()` —
  only the AI-cost quota check is skipped for admins; every other guard
  in that function runs identically for everyone)

`app_metadata` is writable only via the Supabase service-role Admin API —
never by a user's own session (the standard client-side
`supabase.auth.updateUser()` call can only write `user_metadata`, which
`isAdminUser()` never reads — see that function's own P0-fix comment).
So this flag cannot be self-granted by any account, no matter what that
account does with its own session.

## Granting it to a real account

This is a one-time, manual, service-role operation — not something the
app exposes to any user, including existing admins (there is no
"promote another user to admin" button anywhere in the product, and none
should be added without separately re-reviewing this document). Whoever
runs it must already hold the Supabase service-role key for this
project and must supply the **real** target account's own user ID or
email at the time they run it — never guessed, never hardcoded into this
repo.

**Option A — Supabase Dashboard** (simplest, no key handling in a shell):
Authentication → Users → select the account → Edit → the *App Metadata*
field (not *User Metadata* — that one is self-writable and must never be
used for this) → merge in:

```json
{ "role": "admin" }
```

**Option B — service-role API call**, for scripting a repeatable setup.
Replace `<PROJECT_URL>`, `<SERVICE_ROLE_KEY>`, and `<USER_ID>` with the
real values at the time you run this — none of them belong in source
control:

```bash
curl -X PUT "<PROJECT_URL>/auth/v1/admin/users/<USER_ID>" \
  -H "apikey: <SERVICE_ROLE_KEY>" \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"app_metadata": {"role": "admin"}}'
```

Repeat for as many accounts as should hold Founder access — each grant is
independent. To revoke, PUT `{"app_metadata": {"role": null}}` (or
whatever other fields that account's `app_metadata` should keep) for that
one account; no other account is affected.

## Verifying a grant

```bash
curl "<PROJECT_URL>/auth/v1/admin/users/<USER_ID>" \
  -H "apikey: <SERVICE_ROLE_KEY>" \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>" | jq .app_metadata
```

should show `{"role": "admin", ...}`. Then, signed in as that account,
`/admin` should render instead of redirecting to `/login`.

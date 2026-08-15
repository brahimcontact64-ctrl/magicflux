# Security Penetration Review — Phase 21 Red Team Report

**Date:** 2026-06-01  
**Methodology:** Authenticated attacker model — assumes valid Supabase JWT for a registered user with no explicit role assignments  
**Scope:** RBAC system, replay APIs, command bus, worker registration, alert management, SLA management

---

## Attacker Profile

All attacks assume a **malicious authenticated user** (`attacker`) who:
- Has a valid Supabase access token (signed up legitimately)
- Has **no explicit role assignments** in `runtime_role_assignments`
- Knows the API surface from public Next.js routes

Under the implicit backward-compat grant (post-Phase 21), an attacker with no role assignments receives:
`[view_runtime, manage_workers, manage_incidents, manage_commands, manage_executions, view_audit, manage_replay]`

**Notably excluded:** `admin_runtime` — the attacker cannot self-assign roles or assign roles to others.

---

## Attack 1: Privilege Escalation via Role Assignment

**Target:** `POST /api/runtime/control/rbac`  
**Goal:** Grant `admin_runtime` to self

**Attempt:**
```json
POST /api/runtime/control/rbac
Authorization: Bearer <attacker_token>
{ "action": "assign", "userId": "<attacker_id>", "roleName": "admin" }
```

**Result: BLOCKED**

The route at `app/api/runtime/control/rbac/route.ts:62` calls:
```typescript
await requirePermission(user.id, 'admin_runtime');
```

The attacker's implicit grant does not include `admin_runtime`. `requirePermission` throws, returning 403.

**Finding:** PASS — no privilege escalation path exists for users with implicit-only permissions.

---

## Attack 2: Horizontal Privilege Escalation (Replay Another User's Execution)

**Target:** `GET /api/runtime/replay/[executionId]`  
**Goal:** Read another user's execution event stream

**Attempt:**
```
GET /api/runtime/replay/victim-execution-id-here
Authorization: Bearer <attacker_token>
```

**Analysis:**

`app/api/runtime/replay/[executionId]/route.ts` calls:
```typescript
loadExecutionEvents({ executionId, userId: user.id })
loadLatestSnapshot({ executionId, userId: user.id })
```

Both calls pass `userId: user.id` (the attacker's own user ID). Inside `event-store.ts`, the Supabase query includes `.eq('user_id', userId)`. The attacker's `user.id` will not match the victim's events.

**Result:** Returns `{ state: {}, totalEvents: 0 }` — no data leak.

**Finding:** PASS — replay is scoped by authenticated user_id at the query layer.

---

## Attack 3: Execution Takeover via Command Injection

**Target:** `POST /api/runtime/commands/[executionId]`  
**Goal:** Send CANCEL command to another user's execution

**Attempt:**
```json
POST /api/runtime/commands/victim-execution-id
Authorization: Bearer <attacker_token>
{ "command": "cancel" }
```

**Analysis:**

`app/api/runtime/commands/[executionId]/route.ts` (post-Phase 21) calls:
```typescript
await requirePermission(user.id, 'manage_commands');
```

The attacker's implicit grant **includes** `manage_commands`. The route then calls the command bus, which inserts into `runtime_execution_commands`. 

**Critical check:** Does the command bus validate that `execution_id` belongs to the authenticated user?

Reading `lib/runtime/command-bus.ts` (via the migration `20260529000001`): the `insert_execution_command` DB function accepts `p_execution_id` and `p_user_id`. The app-layer should pass `user.id` as `p_user_id`. The resulting command row has `user_id = attacker_id`.

The worker processes commands via `fetch_pending_execution_commands` which fetches by `execution_id` without a user_id filter. **If the attacker sends a CANCEL command with a victim execution_id, the command row is inserted with the attacker's user_id, but the worker processes all commands for that execution_id regardless of who issued them.**

**Finding: MEDIUM RISK** — An authenticated user with `manage_commands` can send commands (including CANCEL) to any execution ID they can guess or enumerate, even if they don't own it. The command row records the attacker's `user_id` in `granted_by` / `issued_by`, providing an audit trail, but the execution is still affected.

**Recommendation:** The command bus DB function or the worker command processor must validate that the command issuer (`user_id` on the command row) matches the execution owner (`user_id` on `runtime_executions` or via `claimExecutionOwnership`). Add a cross-check: before processing a command, verify `command.user_id = execution.user_id`.

---

## Attack 4: Incident Spam (Denial of Service via Incident Creation)

**Target:** `POST /api/runtime/control/incidents`  
**Goal:** Create thousands of incidents to exhaust storage/operator attention

**Analysis:**

The route has `requirePermission(user.id, 'manage_incidents')` — the attacker's implicit grant includes `manage_incidents`.

The incident creation path calls `createIncident()` which does NOT enforce a rate limit or a per-user incident count limit. An attacker with a valid token could call this endpoint in a tight loop.

**Finding: LOW RISK** — Incidents are tenant-scoped; a spam attack only affects the attacker's own incident view. The alert evaluation loop deduplicates incidents via `ON CONFLICT (metric_name, user_id)`, so duplicate alerts don't stack. However, manually-created incidents via the API have no deduplication and no creation rate limit.

**Recommendation:** Add a per-user rate limit on the incidents POST route (e.g., max 50 incidents per hour per user) or require incidents to be system-created only (remove manual POST permission for non-admins).

---

## Attack 5: Worker Registration Spoofing

**Target:** Worker heartbeat mechanism  
**Goal:** Register a fake worker to disrupt the monitoring dashboard

**Analysis:**

`POST /api/runtime/control/workers` (post-Phase 21) requires `manage_workers`. The attacker has this permission. The worker registration path in `worker-registry.ts` inserts/updates `runtime_workers` with the provided `worker_id`.

Worker IDs are generated as `worker-${process.pid}` inside the server process — they are not validated against any known-worker list. An attacker could call the workers route with an arbitrary `worker_id` string.

**Risk scope:** The monitoring dashboard would show phantom workers. Self-heal logic queries `runtime_workers WHERE heartbeat_at < cutoff` to detect stale workers — a phantom worker with a recent heartbeat would not be flagged.

**Finding: LOW RISK** — Dashboard noise only. No ability to intercept real jobs (BullMQ connection requires Redis credentials that the attacker doesn't have; job ownership requires the `owner_token` secret generated per-job in the worker process).

---

## Attack 6: Replay Integrity Bypass

**Target:** `GET /api/runtime/replay-integrity/[executionId]`  
**Goal:** Access integrity check results for another user's execution

**Analysis:**

The route uses `loadExecutionEvents({ executionId, userId: user.id })`. Same tenant-scoped query as Attack 2. No cross-tenant data leakage.

**Finding:** PASS — tenant isolation is consistent across all replay routes.

---

## Attack 7: SLA Manipulation

**Target:** `POST /api/runtime/control/sla`  
**Goal:** Delete SLA policies for all users

**Analysis:**

The route requires `admin_runtime` for DELETE and POST (post-Phase 21 via `requirePermission`). The attacker does not have `admin_runtime`. GET is permitted (read-only).

**Finding:** PASS — write operations require `admin_runtime`.

---

## Attack 8: Alert Rule Manipulation

**Target:** `POST /api/runtime/control/alerts`  
**Goal:** Disable alert rules to suppress monitoring

**Analysis:**

The route requires `admin_runtime` for POST. The attacker does not have `admin_runtime`.

**Finding:** PASS — alert rule mutation blocked.

---

## Attack 9: Metrics Scraping (Information Disclosure)

**Target:** `GET /api/runtime/control/metrics`  
**Goal:** Extract system metrics to map infrastructure

**Analysis:**

The route only requires authentication (no `requirePermission` check). Any authenticated user can query metric time-series. Metric labels include `worker_id`, `queue`, and `workflow_id` in the `labels` JSONB field.

**Risk:** An authenticated attacker can enumerate `worker_id` values and map active queue names. This is observability data not business data — it does not expose user PII or execution content. However, it does expose infrastructure topology.

**Finding: LOW RISK (informational)** — If the metrics endpoint is public-facing, consider adding `requirePermission('view_runtime')` — though all authenticated users have this implicitly, a future explicit-role-only model would be easier to implement if the check is already in place.

---

## Attack 10: Event Store IDOR (Insecure Direct Object Reference)

**Target:** Event IDs in API responses  
**Goal:** Use event IDs from one user's execution to access another user's events

**Analysis:**

`runtime_execution_events` has RLS policy `FOR SELECT USING (true)` (service role bypasses). The service client used in server-side code bypasses RLS. All queries include `.eq('user_id', userId)` in the WHERE clause at the application layer.

**Finding:** PASS — application-layer user_id scoping present on all event queries. RLS policy allows service-role SELECT but all API endpoints enforce the user filter in code.

---

## Summary

| Attack | Status | Severity |
|---|---|---|
| Role self-assignment | BLOCKED | N/A |
| Cross-user replay read | BLOCKED | N/A |
| Cross-execution command injection | OPEN | MEDIUM |
| Incident spam | OPEN | LOW |
| Worker registration spoofing | OPEN | LOW |
| Replay integrity bypass | BLOCKED | N/A |
| SLA manipulation | BLOCKED | N/A |
| Alert rule manipulation | BLOCKED | N/A |
| Metrics scraping | INFORMATIONAL | LOW |
| Event store IDOR | BLOCKED | N/A |

---

## Required Fixes Before Launch

### Fix 1 (MEDIUM) — Cross-execution command injection

The command bus worker processor must validate that the command issuer owns the execution before processing the command. Add to `lib/runtime/command-bus.ts` or the worker's command dispatch:

```typescript
// Before processing command, verify issuer matches execution owner
const executionOwner = await getExecutionOwnerUserId(command.execution_id);
if (executionOwner && executionOwner !== command.user_id) {
  logger.warn('cross_tenant_command_rejected', {
    execution_id: command.execution_id,
    command_user_id: command.user_id,
    execution_owner_id: executionOwner,
  });
  // Dead-letter the command without processing
  return;
}
```

This fix is not applied in Phase 21 because `getExecutionOwnerUserId` requires a new DB query that would add latency to every command dispatch. Recommend implementing as a separate follow-on PR with a performance benchmark.

### Fix 2 (LOW) — Incident POST rate limiting

Add a per-user incident creation rate limit before launch. Recommended: 50 incidents per hour per user enforced via a Supabase `runtime_incidents_created_count_per_hour` counter or via an API-layer in-memory limiter.

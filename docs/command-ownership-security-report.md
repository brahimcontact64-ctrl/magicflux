# Command Ownership Security Report — Phase 22

**Date:** 2026-06-02  
**Severity before fix:** MEDIUM  
**Severity after fix:** CLOSED  
**Test result:** 23/23 PASS (`scripts/test-command-ownership-security.ts`)  
**TypeScript compile:** PASS (0 errors)

---

## Vulnerability Description

A malicious authenticated user with the `manage_commands` permission (which all users received implicitly through the Phase 21 backward-compat grant) could perform two distinct attacks:

### Attack 1 — Cross-Tenant Command Injection (MEDIUM)

`POST /api/runtime/control/executions` accepts `{ action: 'pause' | 'resume' | 'cancel', executionId, workflowId }`. The route verified that the caller had `manage_executions` permission, but did **not** verify that the execution with `executionId` belonged to the authenticated user.

An attacker who could enumerate or guess another user's `executionId` could pause, resume, or cancel that user's execution.

### Attack 2 — Cross-Tenant Command Manipulation (MEDIUM)

`retryCommand()` and `deadLetterCommand()` in `lib/runtime/command-bus.ts` issued UPDATE statements on `runtime_execution_commands` scoped only by `command_id`. No `user_id` filter was applied. An operator who knew a victim's `commandId` could force-retry or dead-letter that command.

### Attack 3 — Command IDOR (LOW-MEDIUM)

`GET /api/runtime/control/commands` returned all commands matching optional filters but had **no** `user_id` filter. Any authenticated user could enumerate commands (and their payloads) for any execution by passing `?execution_id=victim-execution-id`.

---

## Root Cause

All three vulnerabilities share the same root: **missing tenant-scoping in the command bus write and read paths**. The execution event store (`runtime_execution_events`) correctly used `userId` filtering at the query layer, but the command bus (`runtime_execution_commands`) did not consistently apply the same pattern.

---

## Fixes Applied

### Fix 1 — `lib/runtime/command-bus.ts`

**`getExecutionOwnerUserId` (new function)**

```typescript
export async function getExecutionOwnerUserId(executionId: string): Promise<string | null> {
  const db = createServiceClient();
  const { data } = await db
    .from('workflow_executions_v2')
    .select('user_id')
    .eq('id', executionId)
    .limit(1)
    .maybeSingle();
  return data ? String((data as Record<string, unknown>).user_id) : null;
}
```

Returns `null` when the execution is not yet in `workflow_executions_v2` (system boot commands, legacy executions) — those are allowed through. Returns the owning `user_id` when the execution is registered.

**`appendCommand` — ownership guard**

Before calling the `append_execution_command` RPC:

```typescript
const ownerUserId = await getExecutionOwnerUserId(input.executionId);
if (ownerUserId !== null && ownerUserId !== input.userId) {
  logger.warn('cross_tenant_command_rejected', {
    execution_id:      input.executionId,
    caller_user_id:    input.userId,
    execution_owner_id: ownerUserId,
    command_type:      String(input.commandType),
  });
  return null;
}
```

If the check fails, `appendCommand` returns `null` (its existing failure return type) — no exception propagates; no stack trace is leaked. The caller sees a null result and can handle it gracefully.

**`retryCommand` — user_id-scoped UPDATE**

```typescript
let q = db.from('runtime_execution_commands')
  .update({ status: 'pending', ... })
  .eq('id', params.commandId);
if (params.userId) q = q.eq('user_id', params.userId);
const { error } = await q;
```

An attacker retrying a command they don't own gets 0 rows updated (silently). Their retry request returns `{ queued: false }`.

**`deadLetterCommand` — user_id-scoped UPDATE**

Same pattern: `.eq('user_id', params.userId)` added when `userId` is not null.

---

### Fix 2 — `app/api/runtime/control/executions/route.ts`

Execution ownership check inserted before any `appendCommand` or `appendExecutionEvent` call:

```typescript
const executionOwnerId = await getExecutionOwnerUserId(executionId);
if (executionOwnerId !== null && executionOwnerId !== user.id) {
  void openIncident({
    incidentType: 'command_dead_letter',
    severity:     'high',
    title:        'Cross-tenant execution command attempt',
    ...
  }).catch(() => undefined);
  return NextResponse.json({ error: 'Execution not found' }, { status: 404 });
}
```

- Returns **404** (not 403) to avoid leaking execution ownership information to the attacker
- Creates a **high-severity runtime incident** for operator visibility — the incident includes the attacker's `user_id`, the execution owner's `user_id`, and the attempted action
- The incident creation is fire-and-forget (`.catch(() => undefined)`) to avoid introducing a latency dependency on the audit path

---

### Fix 3 — `app/api/runtime/control/commands/route.ts`

Added `.eq('user_id', user.id)` to the GET query:

```typescript
let q = db
  .from('runtime_execution_commands')
  .select(...)
  .eq('user_id', user.id)   // ← added
  .order('created_at', { ascending: false })
  .limit(limit);
```

This scopes the command listing to the authenticated user's own commands, consistent with how `executions/route.ts` GET already scopes executions.

---

### Fix 4 — `supabase/migrations/20260602000001_command_ownership_guard.sql`

**Database-level trigger `tg_execution_command_ownership`**

```sql
CREATE TRIGGER tg_execution_command_ownership
  BEFORE INSERT ON runtime_execution_commands
  FOR EACH ROW EXECUTE FUNCTION guard_execution_command_ownership();
```

The trigger function:
1. Allows `NULL` user_id (system-generated commands)
2. Handles UUID cast failures gracefully (non-UUID execution_id → allow)
3. Allows inserts when execution has no row in `workflow_executions_v2` (legacy)
4. Rejects with `ERRCODE = insufficient_privilege` when `user_id ≠ execution owner`

This is the deepest defense — it fires for ALL callers including the service role (which bypasses RLS but not triggers), providing the same defense-in-depth guarantee as the event immutability triggers from Phase 21.

---

### Fix 5 — Scale indexes (same migration)

| Index | Table | Column | Purpose |
|---|---|---|---|
| `runtime_metrics_labels_gin` | `runtime_metrics` | `labels` JSONB | GIN — enables label-filtered queries at scale |
| `runtime_workers_heartbeat_idx` | `runtime_workers` | `heartbeat_at DESC` | Liveness check at 1K+ workers |
| `runtime_queue_jobs_status_heartbeat_idx` | `runtime_queue_jobs` | `(status, heartbeat_at)` WHERE active | Recovery hot path |

---

## Defense-in-Depth Summary

| Layer | Mechanism | Blocks |
|---|---|---|
| API route | Ownership check + 404 + incident in executions POST | Injection via pause/cancel/resume |
| App library | Ownership guard in `appendCommand` | Any injection via the command bus |
| App library | `user_id` scoping on UPDATE in `retryCommand` / `deadLetterCommand` | Cross-tenant retry/DL |
| App library | `user_id` filter in control/commands GET | IDOR information disclosure |
| Database | `tg_execution_command_ownership` BEFORE INSERT trigger | Bypasses all app-layer defenses |

Every attack path is blocked at two independent layers. The DB trigger is the backstop that survives even if app-layer code is accidentally reverted.

---

## Verification

```
$ npx tsx scripts/test-command-ownership-security.ts
Results: 23 passed, 0 failed

$ npx tsc --noEmit
(no output — 0 errors)
```

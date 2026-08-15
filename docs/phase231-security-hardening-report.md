# Phase 23.1 Security Hardening Report

**Date:** 2026-06-01
**TypeScript compile:** PASS (0 errors)
**Security tests:** 58/58 PASS (`scripts/test-phase231-security.ts`)

---

## Scope

Targeted patch addressing four findings from the Phase 23 independent audit. No architectural changes. No business logic changes. No migrations touched. No RLS changes. No RBAC permission changes.

---

## Files Changed

| File | Finding | Change |
|---|---|---|
| `lib/runtime/incident-manager.ts` | F1 | Sequential incident ownership check before event fetch |
| `app/api/runtime/control/traces/route.ts` | F2, F4 | Sequential trace ownership check before span fetch; single permission lookup |
| `app/api/runtime/control/workers/route.ts` | F3, F4 | Strip `requested_by` for non-admins; single permission lookup |
| `app/api/runtime/control/incidents/route.ts` | F4 | Single permission lookup |
| `app/api/runtime/control/overview/route.ts` | F4 | Single permission lookup |
| `app/api/runtime/control/operator-actions/route.ts` | F4 | Single permission lookup |
| `app/api/runtime/control/metrics/route.ts` | F4 | Single permission lookup (two `requirePermission` calls collapsed to one `getUserPermissions`) |
| `app/api/runtime/control/cost/route.ts` | F4 | Single permission lookup |
| `app/api/runtime/control/stream/route.ts` | F4 | Single permission lookup |

---

## F1 — Incident Events Timing Oracle

**File:** `lib/runtime/incident-manager.ts`

**Before:**
```typescript
const [incidentRes, eventsRes] = await Promise.all([
  incidentQ.maybeSingle(),
  db.from('runtime_incident_events').select('*').eq('incident_id', incidentId)...
]);
if (!incidentRes.data) return null;
// eventsRes fetched unconditionally — timing oracle for cross-tenant IDs
```

**After:**
```typescript
const incidentRes = await incidentQ.maybeSingle();
if (!incidentRes.data) return null;
// Ownership confirmed. Now load events.
const eventsRes = await db.from('runtime_incident_events').select('*').eq('incident_id', incidentId)...
```

`runtime_incident_events` is never queried unless the caller owns the incident. Response shape (`{ incident, incidentEvents }`) is unchanged.

---

## F2 — Trace Spans Timing Oracle

**File:** `app/api/runtime/control/traces/route.ts`

**Before:**
```typescript
const [traceRes, spansRes] = await Promise.all([
  traceQ.maybeSingle(),
  db.from('runtime_spans').select('*').eq('trace_id', id)...
]);
if (!traceRes.data) { return 404; }
// spansRes fetched unconditionally (up to 500 rows)
```

**After:**
```typescript
const traceRes = await traceQ.maybeSingle();
if (!traceRes.data) { return 404; }
// Ownership confirmed. Now load spans.
const spansRes = await db.from('runtime_spans').select('*').eq('trace_id', id)...
```

`runtime_spans` is never queried unless the caller owns the trace. Response shape (`{ trace, spans }`) is unchanged.

---

## F3 — `requested_by` Hidden for Non-Admin Users

**File:** `app/api/runtime/control/workers/route.ts`

**Before:**
```typescript
restartRequests: restartRequestsRes.data ?? [],
// requested_by (another user's UUID) visible to all view_runtime callers
```

**After:**
```typescript
const rawRequests = (restartRequestsRes.data ?? []) as Array<Record<string, unknown>>;
const restartRequests = isAdmin
  ? rawRequests
  : rawRequests.map(({ requested_by: _rb, ...rest }) => rest);
```

Admin callers receive the full record including `requested_by`. Non-admin callers receive the record with `requested_by` removed. The DB query is unchanged — `requested_by` is still selected (kept for the admin path); it is stripped in application code before serialization.

---

## F4 — Single Permission Lookup Per Request

**Affected routes:** incidents, overview, operator-actions, metrics, traces, cost, stream, workers (8 routes)

**Before (example pattern):**
```typescript
// DB call 1: getUserPermissions via requirePermission
try {
  await requirePermission(user.id, 'view_runtime');   // → getUserPermissions → 3 DB queries
} catch {
  return 403;
}
// DB call 2: getUserPermissions again via hasPermission
const isAdmin = await hasPermission(user.id, 'admin_runtime');  // → getUserPermissions → 3 more DB queries
```

**After:**
```typescript
// DB call: getUserPermissions exactly once
const perms = await getUserPermissions(user.id);
if (!perms.includes('view_runtime') && !perms.includes('admin_runtime')) {
  return 403;
}
const isAdmin = perms.includes('admin_runtime');
```

Authorization behavior is identical:
- `requirePermission('view_runtime')` → `perms.includes('view_runtime') || perms.includes('admin_runtime')` — the admin bypass is preserved inline.
- `hasPermission('admin_runtime')` → `perms.includes('admin_runtime')` — same result, no extra DB call.

**DB query reduction:** From 6 queries per request (3+3) to 3 queries per request (1 getUserPermissions call = at most 3 queries against role_assignments, role_permissions, permissions).

**Special case — metrics route:** Previously made two separate `requirePermission` calls (`view_runtime` then `admin_runtime` inside the `?snapshot=true` branch). Both are now served from the single `perms` array fetched at the start of the handler.

**POST handlers unchanged:** All write endpoints (`manage_workers`, `manage_incidents`, etc.) continue using `requirePermission` as before — POST handlers do not call `hasPermission` and had no double-lookup issue.

---

## Test Evidence

```
$ npx tsx scripts/test-phase231-security.ts

[PASS] F1 incident-timing      (3 tests)
[PASS] F2 trace-timing         (3 tests)
[PASS] F3 requested_by         (4 tests)
[PASS] F4 single-perm-lookup  (48 tests — 6 per route × 8 routes)

Results: 58 passed, 0 failed

$ npx tsc --noEmit
(0 errors)
```

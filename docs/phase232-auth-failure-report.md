# Phase 23.2 Auth Failure Handling Report

**Date:** 2026-06-01
**TypeScript compile:** PASS (0 errors)
**Tests:** 56/56 PASS (`scripts/test-phase232-auth-failure.ts`)

---

## Scope

Minimal reliability patch for all 8 GET routes modified in Phase 23.1. Addresses the single behavioral difference identified by the Phase 23.1 independent audit: a DB/Supabase failure inside `getUserPermissions()` now returns `503 Service Unavailable` instead of propagating an unhandled exception (which would produce a `500` from the framework).

No architectural changes. No RBAC changes. No business logic changes. No migrations. No RLS changes. No POST handlers touched.

---

## Files Changed

| File | Change |
|---|---|
| `app/api/runtime/control/incidents/route.ts` | `.catch(() => null)` + 503 guard |
| `app/api/runtime/control/workers/route.ts` | `.catch(() => null)` + 503 guard |
| `app/api/runtime/control/overview/route.ts` | `.catch(() => null)` + 503 guard |
| `app/api/runtime/control/operator-actions/route.ts` | `.catch(() => null)` + 503 guard |
| `app/api/runtime/control/metrics/route.ts` | `.catch(() => null)` + 503 guard |
| `app/api/runtime/control/traces/route.ts` | `.catch(() => null)` + 503 guard |
| `app/api/runtime/control/cost/route.ts` | `.catch(() => null)` + 503 guard |
| `app/api/runtime/control/stream/route.ts` | `.catch(() => null)` + 503 guard |

---

## Change Pattern

The same two-line addition was applied to every route. Before:

```typescript
const perms = await getUserPermissions(user.id);
if (!perms.includes('view_runtime') && !perms.includes('admin_runtime')) {
  return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
}
```

After:

```typescript
const perms = await getUserPermissions(user.id).catch(() => null);
if (!perms) {
  return NextResponse.json({ error: 'Authorization service unavailable' }, { status: 503 });
}
if (!perms.includes('view_runtime') && !perms.includes('admin_runtime')) {
  return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
}
```

`stream/route.ts` uses the same pattern with `new Response(JSON.stringify(...), { status: 503 })` to match its existing response style.

---

## Behavior

| Scenario | Before Phase 23.2 | After Phase 23.2 |
|---|---|---|
| Normal request, permissions load | 200 / 403 as before | 200 / 403 — unchanged |
| DB failure inside `getUserPermissions` | 500 (unhandled throw) | 503 `{ "error": "Authorization service unavailable" }` |
| Supabase timeout | 500 (unhandled throw) | 503 |
| Permission denied (normal) | 403 | 403 — unchanged |
| Admin bypass preserved | Yes | Yes — unchanged |
| Single permission lookup | Yes | Yes — `.catch()` does not add a second call |

---

## Test Evidence

```
$ npx tsx scripts/test-phase232-auth-failure.ts

[PASS] auth-failure incidents/route.ts       (7 tests)
[PASS] auth-failure workers/route.ts         (7 tests)
[PASS] auth-failure overview/route.ts        (7 tests)
[PASS] auth-failure operator-actions/route.ts (7 tests)
[PASS] auth-failure metrics/route.ts         (7 tests)
[PASS] auth-failure traces/route.ts          (7 tests)
[PASS] auth-failure cost/route.ts            (7 tests)
[PASS] auth-failure stream/route.ts          (7 tests)

Results: 56 passed, 0 failed

$ npx tsc --noEmit
(0 errors)
```

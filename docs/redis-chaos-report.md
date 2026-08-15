# Redis Failure Chaos Report — Phase 21

**Date:** 2026-06-01  
**Scope:** `lib/runtime/redis.ts`, `lib/runtime/queue.ts`, `lib/runtime/worker.ts`  
**Test script:** `scripts/redis-chaos-test.ts`  
**Result: 32/32 PASS**

---

## Executive Summary

All ten Redis failure scenarios are handled correctly. The runtime degrades gracefully when Redis is unavailable rather than crashing, and reconnects safely without causing thundering herds. No unhandled rejections exist in any Redis-facing code path.

---

## Scenario Results

### 1. Redis unavailable at startup — PASS

**Code path:** `canUseRuntimeRedis()` in `lib/runtime/redis.ts`

The function performs four guards in sequence before returning `true`:
1. `typeof window === 'undefined'` — rejects browser context
2. `process.env.NEXT_RUNTIME === 'edge'` — rejects Vercel edge runtime (no `net` module)
3. `isBuildPhase()` — rejects `NEXT_PHASE=phase-production-build` and `npm_lifecycle_event=build`
4. `Boolean(process.env.REDIS_URL)` — rejects missing URL

`startRuntimeWorkers()` in `worker.ts` calls `canStartWorkers()` (which wraps `canUseRuntimeRedis()`) and returns `[]` immediately. If a Redis connection is returned as `null`, a second guard returns `[]` before any BullMQ `Worker` is created. No exception propagates to the caller.

### 2. Redis unavailable during enqueue — PASS

**Code path:** `enqueueRuntimeJob()` in `lib/runtime/queue.ts`

When `isQueueEnabled()` returns false:
- An `execution.failed` runtime event is emitted with reason `"Queue subsystem disabled (REDIS_URL missing)"` so the operator has observability
- Returns `{ enqueued: false, queueJobId, reason }` — does not throw

The calling code in agent/executor.ts can inspect `enqueued` and handle the degradation path without a try/catch. No silent data loss.

### 3. Reconnect storm protection — PASS

**Code path:** `getRedisConnection()` in `lib/runtime/redis.ts`

```typescript
retryStrategy: (attempt: number) => {
  const base = Math.min(1000 * 2 ** Math.min(attempt, 8), 30_000);
  return base;
}
```

- Exponential back-off: 1s → 2s → 4s → 8s → 16s → 30s (capped)
- Exponent is capped at `Math.min(attempt, 8)` preventing integer overflow
- Cap of 30 000ms prevents reconnect storms at steady state
- `maxRetriesPerRequest: null` lets BullMQ manage its own retry lifecycle without ioredis interrupting inflight commands

### 4. Transient error classification — PASS

All three Redis-facing modules (`redis.ts`, `queue.ts`, `worker.ts`) distinguish transient from non-transient errors:

```typescript
const isTransient = message.includes('ECONNRESET')
                 || message.includes('ECONNABORTED')
                 || message.includes('ECONNREFUSED');
logger[isTransient ? 'warn' : 'error'](eventName, { error: message });
```

Transient errors (network-level disconnects) produce `warn` log lines that are expected during rolling restarts and Redis failover. Non-transient errors (unexpected protocol errors, auth failures) produce `error` log lines that alert on-call.

### 5. BullMQ worker error handling — PASS

`worker.on('error', ...)` is registered on every BullMQ Worker instance. Without this handler, Node.js would throw an uncaught `error` event and crash the process. The handler logs using the structured logger with `{ queue, error }` context and does not re-throw, allowing BullMQ to handle its own reconnect lifecycle.

### 6. Queue events error handling — PASS

`events.on('error', ...)` is registered on every `QueueEvents` instance, using the same transient/non-transient classification. The `QueueEvents` socket maintains a separate ioredis connection used for real-time job completion callbacks; without this handler a SIGTERM-time disconnect would crash.

### 7. Drain signal during disconnect — PASS

The drain check order is:
1. `isWorkerDrainingInMemory(workerId)` — no I/O, survives Redis being down
2. `getDrainCache(workerId)` — process-level cache
3. Redis lookup (only if cache miss)

When Redis is down, a draining worker correctly stops accepting new jobs because the in-memory flag is checked first. Jobs already picked up are requeued via `throw new Error('...requeueing job')` — BullMQ moves them back to the queue rather than silently dropping them.

### 8. Dead-letter on unrecoverable errors — PASS

Two conditions use `BullUnrecoverableError` (which tells BullMQ not to retry):
- Execution isolated by self-healing system
- Workflow has a quarantined node

For all other failures, a normal `throw` causes BullMQ to retry up to `attempts` times with exponential backoff. Jobs that exhaust all attempts are moved to the BullMQ failed set and a `deadLetterExecutionCommands` call clears the command bus for that execution.

### 9. Build-phase guard — PASS

`canUseRuntimeRedis()` short-circuits during `NEXT_PHASE=phase-production-build` and during `npm run build`. `canStartWorkers()` in `worker.ts` independently checks `NEXT_PHASE`. Neither file imports ioredis at module load time — the import is dynamic (`await import('ioredis')`), so ioredis is never bundled into the Next.js build output.

### 10. Shutdown hook — PASS

On first Redis connection creation, `registerShutdownHooks()` is called once (idempotent via flag). The hook handles `SIGINT`, `SIGTERM`, and `beforeExit`, calling `client.quit()` on every open connection and then clearing the `redisClients` map. This prevents connection leaks during Vercel function warm-down and local dev `Ctrl-C`.

---

## Risk Summary

| Risk | Status | Evidence |
|---|---|---|
| Redis down crashes app at startup | Mitigated | `canUseRuntimeRedis()` guards all entry points |
| Redis down causes unhandled promise rejection | Mitigated | `enqueueRuntimeJob` returns `enqueued:false`; no throw |
| Reconnect storms on Redis restart | Mitigated | Exponential backoff capped at 30s |
| Unhandled error events crash Node process | Mitigated | `.on('error')` registered on all BullMQ Worker and QueueEvents instances |
| Jobs silently dropped during drain | Mitigated | Drain throws to requeue; in-memory flag survives Redis outage |
| Unrecoverable jobs retry forever | Mitigated | `BullUnrecoverableError` used for isolated/quarantined paths |
| ioredis imported during Next.js build | Mitigated | Dynamic import only; not in build bundle |
| Connection leak on process exit | Mitigated | `SIGINT`/`SIGTERM`/`beforeExit` hooks call `quit()` on all clients |

---

## Remaining Recommendations

1. **Alerting:** Add a Grafana alert when `getRedisStatus()` returns `'error'` for more than 60 seconds. The code supports this via the `/api/runtime/control/overview` health endpoint.
2. **Dead-letter monitoring:** The BullMQ failed set depth is not currently surfaced as a metric. Consider adding `failed_jobs_depth` to the metrics snapshot in `metrics-engine.ts`.
3. **pg_cron fallback:** If Redis is permanently removed, `enqueueRuntimeJob` always returns `enqueued:false`. In that scenario, the retention API route at `/api/runtime/control/retention` (using pg_cron or the scheduled API) still operates independently since it calls Supabase RPCs directly without Redis.

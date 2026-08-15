# Structured Logging Migration Report — Phase 21

**Date:** 2026-06-01  
**Files changed:** `lib/runtime/logger.ts` (created), `lib/runtime/worker.ts`, `lib/runtime/queue.ts`, `lib/runtime/redis.ts`

---

## Problem

Prior to Phase 21, all logging in the runtime subsystem used unstructured `console.log`, `console.warn`, and `console.error` calls. These produced flat text strings with no machine-readable fields. In production, correlation IDs, execution IDs, and worker IDs were embedded inside string interpolations, making it impossible to:

- Filter logs by `execution_id` or `worker_id` in Datadog / Logtail / CloudWatch
- Set up structured log-based alerts
- Correlate a failure across `worker.ts`, `queue.ts`, and `redis.ts`

Grep evidence of the pre-migration state (from Phase 20 observability audit):
- `lib/runtime/worker.ts` — 15 `console.*` calls
- `lib/runtime/queue.ts` — 2 `console.*` calls
- `lib/runtime/redis.ts` — 1 `console.*` call

---

## Solution

### `lib/runtime/logger.ts` (new file)

A minimal structured logger that emits JSON lines to stdout (info/debug) and stderr (warn/error). Each line is a single JSON object:

```json
{ "level": "warn", "event": "lease_renewal_lag", "ts": "2026-06-01T03:12:44.123Z",
  "execution_id": "abc123", "worker_id": "worker-42", "miss_count": 3 }
```

**Fields always present:** `level`, `event`, `ts`  
**Optional context fields:** `correlation_id`, `execution_id`, `worker_id`, `user_id`, `queue`, `job_id`, `workflow_id`  

The logger is `server-only` (enforced by the `import 'server-only'` directive at line 1). It cannot be imported by client components.

---

## Changes per File

### `lib/runtime/redis.ts`

| Before | After |
|---|---|
| `console.warn('Redis connection error:', message)` | `logger.warn('redis_connection_error', { key, error: message })` |

One change. The event name `redis_connection_error` is now queryable as a structured field.

---

### `lib/runtime/queue.ts`

| Location | Before | After |
|---|---|---|
| Queue `.on('error')` handler | `console.[warn\|error](...)` | `logger[isTransient ? 'warn' : 'error']('queue_error', { queue, error })` |
| QueueEvents `.on('error')` handler | `console.[warn\|error](...)` | `logger[isTransient ? 'warn' : 'error']('queue_events_error', { queue, error })` |

Two changes. Transient vs non-transient classification preserved; now machine-readable.

---

### `lib/runtime/worker.ts`

15 console calls replaced. All use the structured logger with context appropriate to the call site:

| Event name | Level | Context fields |
|---|---|---|
| `ownership_validation_failed` | warn | `execution_id`, `reason`, `op` |
| `split_brain_prevented` | warn | `execution_id`, `worker_id` |
| `drain_cache_hit` | debug | `worker_id`, `source` (`'memory'` or `'cache'`), optionally `value` |
| `drain_cache_miss` | debug | `worker_id` |
| `isolation_cache_hit` | debug | `execution_id`, `value` |
| `isolation_cache_miss` | debug | `execution_id` |
| `quarantine_cache_hit` | debug | `workflow_id`, `target`, `value` |
| `quarantine_cache_miss` | debug | `workflow_id`, `target` |
| `drain_signal_received` | info | `worker_id`, `job_id`, `queue` |
| `execution_isolated` | warn | `execution_id`, `worker_id`, `queue` |
| `node_quarantined` | warn | `workflow_id`, `tool`, `queue` |
| `lease_renewal_lag` | warn | `execution_id`, `worker_id`, `miss_count` |
| `stale_executor_aborted` | warn | `execution_id`, `worker_id`, `reason` |
| `stale_executor_aborted` (ownership) | warn | `execution_id`, `worker_id`, `reason`, `queue` |
| `worker_error` | warn/error | `queue`, `error` |

---

## Verification

After migration:

```
$ grep -n "console\." lib/runtime/worker.ts lib/runtime/queue.ts lib/runtime/redis.ts
(no output)
```

Zero raw console calls remain in any of the three files.

---

## Integration with Log Aggregators

JSON lines written to stdout are picked up automatically by:
- **Vercel** — structured log fields appear in the Vercel Log Explorer
- **Datadog** — with the `dd-trace` auto-instrumentation, `level` and `event` become indexed facets
- **CloudWatch** — JSON lines are parsed natively by CloudWatch Logs Insights

No changes to the hosting environment are required. The JSON format is forward-compatible: adding new context fields to a logger call does not break existing log queries.

---

## Remaining Work

- `lib/runtime/event-store.ts`, `lib/runtime/incident-manager.ts`, and the alert evaluation loop do not yet use the structured logger. They have no `console.*` calls today (they are silent on success), but adding `logger.debug` at key steps would improve observability under the 68/100 score identified in Phase 20.
- Debug-level logs are currently always emitted. A `LOG_LEVEL` environment variable check could suppress debug output in production to reduce log volume.

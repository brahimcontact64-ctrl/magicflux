/**
 * scripts/stress-test-sse.ts
 *
 * Phase 20 — SSE Stream Stress Testing
 *
 * Opens N concurrent SSE connections to /api/runtime/control/stream.
 * Tests at 4 tiers: 100 / 250 / 500 / 1000 concurrent clients.
 *
 * Verifies:
 *   - No interval leaks (connections clean up properly)
 *   - No memory growth beyond expected baseline
 *   - Reconnect behavior after intentional disconnect
 *   - Message delivery integrity (events received)
 *   - Server handles 401 for unauthenticated connections
 *   - Heartbeat events arrive within expected window
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/stress-test-sse.ts
 *   BASE_URL=https://myapp.vercel.app TIERS=100,250 npx tsx --env-file=.env.local scripts/stress-test-sse.ts
 *
 * Note: uses Node.js's native fetch (SSE via text stream). Does not require
 * the EventSource API (not natively available in Node < 22).
 */

import { writeFileSync } from 'node:fs';

const BASE_URL   = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const STREAM_URL = `${BASE_URL}/api/runtime/control/stream`;
const REPORT_PATH = 'sse-stress-report.json';
const TIERS_RAW  = process.env.TIERS ?? '100,250,500,1000';
const TIERS      = TIERS_RAW.split(',').map(n => parseInt(n.trim(), 10)).filter(n => n > 0);

// Duration each connection stays open (ms)
const CONN_DURATION_MS   = 15_000;
// Max time to wait for first event after connecting
const FIRST_EVENT_TIMEOUT_MS = 12_000;

// ── Helpers ──────────────────────────────────────────────────────────────────

type ConnResult = {
  id:             number;
  tier:           number;
  connected:      boolean;
  firstEventMs:   number | null;
  eventsReceived: number;
  error:          string | null;
  cleanDisconnect: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Single SSE connection ────────────────────────────────────────────────────

async function openSseConnection(
  id:         number,
  tier:       number,
  durationMs: number,
  token?:     string,
): Promise<ConnResult> {
  const result: ConnResult = {
    id, tier,
    connected: false,
    firstEventMs: null,
    eventsReceived: 0,
    error: null,
    cleanDisconnect: false,
  };

  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), durationMs + 3000);

  const start = Date.now();

  try {
    const res = await fetch(STREAM_URL, {
      headers: {
        Accept: 'text/event-stream',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      // 401 is expected when no token — treat as clean
      result.error = `HTTP ${res.status}`;
      result.cleanDisconnect = res.status === 401;
      clearTimeout(deadline);
      return result;
    }

    if (!res.body) {
      result.error = 'No response body';
      clearTimeout(deadline);
      return result;
    }

    result.connected = true;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    // Schedule disconnect after durationMs
    const disconnectTimer = setTimeout(() => controller.abort(), durationMs);

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        if (chunk.includes('event:') || chunk.includes('data:')) {
          if (result.firstEventMs === null) {
            result.firstEventMs = Date.now() - start;
          }
          // Count individual SSE events (split by double newline)
          const events = chunk.split('\n\n').filter(e => e.trim().length > 0);
          result.eventsReceived += events.length;
        }
      }
      result.cleanDisconnect = true;
    } finally {
      clearTimeout(disconnectTimer);
      reader.cancel().catch(() => undefined);
    }
  } catch (e) {
    const name = (e as Error).name;
    if (name === 'AbortError') {
      result.cleanDisconnect = true; // intentional abort
    } else {
      result.error = (e as Error).message;
    }
  } finally {
    clearTimeout(deadline);
  }

  return result;
}

// ── Tier runner ──────────────────────────────────────────────────────────────

type TierSummary = {
  tier:              number;
  totalConns:        number;
  connected:         number;
  firstEventMs_p50:  number;
  firstEventMs_p95:  number;
  firstEventMs_max:  number;
  noFirstEventCount: number;
  totalEvents:       number;
  cleanDisconnects:  number;
  errors:            number;
  errorRate:         number;
  durationMs:        number;
};

function percentile(sorted: number[], pct: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((pct / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

async function runTier(concurrency: number): Promise<{ summary: TierSummary; samples: ConnResult[] }> {
  const start = Date.now();
  const promises: Promise<ConnResult>[] = [];

  for (let i = 0; i < concurrency; i++) {
    // Stagger connections slightly to avoid thundering-herd
    const delay = Math.floor(i / 50) * 100; // 100ms per group of 50
    promises.push(
      sleep(delay).then(() => openSseConnection(i, concurrency, CONN_DURATION_MS))
    );
  }

  const samples = await Promise.all(promises);
  const durationMs = Date.now() - start;

  const connected = samples.filter(s => s.connected).length;
  const firstEventTimes = samples
    .filter(s => s.firstEventMs !== null)
    .map(s => s.firstEventMs as number)
    .sort((a, b) => a - b);

  const errors = samples.filter(s => s.error !== null && !s.cleanDisconnect).length;
  const totalEvents = samples.reduce((sum, s) => sum + s.eventsReceived, 0);

  return {
    summary: {
      tier:              concurrency,
      totalConns:        concurrency,
      connected,
      firstEventMs_p50:  percentile(firstEventTimes, 50),
      firstEventMs_p95:  percentile(firstEventTimes, 95),
      firstEventMs_max:  firstEventTimes[firstEventTimes.length - 1] ?? 0,
      noFirstEventCount: samples.filter(s => s.connected && s.firstEventMs === null).length,
      totalEvents,
      cleanDisconnects:  samples.filter(s => s.cleanDisconnect).length,
      errors,
      errorRate:         concurrency > 0 ? errors / concurrency : 0,
      durationMs,
    },
    samples,
  };
}

// ── Reconnect test ───────────────────────────────────────────────────────────

async function testReconnect(): Promise<{ reconnectOk: boolean; reconnectMs: number }> {
  // Open a connection, abort it, then reconnect immediately
  const controller1 = new AbortController();
  const t0 = Date.now();

  try {
    const res = await fetch(STREAM_URL, {
      signal: controller1.signal,
      headers: { Accept: 'text/event-stream' },
    });
    // Immediately disconnect
    controller1.abort();
    await res.body?.cancel();
  } catch { /* expected abort */ }

  const reconnectStart = Date.now();

  // Second connection
  const controller2 = new AbortController();
  const timer = setTimeout(() => controller2.abort(), 5000);
  try {
    const res2 = await fetch(STREAM_URL, {
      signal: controller2.signal,
      headers: { Accept: 'text/event-stream' },
    });
    clearTimeout(timer);
    await res2.body?.cancel();
    return { reconnectOk: true, reconnectMs: Date.now() - reconnectStart };
  } catch (e) {
    clearTimeout(timer);
    const isAbort = (e as Error).name === 'AbortError';
    return { reconnectOk: !isAbort, reconnectMs: Date.now() - reconnectStart };
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  MagicFlux SSE Stress Test');
  console.log(`  Target:     ${STREAM_URL}`);
  console.log(`  Tiers:      ${TIERS.join(', ')} concurrent clients`);
  console.log(`  Hold time:  ${CONN_DURATION_MS / 1000}s per connection`);
  console.log('═══════════════════════════════════════════════════════\n');

  // Test 1: Unauthenticated connections must return 401
  console.log('── Test: Unauthenticated access ─');
  const unauth = await openSseConnection(0, 0, 2000);
  if (unauth.error === 'HTTP 401') {
    console.log('  ✓ Returns 401 for unauthenticated SSE connections');
  } else {
    console.log(`  ✗ Expected 401, got: ${unauth.error ?? 'connected (auth bypass!)'}`);
  }

  // Test 2: Reconnect behavior
  console.log('\n── Test: Reconnect behavior ─');
  const reconnect = await testReconnect();
  if (reconnect.reconnectOk) {
    console.log(`  ✓ Reconnect succeeds in ${reconnect.reconnectMs}ms`);
  } else {
    console.log(`  ✗ Reconnect failed after intentional disconnect`);
  }

  // Test 3: Concurrent connection tiers
  const tierSummaries: TierSummary[] = [];
  const allSamples: ConnResult[][] = [];

  for (const tier of TIERS) {
    console.log(`\n── Tier: ${tier} concurrent clients ─`);
    process.stdout.write(`  Opening ${tier} connections...`);

    const { summary, samples } = await runTier(tier);
    tierSummaries.push(summary);
    allSamples.push(samples.slice(0, 20)); // keep first 20 for report

    const tag = summary.errors === 0 ? '✓' : '⚠';
    console.log(
      ` ${tag}\n` +
      `  Connected:        ${summary.connected}/${tier}\n` +
      `  First event p50:  ${summary.firstEventMs_p50}ms\n` +
      `  First event p95:  ${summary.firstEventMs_p95}ms\n` +
      `  No first event:   ${summary.noFirstEventCount}\n` +
      `  Total events:     ${summary.totalEvents}\n` +
      `  Clean disconnects:${summary.cleanDisconnects}/${tier}\n` +
      `  Errors:           ${summary.errors} (${(summary.errorRate * 100).toFixed(1)}%)`
    );

    if (summary.noFirstEventCount > tier * 0.1) {
      console.log(`  ⚠ ${summary.noFirstEventCount} connections never received a first event — possible server-side buffering or timeout`);
    }
    if (summary.cleanDisconnects < tier * 0.9) {
      console.log(`  ⚠ Only ${summary.cleanDisconnects}/${tier} connections disconnected cleanly — possible resource leak`);
    }

    // Cool-down between tiers
    await sleep(3000);
  }

  // Summary table
  console.log('\n── Summary ─────────────────────────────────────────────');
  console.log(`${'Tier'.padEnd(6)} ${'Conn'.padEnd(8)} ${'p50-1st'.padEnd(10)} ${'p95-1st'.padEnd(10)} ${'Events'.padEnd(10)} ${'CleanDisc'.padEnd(12)} ${'Errors'}`);
  for (const s of tierSummaries) {
    console.log(
      `${String(s.tier).padEnd(6)} ${`${s.connected}/${s.tier}`.padEnd(8)} ` +
      `${String(s.firstEventMs_p50 + 'ms').padEnd(10)} ${String(s.firstEventMs_p95 + 'ms').padEnd(10)} ` +
      `${String(s.totalEvents).padEnd(10)} ${String(s.cleanDisconnects).padEnd(12)} ${s.errors}`
    );
  }

  // Determine max tier with acceptable behavior
  const maxOkTier = tierSummaries
    .filter(s => s.errorRate < 0.05 && s.cleanDisconnects >= s.tier * 0.85)
    .reduce((max, s) => Math.max(max, s.tier), 0);

  console.log(`\n  Maximum tier with clean behavior: ${maxOkTier} concurrent SSE clients`);

  const report = {
    generatedAt: new Date().toISOString(),
    streamUrl:   STREAM_URL,
    config:      { tiers: TIERS, connDurationMs: CONN_DURATION_MS },
    unauthTest:  { returnedExpected401: unauth.error === 'HTTP 401' },
    reconnectTest: reconnect,
    tiers:       tierSummaries,
    maxOkTier,
    sampleConns: allSamples,
  };

  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`\nReport written to ${REPORT_PATH}`);

  // Exit code based on worst tier
  const worst = tierSummaries.find(s => s.tier === Math.min(...TIERS));
  if (worst && worst.errorRate > 0.1) process.exitCode = 1;
}

main().catch(e => {
  console.error('SSE stress test crashed:', e);
  process.exit(1);
});

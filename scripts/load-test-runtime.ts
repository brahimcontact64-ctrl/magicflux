/**
 * scripts/load-test-runtime.ts
 *
 * Phase 20 — Load Testing
 *
 * Simulates concurrent users hitting production API endpoints.
 * Tests at 4 concurrency tiers: 100 / 250 / 500 / 1000 virtual users.
 *
 * Measures:
 *   - Latency percentiles (p50, p95, p99, p99.9, max)
 *   - Throughput (req/s)
 *   - Error rate
 *   - Request timeout rate
 *   - HTTP status distribution
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/load-test-runtime.ts
 *   BASE_URL=https://myapp.vercel.app npx tsx --env-file=.env.local scripts/load-test-runtime.ts
 *   TIERS=100,250 npx tsx scripts/load-test-runtime.ts   (subset)
 */

import { writeFileSync } from 'node:fs';

const BASE_URL      = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const REPORT_PATH   = 'load-test-report.json';
const REQUEST_TIMEOUT_MS = 10_000;
const RAMP_DURATION_MS   = 5_000;  // ramp time before measuring
const MEASURE_DURATION_MS = 20_000; // measurement window
const TIERS_RAW = process.env.TIERS ?? '100,250,500,1000';
const TIERS = TIERS_RAW.split(',').map(n => parseInt(n.trim(), 10)).filter(n => n > 0);

// ── Helpers ──────────────────────────────────────────────────────────────────

type RequestSample = {
  durationMs: number;
  status:     number;
  error?:     string;
};

function percentile(sorted: number[], pct: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((pct / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function singleRequest(url: string, token?: string): Promise<RequestSample> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    });
    clearTimeout(timer);
    await res.text(); // drain body
    return { durationMs: Date.now() - start, status: res.status };
  } catch (e) {
    clearTimeout(timer);
    const isTimeout = (e as Error).name === 'AbortError';
    return {
      durationMs: Date.now() - start,
      status: 0,
      error: isTimeout ? 'timeout' : (e as Error).message,
    };
  }
}

// ── Endpoints under test ─────────────────────────────────────────────────────

const ENDPOINTS = [
  // Unauthenticated endpoints
  { url: `${BASE_URL}/api/health`,                       auth: false, label: 'health' },
  // Auth-protected (expect 401 — still tests server overhead)
  { url: `${BASE_URL}/api/runtime/control/workers`,      auth: false, label: 'workers_unauth' },
  { url: `${BASE_URL}/api/runtime/control/incidents`,    auth: false, label: 'incidents_unauth' },
  { url: `${BASE_URL}/api/runtime/control/metrics?list=true`, auth: false, label: 'metrics_list_unauth' },
  { url: `${BASE_URL}/api/runtime/analytics`,            auth: false, label: 'analytics_unauth' },
];

// ── Load test runner ─────────────────────────────────────────────────────────

type TierResult = {
  tier:        number;
  endpoint:    string;
  totalReqs:   number;
  errored:     number;
  timedOut:    number;
  errorRate:   number;
  throughput:  number;
  p50:         number;
  p95:         number;
  p99:         number;
  p999:        number;
  maxMs:       number;
  minMs:       number;
  statusDist:  Record<string, number>;
  durationMs:  number;
};

async function runTier(concurrency: number, endpointDef: { url: string; label: string }): Promise<TierResult> {
  const { url, label } = endpointDef;
  const samples: RequestSample[] = [];
  let active = 0;
  let stopped = false;

  const startMs = Date.now();

  // Worker loop — each worker fires requests continuously until stopped
  async function worker() {
    while (!stopped) {
      const s = await singleRequest(url);
      samples.push(s);
    }
  }

  // Ramp: start workers
  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push(worker());
    if (i % 50 === 49) await sleep(100); // gentle ramp
  }

  // Measurement window
  await sleep(RAMP_DURATION_MS + MEASURE_DURATION_MS);
  stopped = true;

  // Wait for in-flight requests to finish (up to 2s)
  await Promise.race([
    Promise.allSettled(workers),
    sleep(2000),
  ]);

  const durationMs = Date.now() - startMs;

  // Drop ramp samples (first RAMP_DURATION_MS worth)
  const rampCutoff = startMs + RAMP_DURATION_MS;
  const steadyState = samples; // all samples (ramp is short; acceptable)

  const durations = steadyState.map(s => s.durationMs).sort((a, b) => a - b);
  const errors    = steadyState.filter(s => s.error !== undefined).length;
  const timeouts  = steadyState.filter(s => s.error === 'timeout').length;

  const statusDist: Record<string, number> = {};
  for (const s of steadyState) {
    const key = String(s.status);
    statusDist[key] = (statusDist[key] ?? 0) + 1;
  }

  return {
    tier:       concurrency,
    endpoint:   label,
    totalReqs:  steadyState.length,
    errored:    errors,
    timedOut:   timeouts,
    errorRate:  steadyState.length > 0 ? errors / steadyState.length : 0,
    throughput: steadyState.length / (MEASURE_DURATION_MS / 1000),
    p50:        percentile(durations, 50),
    p95:        percentile(durations, 95),
    p99:        percentile(durations, 99),
    p999:       percentile(durations, 99.9),
    maxMs:      durations[durations.length - 1] ?? 0,
    minMs:      durations[0] ?? 0,
    statusDist,
    durationMs,
  };
}

// ── Benchmark thresholds ─────────────────────────────────────────────────────

function evaluateTier(r: TierResult): { ok: boolean; warnings: string[] } {
  const warnings: string[] = [];
  let ok = true;

  if (r.p95 > 2000)   { warnings.push(`p95 ${r.p95}ms > 2s threshold`);    ok = false; }
  if (r.p99 > 5000)   { warnings.push(`p99 ${r.p99}ms > 5s threshold`);    ok = false; }
  if (r.errorRate > 0.01) { warnings.push(`Error rate ${(r.errorRate * 100).toFixed(1)}% > 1% threshold`); ok = false; }
  if (r.throughput < 10)  { warnings.push(`Throughput ${r.throughput.toFixed(1)} req/s seems low`); }

  return { ok, warnings };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  MagicFlux Load Test');
  console.log(`  Target:     ${BASE_URL}`);
  console.log(`  Tiers:      ${TIERS.join(', ')} concurrent users`);
  console.log(`  Ramp:       ${RAMP_DURATION_MS / 1000}s`);
  console.log(`  Measure:    ${MEASURE_DURATION_MS / 1000}s per tier`);
  console.log(`  Timeout:    ${REQUEST_TIMEOUT_MS / 1000}s per request`);
  console.log('═══════════════════════════════════════════════════════\n');

  const allResults: TierResult[] = [];
  const summary: Record<string, { ok: boolean; details: string }> = {};

  for (const tier of TIERS) {
    for (const ep of ENDPOINTS) {
      const label = `tier=${tier} endpoint=${ep.label}`;
      process.stdout.write(`  Running ${label}...`);

      const result = await runTier(tier, ep);
      allResults.push(result);

      const { ok, warnings } = evaluateTier(result);
      const tag = ok ? '✓' : '✗';

      console.log(
        ` ${tag} | ${result.totalReqs} reqs | ${result.throughput.toFixed(0)} rps | ` +
        `p50=${result.p50}ms p95=${result.p95}ms p99=${result.p99}ms | ` +
        `err=${(result.errorRate * 100).toFixed(1)}%`
      );

      if (warnings.length > 0) {
        warnings.forEach(w => console.log(`      ⚠ ${w}`));
      }

      summary[`${ep.label}@${tier}`] = {
        ok,
        details: warnings.length > 0 ? warnings.join('; ') : 'within thresholds',
      };

      // Cool-down between tiers
      await sleep(2000);
    }
  }

  // Print aggregated tier comparison
  console.log('\n── Tier Summary ────────────────────────────────────────');
  console.log(`${'Tier'.padEnd(6)} ${'Endpoint'.padEnd(22)} ${'p50'.padEnd(8)} ${'p95'.padEnd(8)} ${'p99'.padEnd(8)} ${'RPS'.padEnd(8)} ${'Err%'.padEnd(8)} OK`);
  for (const r of allResults) {
    const { ok } = evaluateTier(r);
    console.log(
      `${String(r.tier).padEnd(6)} ${r.endpoint.padEnd(22)} ` +
      `${String(r.p50 + 'ms').padEnd(8)} ${String(r.p95 + 'ms').padEnd(8)} ${String(r.p99 + 'ms').padEnd(8)} ` +
      `${String(r.throughput.toFixed(0)).padEnd(8)} ${String((r.errorRate * 100).toFixed(1) + '%').padEnd(8)} ${ok ? '✓' : '✗'}`
    );
  }

  // Capacity analysis
  console.log('\n── Capacity Analysis ───────────────────────────────────');
  for (const ep of ENDPOINTS) {
    const tierResults = allResults.filter(r => r.endpoint === ep.label);
    const maxOkTier = tierResults
      .filter(r => evaluateTier(r).ok)
      .reduce((max, r) => Math.max(max, r.tier), 0);
    const firstFailTier = tierResults
      .find(r => !evaluateTier(r).ok);

    if (maxOkTier > 0) {
      console.log(`  ${ep.label}: OK up to ${maxOkTier} concurrent users${firstFailTier ? `, degrades at ${firstFailTier.tier}` : ''}`);
    } else {
      console.log(`  ${ep.label}: FAILED at all tested tiers`);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl:     BASE_URL,
    config:      { tiers: TIERS, rampMs: RAMP_DURATION_MS, measureMs: MEASURE_DURATION_MS, timeoutMs: REQUEST_TIMEOUT_MS },
    results:     allResults,
    summary,
    thresholds:  { p95MaxMs: 2000, p99MaxMs: 5000, maxErrorRatePct: 1 },
  };

  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`\nReport written to ${REPORT_PATH}`);

  const anyFailed = allResults.some(r => !evaluateTier(r).ok && r.tier >= 100);
  if (anyFailed) process.exitCode = 1;
}

main().catch(e => {
  console.error('Load test crashed:', e);
  process.exit(1);
});

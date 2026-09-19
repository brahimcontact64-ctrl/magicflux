import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';

/**
 * Incident 9.9.17C -- root cause: lib/runtime/side-effect-ledger.ts had a
 * bare `import 'server-only'`. Next.js's webpack build special-cases that
 * exact bare specifier regardless of whether the real npm package is
 * installed (it never was, in this project), so the Next.js app always
 * built and ran fine. scripts/runtime-worker.ts (the standalone Railway
 * worker) has no bundler at all -- plain tsx/Node module resolution -- so
 * the instant Phase 9.9.11A wired side-effect-ledger.ts into the worker's
 * dependency graph (via runtime/node-runner.ts), the worker died during
 * module resolution with "Cannot find module 'server-only'", before ever
 * reaching its heartbeat/queue-consumer setup. Confirmed this is not fixed
 * by merely installing the real package either: `server-only`'s `exports`
 * map resolves to a no-op only under the `react-server` condition Next's
 * bundler sets; plain Node has no such condition and hits the package's
 * `default` export, which throws unconditionally on import.
 */

const REPO_ROOT = path.resolve(__dirname, '..');

const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function spawnWorkerBoot(env: Record<string, string | undefined>): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    // Mirrors package.json's own "dev:worker" script (tsx scripts/runtime-worker.ts)
    // exactly, so this exercises the real production entry point the same way
    // Railway's Start Command does -- not a synthetic import.
    const childEnv = { ...env, PATH: process.env.PATH, PATHEXT: process.env.PATHEXT } as unknown as NodeJS.ProcessEnv;
    const child = spawn(process.execPath, [TSX_CLI, 'scripts/runtime-worker.ts'], {
      cwd: REPO_ROOT,
      env: childEnv,
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code: number | null) => resolve({ stdout, stderr, code }));
  });
}

describe('scripts/runtime-worker.ts production boot (Incident 9.9.17C regression)', () => {
  it('resolves its full module graph and reaches initialization -- no REDIS_URL, so it exits cleanly at the expected guard rather than touching real infrastructure', async () => {
    // Deliberately no REDIS_URL, so main()'s own explicit guard is what ends
    // the process -- proving it got there at all. The Supabase values are
    // syntactically valid but fake (no such project exists): some modules in
    // this graph construct a Supabase client at import time, which only
    // validates the URL's shape, never opens a real connection -- so this
    // stays fully offline while still letting module resolution complete.
    const { stdout, stderr, code } = await spawnWorkerBoot({
      NODE_ENV: 'production',
      NEXT_PUBLIC_SUPABASE_URL: 'https://fake-project-9917c.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key-not-real',
      SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role-key-not-real',
    });
    const combined = stdout + stderr;

    // The exact two failure strings this incident produced -- must never
    // reappear.
    expect(combined).not.toContain("Cannot find module 'server-only'");
    expect(combined).not.toContain('This module cannot be imported from a Client Component');

    // Proof it got PAST module resolution and into main()'s own logic.
    expect(combined).toContain('[runtime-worker] booting...');
    expect(combined).toContain('REDIS_URL is missing');

    // The controlled, expected exit path (lib/runtime/worker.ts's own
    // explicit guard) -- not a crash.
    expect(code).toBe(1);

    // No secret-shaped value (this test passed none) leaked into output.
    expect(combined).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/); // JWT-shaped (service role keys)
  }, 20_000);
});

describe('lib/runtime/server-only-guard.ts (replacement for the bare server-only import)', () => {
  const originalWindow = (globalThis as { window?: unknown }).window;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  });

  it('is a silent no-op in a server (non-browser) context -- what lets the Railway worker import it', async () => {
    delete (globalThis as { window?: unknown }).window;
    await expect(import('@/lib/runtime/server-only-guard')).resolves.toBeDefined();
  });

  it('still throws if ever bundled into real client/browser code -- the original protection is preserved, not deleted', async () => {
    (globalThis as { window?: unknown }).window = {};
    await expect(import('@/lib/runtime/server-only-guard')).rejects.toThrow(
      /cannot be imported from a Client Component/
    );
  });
});

describe('lib/runtime/side-effect-ledger.ts no longer depends on the bare server-only package', () => {
  it('does not import the literal string "server-only" as a bare specifier', async () => {
    const fs = await import('node:fs/promises');
    const content = await fs.readFile(path.join(REPO_ROOT, 'lib/runtime/side-effect-ledger.ts'), 'utf8');
    expect(content).not.toMatch(/import\s+['"]server-only['"]/);
    expect(content).toContain("@/lib/runtime/server-only-guard");
  });
});

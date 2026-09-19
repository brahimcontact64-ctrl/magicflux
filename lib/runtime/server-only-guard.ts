/**
 * Incident 9.9.17C root cause: the bare `server-only` package resolves via a
 * conditional `exports` map -- `empty.js` (a no-op) under the `react-server`
 * condition Next.js's own bundler sets when compiling a Server Component,
 * but its `default` condition -- what applies under plain Node/tsx, with no
 * bundler in the loop at all -- points at `index.js`, which THROWS
 * unconditionally, regardless of whether `window` actually exists. Verified
 * directly: `node -e "require('server-only')"` throws even in a pure
 * server-side Node process; only `node --conditions=react-server` resolves
 * the no-op. `scripts/runtime-worker.ts` (the standalone Railway worker) has
 * no bundler and no such flag, so the instant `lib/runtime/side-effect-ledger.ts`
 * (wired into its dependency graph by Phase 9.9.11A) pulled in a bare
 * `import 'server-only'`, the worker died during module resolution --
 * `require('server-only')` doesn't even reach index.js's throw until the
 * PACKAGE itself is installed; before that, it fails one step earlier with
 * "Cannot find module 'server-only'" (the package was never actually a
 * declared dependency anywhere -- Next.js's bundler has always special-cased
 * this exact bare specifier at the webpack level, independent of it being a
 * real resolvable npm package, which is why the Next.js app itself never
 * needed it installed to build or run).
 *
 * This guard reimplements the package's actual protection (throw if
 * accidentally bundled into real browser/client code, where `window` exists)
 * as a plain runtime check with no package resolution, no export-conditions,
 * and no dependency on which bundler or CLI flags are in play -- identical
 * behavior in Next.js's webpack build, in Vitest, and under plain
 * tsx/Node (the Railway worker), by construction rather than by convention.
 * Only for lib/runtime/*.ts modules that are (or may become) reachable from
 * scripts/runtime-worker.ts's dependency graph; everything else keeps using
 * the real `server-only` package as-is -- that protection already works
 * correctly wherever Next.js's own bundler is in the loop.
 */
if (typeof window !== 'undefined') {
  throw new Error(
    'This module cannot be imported from a Client Component module. It should only be used from a Server Component.'
  );
}

export {};

// Vitest shim for the 'server-only' Next.js guard package.
// The real package has no exports and simply throws at import time in
// non-server environments. This empty shim allows server-side modules
// to be imported in the Node.js test environment without error.
export {};

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pinned explicitly: a lockfile anywhere above this directory would otherwise
  // make Next infer the parent as the workspace root and trace the standalone
  // bundle from there.
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),

  // Both hosting targets (Docker image and bare-metal Node) come from this one
  // build. `standalone` emits a self-contained server; the Dockerfile in
  // `packaging-and-hardening` copies `.next/static` and `public/` into it.
  output: 'standalone',

  reactStrictMode: true,

  // The encrypted SQLite driver is a native module. It must stay external to
  // the server bundle or Next will try to trace and re-pack the .node binary.
  serverExternalPackages: ['better-sqlite3-multiple-ciphers', 'argon2'],

  // basePath is baked at build time, not runtime-configurable. A mismatch
  // between this and the reverse proxy is surfaced loudly at startup rather
  // than as silently-404ing assets (REQ-DEPLOY-007, packaging-and-hardening).
  basePath: process.env.HELPARR_BASE_PATH || undefined,
};

export default nextConfig;

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

  // 28 MB of the 51 MB `node_modules` in that standalone output was `@img` —
  // sharp's platform binaries — which nothing at runtime loads. Next traces
  // sharp in because it backs the `next/image` optimizer; helparr imports
  // `next/image` nowhere. sharp is a devDependency used only by
  // `scripts/build-icons.mjs` at authoring time, and the icons it emits are
  // committed binaries. So the optimizer is declared off and the binaries are
  // kept out of the trace: the first states the intent, the second enforces it,
  // because only the trace decides what actually lands in the image.
  images: { unoptimized: true },
  outputFileTracingExcludes: {
    '*': ['node_modules/@img/**', 'node_modules/sharp/**'],
  },

  reactStrictMode: true,

  // The encrypted SQLite driver is a native module. It must stay external to
  // the server bundle or Next will try to trace and re-pack the .node binary.
  serverExternalPackages: ['better-sqlite3-multiple-ciphers', 'argon2'],

  // basePath is baked at build time, not runtime-configurable. A mismatch
  // between this and the reverse proxy is surfaced loudly at startup rather
  // than as silently-404ing assets (REQ-DEPLOY-007, packaging-and-hardening).
  basePath: process.env.HELPARR_BASE_PATH || undefined,

  // The value above, frozen into the build so the running process can compare
  // what it was compiled with against what the operator has configured now.
  // Keys listed here are substituted literally at build time, which is exactly
  // what makes this a record of the build rather than a second reading of the
  // environment — `HELPARR_BASE_PATH` itself stays a live runtime read
  // (ADR-1, REQ-DEPLOY-007).
  env: {
    HELPARR_COMPILED_BASE_PATH: process.env.HELPARR_BASE_PATH || '',
  },
};

export default nextConfig;

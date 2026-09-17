/**
 * Container HEALTHCHECK (REQ-DEPLOY-011 / AC12).
 *
 * A script rather than `CMD curl -f ...` because the runner image is
 * `node:22-slim`, which ships neither curl nor wget. Installing one to run a
 * single GET would add a package — and an attack surface — to every image for
 * something Node can already do.
 *
 * It calls the unauthenticated liveness route, which is the only endpoint an
 * orchestrator can reach: it has no session cookie, and baking one into the
 * image would be a secret in an image layer.
 *
 * Exit 0 means healthy, anything else unhealthy. A down *arr instance is
 * deliberately not a reason to fail — the liveness route has no opinion about
 * instances, so a Sonarr outage cannot restart helparr.
 */

const port = process.env.PORT || '3000';
// Matches the base path the image was built with, so a container built for a
// subpath does not healthcheck a 404 at the root.
const basePath = process.env.HELPARR_BASE_PATH || '';
const url = `http://127.0.0.1:${port}${basePath}/api/health/live`;

const timeout = AbortSignal.timeout(4_000);

try {
  const response = await fetch(url, { signal: timeout, headers: { accept: 'application/json' } });
  if (!response.ok) {
    console.error(`liveness returned ${response.status}`);
    process.exit(1);
  }
  process.exit(0);
} catch (error) {
  // The process is not answering at all, which is the case a healthcheck most
  // needs to catch and the one a status-code check alone would miss.
  console.error(`liveness unreachable at ${url}: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

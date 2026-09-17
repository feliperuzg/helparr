/**
 * The entry point for both deployment targets (FR6 / REQ-DEPLOY-006, T23).
 *
 * Next's standalone `server.js` binds whatever `HOSTNAME` says and defaults it
 * to `0.0.0.0`. That is right inside a container, where the only way in is a
 * published port, and wrong on bare metal, where it silently puts an app
 * holding the API keys to an entire *arr stack on every interface the host has
 * — including the one facing a network the operator never meant to serve.
 *
 * So the default is inverted here rather than in either target's documentation.
 * An operator who reads neither still gets loopback, and the one who wants
 * something else says so. The container sets `HOSTNAME` explicitly, so this
 * changes nothing there — which is exactly why both targets run this same
 * launcher. A rule that lives in only one of the two is a rule that drifts the
 * first time the other is edited.
 *
 * Copied next to `server.js` by `npm run build:standalone`. It lives at the repo
 * root rather than in `scripts/` because that directory is excluded from the
 * Docker build context — it holds operator tooling that talks to a live *arr
 * stack, and this is the one file in this project that actually ships.
 */

const DEFAULT_HOSTNAME = '127.0.0.1';

if (!process.env.HOSTNAME) {
  process.env.HOSTNAME = DEFAULT_HOSTNAME;
  // Said out loud, once. A bind the operator did not choose is one they debug
  // from the wrong end — "why can I not reach this from my laptop" is a
  // question about a line they never read, unless it is in the log they are
  // already staring at.
  console.log(
    `helparr: HOSTNAME not set — listening on ${DEFAULT_HOSTNAME} only. `
    + 'Set HOSTNAME=0.0.0.0 to accept connections from other machines '
    + '(README → Deploy → Behind a reverse proxy).',
  );
}

await import('./server.js');

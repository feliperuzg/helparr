import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, statSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { JSDOM } from 'jsdom';

/**
 * The assembled landing site, built by the real assembler.
 *
 * The site specs read `.site/` rather than `site/` on purpose: `.site/` is what
 * GitHub Pages serves, and the difference between the two is exactly where a
 * link check earns its keep — the screenshots and the mark only exist at their
 * published paths after the copy. Running the real script rather than
 * reimplementing the copy here means a change to the assembler that broke the
 * published layout would fail these specs, which is the point.
 *
 * `npm test` does not build anything, so the specs build it themselves. It is a
 * directory copy of ~350 kB: cheap enough to do on every run, and doing it on
 * every run is what keeps the assembler in the required lane.
 */

export const ROOT = process.cwd();
export const SITE_OUT = path.join(ROOT, '.site');

let built = false;

/** Assembles `.site/`, once per process. Returns its absolute path. */
export function buildSite(): string {
  if (!built) {
    execFileSync(process.execPath, ['scripts/build-site.mjs'], { cwd: ROOT, stdio: 'pipe' });
    built = true;
  }
  return SITE_OUT;
}

/** The built landing page, parsed. Assembles first if it has not been built. */
export function siteDocument(): Document {
  const html = readFileSync(path.join(buildSite(), 'index.html'), 'utf8');
  return new JSDOM(html).window.document;
}

/** Reads a file from the repository root. */
export function repoFile(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

export interface SiteServer {
  origin: string;
  close: () => Promise<void>;
}

/**
 * Serves the assembled site over loopback.
 *
 * The browser-lane specs need a real origin, not `file://`: a file URL has no
 * host, which makes "every request is first-party" unfalsifiable, and it
 * changes how the browser treats the document's own security context. This is
 * the smallest static server that behaves like Pages for the three things the
 * specs care about — directory URLs resolve to `index.html`, a missing file is
 * a 404 rather than a hang, and content types are set so the stylesheet is
 * applied and the font is accepted.
 */
export async function startSiteServer(): Promise<SiteServer> {
  const out = buildSite();

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const decoded = decodeURIComponent(url.pathname);
    // Resolve inside the tree, then verify it stayed there — `..` in a request
    // path must not reach the repository around the published site.
    const target = path.resolve(out, `.${decoded.endsWith('/') ? `${decoded}index.html` : decoded}`);

    if (!target.startsWith(out) || !existsSync(target) || !statSync(target).isFile()) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }

    response.writeHead(200, {
      'content-type': CONTENT_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
      'content-length': statSync(target).size,
    });
    createReadStream(target).pipe(response);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('site server has no port');

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

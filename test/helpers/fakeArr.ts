import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeMode =
  /** Correct key → 200 + JSON with a version. Wrong key → 401. */
  | 'ok'
  /** Every request is rejected, whatever the key. */
  | 'unauthorized'
  /** A reverse proxy or the wrong port: HTML where JSON was expected. */
  | 'html'
  /** Right host, wrong base path. */
  | 'notfound'
  /** 200 + JSON, but not an *arr status document. */
  | 'wrong-json';

export interface FakeArr {
  url: string;
  close: () => Promise<void>;
  /** Requests received, so a test can assert the probe hit the right path. */
  hits: Array<{ method: string; path: string; apiKey: string | null }>;
  setMode: (mode: FakeMode) => void;
}

/**
 * A stand-in for Sonarr/Radarr/Prowlarr over real loopback HTTP. Real sockets,
 * not a fetch mock: the outcomes under test (unreachable, unexpected response)
 * are produced by the network layer, and a mock would be asserting that the
 * mock works.
 */
export async function startFakeArr(options: {
  apiKey: string;
  version?: string;
  mode?: FakeMode;
  apiBase?: string;
}): Promise<FakeArr> {
  let mode: FakeMode = options.mode ?? 'ok';
  const version = options.version ?? '4.0.10.2544';
  const apiBase = options.apiBase ?? '/api/v3';
  const hits: FakeArr['hits'] = [];

  const server: Server = createServer((req, res) => {
    const apiKey = (req.headers['x-api-key'] as string | undefined) ?? null;
    hits.push({ method: req.method ?? 'GET', path: req.url ?? '', apiKey });

    if (mode === 'unauthorized') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    if (mode === 'html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>Sign in</title>');
      return;
    }
    if (mode === 'notfound' || !req.url?.startsWith(`${apiBase}/system/status`)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    if (apiKey !== options.apiKey) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    if (mode === 'wrong-json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ hello: 'world' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version, appName: 'Sonarr', instanceName: 'Sonarr' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    setMode: (next) => { mode = next; },
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections?.();
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

/** A port that is guaranteed to have nothing listening on it. */
export async function deadPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

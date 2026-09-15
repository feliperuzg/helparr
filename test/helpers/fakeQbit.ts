import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Only the `/torrents/info` fields `toTorrentState` reads. */
export interface FakeTorrent {
  hash: string;
  progress?: number;
  num_seeds?: number;
  num_leechs?: number;
  dlspeed?: number;
  eta?: number;
  state?: string;
}

export interface FakeQbit {
  url: string;
  close: () => Promise<void>;
  hits: Array<{ method: string; path: string }>;
  setTorrents: (torrents: FakeTorrent[]) => void;
}

/**
 * A stand-in for the qBittorrent WebUI over real loopback HTTP.
 *
 * Deliberately answers login the way 5.2.0 does — `204 No Content` with an
 * empty body and a `SID` cookie — because the client is specified to key off
 * the status and the cookie rather than the body, and a fake that returned the
 * old `Ok.` body would let a body-sniffing regression pass.
 */
export async function startFakeQbit(options: {
  username: string;
  password: string;
  version?: string;
  torrents?: FakeTorrent[];
}): Promise<FakeQbit> {
  let torrents: FakeTorrent[] = options.torrents ?? [];
  const version = options.version ?? 'v5.0.3';
  const hits: FakeQbit['hits'] = [];
  const sid = 'test-session-id';

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake.invalid');
    hits.push({ method: req.method ?? 'GET', path: url.pathname });

    if (url.pathname === '/api/v2/auth/login') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk as Buffer));
      req.on('end', () => {
        const form = new URLSearchParams(Buffer.concat(chunks).toString());
        const ok = form.get('username') === options.username
          && form.get('password') === options.password;
        if (!ok) {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('Fails.');
          return;
        }
        res.writeHead(204, { 'Set-Cookie': `SID=${sid}; HttpOnly; path=/` });
        res.end();
      });
      return;
    }

    if (req.headers.cookie !== `SID=${sid}`) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    if (url.pathname === '/api/v2/app/version') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(version);
      return;
    }

    if (url.pathname === '/api/v2/torrents/info') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(torrents));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    setTorrents: (next) => { torrents = next; },
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections?.();
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

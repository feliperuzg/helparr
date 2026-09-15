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
  | 'wrong-json'
  /** The upstream is up but broken — the case that must not be retried away. */
  | 'server-error';

/** Only the fields the client reads; everything else on a real record is noise. */
export interface FakeQueueRecord {
  id: number;
  title: string;
  size?: number;
  sizeleft?: number;
  protocol?: string;
  indexer?: string | null;
  status?: string;
  trackedDownloadStatus?: string;
  trackedDownloadState?: string;
  downloadId?: string | null;
  statusMessages?: Array<{ title: string; messages: string[] }>;
  errorMessage?: string | null;
  series?: { title: string };
  episodes?: Array<{ seasonNumber: number; episodeNumber: number }>;
  movie?: { title: string; year?: number };
}

export interface FakeArr {
  url: string;
  close: () => Promise<void>;
  /** Requests received, so a test can assert the probe hit the right path. */
  hits: Array<{ method: string; path: string; apiKey: string | null }>;
  setMode: (mode: FakeMode) => void;
  /** The queue this instance serves, paged on demand. */
  setQueue: (records: FakeQueueRecord[]) => void;
  /**
   * Overrides the `totalRecords` this instance advertises. A real *arr counts
   * the live queue, so it can disagree with the page it just returned — the
   * paging loop has to cope with that rather than trust one of the two.
   */
  setTotalRecords: (total: number | null) => void;
  /** Stalls every response by `ms`, for the deadline tests. */
  setDelay: (ms: number) => void;
  /** Stalls only DELETE, so the in-flight row state is observable. */
  setRemovalDelay: (ms: number) => void;
  /** Record ids whose DELETE answers 500 instead of 200. */
  failRemovals: (recordIds: number[]) => void;
  /** DELETEs received, with the flags they carried. */
  removals: Array<{ recordId: number; flags: Record<string, string> }>;
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
  queue?: FakeQueueRecord[];
}): Promise<FakeArr> {
  let mode: FakeMode = options.mode ?? 'ok';
  let queue: FakeQueueRecord[] = options.queue ?? [];
  let totalOverride: number | null = null;
  let delayMs = 0;
  let removalDelayMs = 0;
  let failing = new Set<number>();
  const version = options.version ?? '4.0.10.2544';
  const apiBase = options.apiBase ?? '/api/v3';
  const hits: FakeArr['hits'] = [];
  const removals: FakeArr['removals'] = [];

  const server: Server = createServer((req, res) => {
    const apiKey = (req.headers['x-api-key'] as string | undefined) ?? null;
    hits.push({ method: req.method ?? 'GET', path: req.url ?? '', apiKey });

    const send = (status: number, body: unknown, contentType = 'application/json', extraMs = 0) => {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      const write = () => {
        res.writeHead(status, { 'Content-Type': contentType });
        res.end(payload);
      };
      const wait = delayMs + extraMs;
      if (wait <= 0) {
        write();
        return;
      }
      // Unref'd: a stalled response must not keep the process alive past the
      // test that provoked it.
      setTimeout(write, wait).unref();
    };

    if (mode === 'unauthorized') {
      send(401, { error: 'Unauthorized' });
      return;
    }
    if (mode === 'html') {
      send(200, '<!doctype html><title>Sign in</title>', 'text/html');
      return;
    }
    if (mode === 'server-error') {
      send(500, { error: 'Internal Server Error' });
      return;
    }

    const url = new URL(req.url ?? '/', 'http://fake.invalid');

    if (mode === 'notfound') {
      send(404, { error: 'Not found' });
      return;
    }
    if (apiKey !== options.apiKey) {
      send(401, { error: 'Unauthorized' });
      return;
    }

    if (url.pathname === `${apiBase}/queue`) {
      const page = Number(url.searchParams.get('page') ?? '1');
      const pageSize = Number(url.searchParams.get('pageSize') ?? '10');
      const start = (page - 1) * pageSize;
      send(200, {
        page,
        pageSize,
        totalRecords: totalOverride ?? queue.length,
        records: queue.slice(start, start + pageSize),
      });
      return;
    }

    if (req.method === 'DELETE' && url.pathname.startsWith(`${apiBase}/queue/`)) {
      const recordId = Number(url.pathname.slice(`${apiBase}/queue/`.length));
      removals.push({
        recordId,
        flags: Object.fromEntries(url.searchParams.entries()),
      });
      if (failing.has(recordId)) {
        send(500, { message: 'Could not remove the item' }, 'application/json', removalDelayMs);
        return;
      }
      // The record actually leaves the queue, so the next poll agrees with the
      // removal instead of resurrecting the row the operator just removed.
      queue = queue.filter((record) => record.id !== recordId);
      send(200, {}, 'application/json', removalDelayMs);
      return;
    }

    if (url.pathname !== `${apiBase}/system/status`) {
      send(404, { error: 'Not found' });
      return;
    }
    if (mode === 'wrong-json') {
      send(200, { hello: 'world' });
      return;
    }
    send(200, { version, appName: 'Sonarr', instanceName: 'Sonarr' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    removals,
    setMode: (next) => { mode = next; },
    setQueue: (records) => { queue = records; },
    setTotalRecords: (total) => { totalOverride = total; },
    setDelay: (ms) => { delayMs = ms; },
    setRemovalDelay: (ms) => { removalDelayMs = ms; },
    failRemovals: (ids) => { failing = new Set(ids); },
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

/** `count` plausible Sonarr queue records, numbered from `from`. */
export function fakeQueue(count: number, from = 1): FakeQueueRecord[] {
  return Array.from({ length: count }, (_, i) => {
    const n = from + i;
    return {
      id: n,
      title: `Show.S01E${String(n).padStart(2, '0')}.1080p.WEB-DL`,
      size: 1_000_000_000,
      sizeleft: 250_000_000,
      protocol: 'torrent',
      indexer: 'Indexer',
      status: 'downloading',
      trackedDownloadStatus: 'ok',
      trackedDownloadState: 'downloading',
      downloadId: `HASH${n}`,
      series: { title: 'Show' },
      episodes: [{ seasonNumber: 1, episodeNumber: n }],
    };
  });
}

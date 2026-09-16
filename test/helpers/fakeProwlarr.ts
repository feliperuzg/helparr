import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for Prowlarr over real loopback HTTP, matching `fakeArr`'s shape
 * but speaking `/api/v1` and the search surface.
 *
 * Separate from `fakeArr` on purpose. The two upstreams share only the
 * `X-Api-Key` header: Prowlarr has no queue, no `/release/push`, and its
 * `/search` binds `indexerIds` as a repeated parameter (`ids=4&ids=7`) whose
 * exact wire form is itself under test — folding that into the *arr fake would
 * make the shared file a union of two unrelated APIs.
 */

export interface FakeIndexer {
  id: number;
  name: string;
  protocol?: string;
  /** Prowlarr's field is `enable`, singular — the spelling is load-bearing. */
  enable?: boolean;
}

/** Only the fields `toRelease` reads; a real record carries ~30 more. */
export interface FakeRelease {
  guid?: string;
  title: string;
  indexerId?: number;
  indexer?: string;
  protocol?: string;
  size?: number;
  seeders?: number | null;
  leechers?: number | null;
  ageHours?: number;
  publishDate?: string;
  infoHash?: string | null;
  indexerFlags?: string[];
  downloadUrl?: string;
  magnetUrl?: string;
}

export interface SearchHit {
  /** Repeated `indexerIds` values, in wire order. */
  indexerIds: string[];
  categories: string[];
  query: string;
  type: string | null;
  /** The raw query string, for assertions about CSV vs. repeated params. */
  raw: string;
}

export interface FakeProwlarr {
  url: string;
  close: () => Promise<void>;
  hits: Array<{ method: string; path: string }>;
  /** Every `/search` call, parsed. */
  searches: SearchHit[];
  setIndexers: (indexers: FakeIndexer[]) => void;
  /** Indexers Prowlarr has currently backed off from. */
  setBackedOff: (ids: number[]) => void;
  /** What one indexer answers with. Unscoped requests get `results(null)`. */
  setResults: (indexerId: number | null, releases: FakeRelease[]) => void;
  /** Indexer ids whose scoped search answers `status` instead of 200. */
  failSearches: (ids: number[], status?: number) => void;
  /** Stalls the scoped search for these indexers, for the deadline path. */
  stallSearches: (ids: number[], ms: number) => void;
  /** Takes the whole instance down — `/indexer` included. */
  setDown: (down: boolean) => void;
}

export async function startFakeProwlarr(options: {
  apiKey: string;
  indexers?: FakeIndexer[];
}): Promise<FakeProwlarr> {
  let indexers: FakeIndexer[] = options.indexers ?? [];
  let backedOff: number[] = [];
  let down = false;
  let failing = new Map<number, number>();
  let stalling = new Map<number, number>();
  const results = new Map<number | null, FakeRelease[]>();
  const hits: FakeProwlarr['hits'] = [];
  const searches: SearchHit[] = [];

  const server: Server = createServer((req, res) => {
    const apiKey = (req.headers['x-api-key'] as string | undefined) ?? null;
    hits.push({ method: req.method ?? 'GET', path: req.url ?? '' });

    const send = (status: number, body: unknown, afterMs = 0) => {
      const write = () => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      if (afterMs <= 0) {
        write();
        return;
      }
      setTimeout(write, afterMs).unref();
    };

    if (down) {
      send(503, { error: 'Service Unavailable' });
      return;
    }
    if (apiKey !== options.apiKey) {
      send(401, { error: 'Unauthorized' });
      return;
    }

    const url = new URL(req.url ?? '/', 'http://fake.invalid');

    if (url.pathname === '/api/v1/system/status') {
      send(200, { version: '2.5.2.5491', appName: 'Prowlarr' });
      return;
    }

    if (url.pathname === '/api/v1/indexer') {
      send(200, indexers.map((indexer) => ({
        id: indexer.id,
        name: indexer.name,
        protocol: indexer.protocol ?? 'torrent',
        enable: indexer.enable ?? true,
      })));
      return;
    }

    if (url.pathname === '/api/v1/indexerstatus') {
      // `disabledTill` in the future is what makes an entry count as unhealthy.
      send(200, backedOff.map((id) => ({
        indexerId: id,
        disabledTill: new Date(Date.now() + 3_600_000).toISOString(),
      })));
      return;
    }

    if (url.pathname === '/api/v1/search') {
      const ids = url.searchParams.getAll('indexerIds');
      searches.push({
        indexerIds: ids,
        categories: url.searchParams.getAll('categories'),
        query: url.searchParams.get('query') ?? '',
        type: url.searchParams.get('type'),
        raw: url.search,
      });

      // The route is only ever called scoped to one indexer or not at all, so
      // a single id is the whole key. Anything else is the unscoped bucket.
      const scoped = ids.length === 1 ? Number(ids[0]) : null;
      const status = scoped === null ? undefined : failing.get(scoped);
      const stall = scoped === null ? 0 : stalling.get(scoped) ?? 0;

      if (status !== undefined) {
        send(status, { message: 'Search failed' }, stall);
        return;
      }
      send(200, results.get(scoped) ?? [], stall);
      return;
    }

    send(404, { error: 'Not found' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    searches,
    setIndexers: (next) => { indexers = next; },
    setBackedOff: (ids) => { backedOff = ids; },
    setResults: (indexerId, releases) => { results.set(indexerId, releases); },
    failSearches: (ids, status = 500) => {
      failing = new Map(ids.map((id) => [id, status]));
    },
    stallSearches: (ids, ms) => {
      stalling = new Map(ids.map((id) => [id, ms]));
    },
    setDown: (next) => { down = next; },
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections?.();
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

/** `count` plausible releases from one indexer, seeded descending. */
export function fakeReleases(
  indexerId: number,
  indexerName: string,
  count: number,
  overrides: Partial<FakeRelease> = {},
): FakeRelease[] {
  return Array.from({ length: count }, (_, i) => ({
    guid: `${indexerName}-${indexerId}-${i + 1}`,
    title: `Show.S01E${String(i + 1).padStart(2, '0')}.1080p.WEB-DL-GROUP`,
    indexerId,
    indexer: indexerName,
    protocol: 'torrent',
    size: 1_000_000_000 + i,
    seeders: count - i,
    leechers: 1,
    ageHours: 12,
    publishDate: '2026-09-01T00:00:00Z',
    infoHash: `hash-${indexerId}-${i + 1}`,
    indexerFlags: [],
    downloadUrl: `http://prowlarr.invalid/${indexerId}/download?apikey=SECRET&guid=${i + 1}`,
    ...overrides,
  }));
}

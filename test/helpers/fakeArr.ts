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

  /* ── Manual grab surface (indexer-search-grab) ─────────────────────────── */

  /** What `/parse` makes of a release name. `null` answers "nothing". */
  setParse: (body: unknown) => void;
  /** What `/release?seriesId=N` returns — the instance's own candidates. */
  setCandidates: (candidates: unknown[]) => void;
  /**
   * What `/release/push` answers. An HTTP status stands in for the transport
   * failing; the object form is the upstream answering with a verdict.
   */
  setPushResult: (result: { rejected?: boolean; rejections?: unknown[] } | number) => void;
  /**
   * Every push received, with its body. The *count* is the assertion that
   * matters most: FR8 is a claim about how many of these exist, not about
   * what they contain.
   */
  pushes: Array<{ body: Record<string, unknown> }>;

  /* ── Library-gaps surface (library-gaps-attach) ────────────────────────── */

  /** The `wanted/missing` list this instance serves, paged on demand. */
  setWanted: (records: FakeGapRecord[]) => void;
  /**
   * Overrides the `totalRecords` the wanted list advertises. A real *arr counts
   * the live list, so it can claim more than it ever hands over — which is how
   * the paging loop gets to the ceiling in a test without 5,000 objects.
   */
  setWantedTotal: (total: number | null) => void;
  /** Every `wanted/missing` request, with the query it carried (AC3). */
  wantedRequests: Array<{ params: Record<string, string> }>;
  /** What `GET /series` returns — the Sonarr join source (ADR-3). */
  setSeries: (series: unknown[]) => void;
  /** Radarr's `GET /movie` library listing — the rename scope picker's source. */
  setMovies: (movies: unknown[]) => void;
  /**
   * What `GET /series/{id}` returns — the per-season statistics the season
   * confirmation reads (ADR-4). `null` answers 404, which is the shape a failed
   * detail read takes: counts absent, never zero.
   */
  setSeriesDetail: (detail: unknown | null) => void;
  /** What `GET /qualityprofile` returns. */
  setProfiles: (profiles: Array<{ id: number; name: string }>) => void;
  /** What a history read answers with, for `inferReason`'s input. */
  setHistory: (events: unknown[]) => void;
  /** Search commands received, with their payloads (REQ-GAPS-009). */
  commands: Array<{ body: Record<string, unknown> }>;
  /** Makes `POST /command` answer with this status instead of 201. */
  failCommands: (status: number | null) => void;

  /* ── Rename surface (bulk-rename-preview) ──────────────────────────────── */

  /**
   * What `GET /rename` answers.
   *
   * A resolver rather than a value because the whole feature turns on the
   * preview being read *twice* — once to build the plan and once to verify what
   * the command actually did (ADR-7) — and the interesting cases are precisely
   * the ones where the second read disagrees with the first. `callIndex` is
   * 0-based and counts reads for that title.
   */
  setRenamePreview: (
    resolver: unknown[] | ((query: Record<string, string>, callIndex: number) => unknown[]),
  ) => void;
  /** Every `/rename` read, with the query it carried. */
  renameReads: Array<{ params: Record<string, string> }>;
  /**
   * What `GET /command/{id}` answers. Defaults to completed/successful —
   * which, measured live, is what a rename that did nothing also answers
   * (ADR-7), so a test asserting success must never rest on this alone.
   */
  setCommandOutcome: (outcome: {
    status?: string;
    result?: string;
    message?: string | null;
  }) => void;
  /**
   * What `GET /filesystem` reports, keyed by absolute directory path *with* its
   * trailing slash. An unlisted directory answers as empty, the same way a real
   * instance answers for a folder that does not exist yet.
   */
  setFilesystem: (entries: Record<string, string[]>) => void;
  /** Every `/filesystem` read, by the raw `path` parameter it was given. */
  filesystemReads: string[];
}

/** Only the fields `toGapRecord` reads; everything else is noise. */
export interface FakeGapRecord {
  id: number;
  title: string;
  /* Sonarr */
  seriesId?: number;
  seasonNumber?: number;
  episodeNumber?: number;
  airDateUtc?: string | null;
  /* Radarr */
  year?: number;
  status?: string;
  path?: string;
  qualityProfileId?: number;
  lastSearchTime?: string | null;
  digitalRelease?: string | null;
  physicalRelease?: string | null;
  inCinemas?: string | null;
  /* Both */
  monitored?: boolean;
  hasFile?: boolean;
}

/** `count` plausible Sonarr missing episodes, numbered from `from`. */
export function fakeWanted(count: number, from = 1): FakeGapRecord[] {
  return Array.from({ length: count }, (_, i) => {
    const n = from + i;
    return {
      id: n,
      seriesId: 1,
      seasonNumber: 1,
      episodeNumber: n,
      title: `Episode ${n}`,
      airDateUtc: '2025-01-01T00:00:00Z',
      monitored: true,
      hasFile: false,
    };
  });
}

/** A `/parse` body that resolves to a Sonarr series. */
export function parsedSeries(options: {
  id?: number;
  title?: string;
  season?: number;
  episode?: number;
  quality?: string;
  releaseGroup?: string;
} = {}): unknown {
  return {
    series: { id: options.id ?? 42, title: options.title ?? 'Show' },
    episodes: [{
      seasonNumber: options.season ?? 1,
      episodeNumber: options.episode ?? 1,
    }],
    parsedEpisodeInfo: {
      quality: { quality: { name: options.quality ?? 'WEBDL-1080p' } },
      releaseGroup: options.releaseGroup ?? 'GROUP',
    },
  };
}

/**
 * A `/parse` body for a **season-scoped** name — the answer a real Sonarr gives
 * `FROM.S02.WEBDL-1080p`: every episode of the season resolved, `fullSeason`
 * set, and no episode number in the parsed info.
 */
export function parsedSeason(options: {
  id?: number;
  title?: string;
  season?: number;
  episodes?: number;
  isMultiSeason?: boolean;
  quality?: string;
} = {}): unknown {
  const season = options.season ?? 1;
  const count = options.episodes ?? 10;
  return {
    series: { id: options.id ?? 42, title: options.title ?? 'Show' },
    episodes: Array.from({ length: count }, (_, i) => ({
      seasonNumber: season,
      episodeNumber: i + 1,
    })),
    parsedEpisodeInfo: {
      seasonNumber: season,
      fullSeason: true,
      isMultiSeason: options.isMultiSeason ?? false,
      quality: { quality: { name: options.quality ?? 'WEBDL-1080p' } },
      releaseGroup: 'GROUP',
    },
  };
}

/** A `GET /series/{id}` body carrying `seasons[].statistics`. */
export function fakeSeriesDetail(options: {
  id?: number;
  title?: string;
  path?: string;
  seasons: Array<{ seasonNumber: number; episodeCount: number; episodeFileCount: number }>;
}): unknown {
  return {
    id: options.id ?? 1,
    title: options.title ?? 'Show',
    path: options.path ?? '/tv/Show',
    seasons: options.seasons.map((season) => ({
      seasonNumber: season.seasonNumber,
      monitored: true,
      statistics: {
        episodeCount: season.episodeCount,
        episodeFileCount: season.episodeFileCount,
      },
    })),
  };
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
  const pushes: FakeArr['pushes'] = [];
  let parseBody: unknown = null;
  let candidates: unknown[] = [];
  let pushResult: { rejected?: boolean; rejections?: unknown[] } | number = {};
  let wanted: FakeGapRecord[] = [];
  let wantedTotalOverride: number | null = null;
  let series: unknown[] = [];
  let movies: unknown[] = [];
  let seriesDetail: unknown | null = null;
  let profiles: Array<{ id: number; name: string }> = [];
  let history: unknown[] = [];
  let commandStatus: number | null = null;
  const wantedRequests: FakeArr['wantedRequests'] = [];
  const commands: FakeArr['commands'] = [];
  let renamePreview: unknown[] | ((query: Record<string, string>, callIndex: number) => unknown[]) = [];
  let commandOutcome = { status: 'completed', result: 'successful', message: null as string | null };
  let filesystem: Record<string, string[]> = {};
  const renameReads: FakeArr['renameReads'] = [];
  const filesystemReads: FakeArr['filesystemReads'] = [];
  const renameCallCounts = new Map<string, number>();

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

    if (url.pathname === `${apiBase}/wanted/missing`) {
      wantedRequests.push({ params: Object.fromEntries(url.searchParams.entries()) });
      const page = Number(url.searchParams.get('page') ?? '1');
      const pageSize = Number(url.searchParams.get('pageSize') ?? '200');
      const start = (page - 1) * pageSize;
      send(200, {
        page,
        pageSize,
        totalRecords: wantedTotalOverride ?? wanted.length,
        records: wanted.slice(start, start + pageSize),
      });
      return;
    }

    if (url.pathname === `${apiBase}/series`) {
      send(200, series);
      return;
    }

    if (url.pathname.startsWith(`${apiBase}/series/`)) {
      // Unset means "this read failed", which is a state the season
      // confirmation has to survive with its counts absent rather than zero.
      if (seriesDetail === null) {
        send(404, { error: 'Not found' });
        return;
      }
      send(200, seriesDetail);
      return;
    }

    if (url.pathname === `${apiBase}/qualityprofile`) {
      send(200, profiles);
      return;
    }

    // Sonarr pages and envelopes; Radarr answers a bare array on its own route.
    if (url.pathname === `${apiBase}/history`) {
      send(200, { page: 1, pageSize: history.length, totalRecords: history.length, records: history });
      return;
    }
    if (url.pathname === `${apiBase}/history/movie`) {
      send(200, history);
      return;
    }

    if (url.pathname === `${apiBase}/rename`) {
      const params = Object.fromEntries(url.searchParams.entries());
      renameReads.push({ params });
      const key = params.seriesId ?? params.movieId ?? '';
      const callIndex = renameCallCounts.get(key) ?? 0;
      renameCallCounts.set(key, callIndex + 1);
      send(200, typeof renamePreview === 'function'
        ? renamePreview(params, callIndex)
        : renamePreview);
      return;
    }

    if (url.pathname === `${apiBase}/filesystem`) {
      const path = url.searchParams.get('path') ?? '';
      filesystemReads.push(path);
      // Keyed on the path exactly as given. A caller that forgets the trailing
      // slash gets a miss here, which is the same class of wrong answer a real
      // instance gives — it resolves the parent — without this fake having to
      // model directory traversal to prove the point.
      send(200, {
        parent: null,
        directories: [],
        files: (filesystem[path] ?? []).map((name) => ({ name, path: `${path}${name}` })),
      });
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith(`${apiBase}/command/`)) {
      const id = Number(url.pathname.slice(`${apiBase}/command/`.length));
      send(200, { id, name: 'Command', ...commandOutcome });
      return;
    }

    if (url.pathname === `${apiBase}/movie`) {
      send(200, movies);
      return;
    }

    if (url.pathname.startsWith(`${apiBase}/movie/`)) {
      if (seriesDetail === null) {
        send(404, { error: 'Not found' });
        return;
      }
      send(200, seriesDetail);
      return;
    }

    if (req.method === 'POST' && url.pathname === `${apiBase}/command`) {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        try {
          commands.push({ body: JSON.parse(raw || '{}') as Record<string, unknown> });
        } catch {
          commands.push({ body: { unparseable: raw } });
        }
        if (commandStatus !== null) {
          send(commandStatus, { message: 'Command refused' });
          return;
        }
        send(201, { id: commands.length, name: (commands.at(-1)?.body.name as string) ?? '' });
      });
      return;
    }

    if (url.pathname === `${apiBase}/parse`) {
      // `null` is what a real *arr returns for a name it cannot place, and the
      // unresolved branch of the confirmation is built on exactly this answer.
      send(200, parseBody);
      return;
    }

    if (req.method === 'GET' && url.pathname === `${apiBase}/release`) {
      send(200, candidates);
      return;
    }

    if (req.method === 'POST' && url.pathname === `${apiBase}/release/push`) {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        try {
          pushes.push({ body: JSON.parse(raw || '{}') as Record<string, unknown> });
        } catch {
          pushes.push({ body: { unparseable: raw } });
        }
        if (typeof pushResult === 'number') {
          send(pushResult, { message: 'Push failed' });
          return;
        }
        // Sonarr answers with the pushed release, carrying the verdict.
        send(200, {
          title: (pushes.at(-1)?.body.title as string) ?? '',
          rejected: pushResult.rejected ?? false,
          rejections: pushResult.rejections ?? [],
        });
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
    pushes,
    wantedRequests,
    commands,
    setWanted: (records) => { wanted = records; },
    setWantedTotal: (total) => { wantedTotalOverride = total; },
    setSeries: (next) => { series = next; },
    setMovies: (next) => { movies = next; },
    setSeriesDetail: (next) => { seriesDetail = next; },
    setProfiles: (next) => { profiles = next; },
    setHistory: (events) => { history = events; },
    failCommands: (status) => { commandStatus = status; },
    setRenamePreview: (resolver) => { renamePreview = resolver; renameCallCounts.clear(); },
    renameReads,
    setCommandOutcome: (outcome) => { commandOutcome = { ...commandOutcome, ...outcome }; },
    setFilesystem: (entries) => { filesystem = entries; },
    filesystemReads,
    setParse: (body) => { parseBody = body; },
    setCandidates: (next) => { candidates = next; },
    setPushResult: (result) => { pushResult = result; },
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

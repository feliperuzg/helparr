import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { QueueRecord, TorrentState } from '@/lib/types';
import { QUEUE_CAUSES } from '@/lib/types';
import { cleanupTestDir } from './helpers/env';
import { deadPort, startFakeArr, type FakeArr } from './helpers/fakeArr';
import { startFakeQbit, type FakeQbit } from './helpers/fakeQbit';
import { closeDb } from '@/server/db';
import { createInstance, deleteInstance } from '@/server/instances/registry';
import { readQueue, resetQueueReadState } from '@/server/queue/aggregate';
import { classifyCause, IMPORT_NOT_PERFORMED_DWELL_MS } from '@/server/queue/cause';
import { enrichRecords } from '@/server/queue/enrich';
import { classifyStall } from '@/server/queue/stall';
import { disposeAllBreakers } from '@/server/resilience/breaker';

/**
 * T22 — every ADR-2 rule, in the order the table reads, plus the closed
 * taxonomy and per-instance degradation (REQ-QUEUE-018..020, -023).
 */

const NOW = 1_700_000_000_000;

function baseRecord(overrides: Partial<QueueRecord> = {}): QueueRecord {
  return {
    id: 'sonarr-1:1',
    recordId: 1,
    instanceId: 'sonarr-1',
    instanceLabel: 'Sonarr',
    instanceKind: 'sonarr',
    title: 'Show.S01E01.1080p.WEB-DL',
    targetLabel: 'Show — S01E01',
    size: 1_000_000_000,
    sizeleft: 0,
    protocol: 'torrent',
    indexer: 'Indexer',
    status: 'downloading',
    trackedDownloadStatus: 'ok',
    trackedDownloadState: 'downloading',
    statusMessages: [],
    errorMessage: null,
    downloadId: 'HASH1',
    estimatedCompletionTime: null,
    torrent: null,
    stall: { stalled: false, evidence: '' },
    cause: { kind: 'unknown', provenance: 'inferred', evidence: [], remedies: [] },
    ...overrides,
  };
}

function baseTorrent(overrides: Partial<TorrentState> = {}): TorrentState {
  return {
    hash: 'hash1',
    progress: 0.5,
    numSeeds: 5,
    numLeechs: 0,
    dlspeed: 500_000,
    eta: 100,
    state: 'downloading',
    fetchingMetadata: false,
    completionOn: null,
    ...overrides,
  };
}

describe('classifyCause — ADR-2 rules, first match wins', () => {
  it('Rule 1 (REQ-QUEUE-018): no torrent matched and no warning is unknown, never healthy', () => {
    const record = baseRecord({ status: 'downloading', trackedDownloadStatus: 'ok', statusMessages: [] });

    const result = classifyCause(record, null, NOW);

    expect(result.kind).toBe('unknown');
    expect(result.kind).not.toBe('healthy');
    expect(result.provenance).toBe('inferred');
    expect(result.evidence).toEqual([
      {
        source: 'helparr',
        text: 'No download-client torrent matched this record, and sonarr reported no warning.',
      },
    ]);
    expect(result.remedies).toEqual([]);
  });

  it('Rule 1 names the correct instance kind in its evidence', () => {
    const record = baseRecord({ instanceKind: 'radarr', statusMessages: [] });

    const result = classifyCause(record, null, NOW);

    expect(result.kind).toBe('unknown');
    expect(result.evidence[0].text).toContain('radarr reported no warning');
  });

  it('Rule 2: a client-reported missingFiles payload is payload-missing, with its remedy', () => {
    const record = baseRecord({ status: 'downloading' });
    const torrent = baseTorrent({ state: 'missingFiles' });

    const result = classifyCause(record, torrent, NOW);

    expect(result.kind).toBe('payload-missing');
    expect(result.provenance).toBe('inferred');
    expect(result.evidence).toEqual([{ source: 'qbittorrent', text: 'state missingFiles' }]);
    expect(result.remedies).toEqual(['remove-and-blocklist']);
  });

  it('Rule 2: a client-reported error state is also payload-missing', () => {
    const record = baseRecord({ status: 'downloading' });
    const torrent = baseTorrent({ state: 'error' });

    const result = classifyCause(record, torrent, NOW);

    expect(result.kind).toBe('payload-missing');
    expect(result.evidence).toEqual([{ source: 'qbittorrent', text: 'state error' }]);
  });

  it('Rule 2 wins over Rule 4: a record that is both completed+warning and client-missingFiles is payload-missing', () => {
    // First-match-wins (ADR-2): the table's rule 2 (payload-missing) is checked
    // before rule 4 (import-rejected), so a torrent the client has already given
    // up on is never reported merely as a rejected import.
    const record = baseRecord({
      status: 'completed',
      trackedDownloadStatus: 'warning',
      statusMessages: [{ title: 'Not a Custom Format upgrade', messages: ['skipping'] }],
    });
    const torrent = baseTorrent({ state: 'missingFiles' });

    const result = classifyCause(record, torrent, NOW);

    expect(result.kind).toBe('payload-missing');
  });

  it('Rule 3 (REQ-QUEUE-005): a stalled torrent is "stalled" with the stall verdict\'s own evidence, unchanged', () => {
    const record = baseRecord({ status: 'downloading', trackedDownloadStatus: 'ok' });
    const torrent = baseTorrent({ progress: 0.3, dlspeed: 0, numSeeds: 0 });
    const stall = classifyStall(torrent);
    expect(stall.stalled).toBe(true);

    const result = classifyCause(record, torrent, NOW);

    expect(result.kind).toBe('stalled');
    expect(result.provenance).toBe('inferred');
    // The evidence text is asserted equal to `classifyStall`'s own output —
    // reused, not re-derived.
    expect(result.evidence).toEqual([{ source: 'qbittorrent', text: stall.evidence }]);
    expect(result.evidence[0].text).toBe('0 peers, no progress');
    expect(result.remedies).toEqual(['remove-and-blocklist']);
  });

  it('Rule 3: a torrent stuck fetching metadata is "stalled" regardless of the *arr\'s own "ok" verdict', () => {
    const record = baseRecord({ status: 'downloading', trackedDownloadStatus: 'ok' });
    const torrent = baseTorrent({ fetchingMetadata: true, numSeeds: 0 });
    const stall = classifyStall(torrent);

    const result = classifyCause(record, torrent, NOW);

    expect(result.kind).toBe('stalled');
    expect(result.evidence[0].text).toBe(stall.evidence);
    expect(result.evidence[0].text).toContain('fetching metadata');
  });

  it('Rule 4 (REQ-QUEUE-020): import-rejected cites statusMessages verbatim, provenance reported, source is the arr kind', () => {
    const record = baseRecord({
      instanceKind: 'sonarr',
      status: 'completed',
      trackedDownloadStatus: 'warning',
      statusMessages: [
        { title: 'Not a Custom Format upgrade', messages: ['Not an upgrade for existing custom format'] },
        { title: 'Empty messages title', messages: [] },
      ],
    });

    const result = classifyCause(record, null, NOW);

    expect(result.kind).toBe('import-rejected');
    expect(result.provenance).toBe('reported');
    expect(result.evidence).toEqual([
      {
        source: 'sonarr',
        text: 'Not a Custom Format upgrade: Not an upgrade for existing custom format',
      },
      // No messages on the entry: the title stands alone rather than
      // appending an empty `: `.
      { source: 'sonarr', text: 'Empty messages title' },
    ]);
  });

  it('Rule 4: source is "radarr" on a Radarr record', () => {
    const record = baseRecord({
      instanceKind: 'radarr',
      status: 'completed',
      trackedDownloadStatus: 'warning',
      statusMessages: [{ title: 'Rejected', messages: ['reason'] }],
    });

    const result = classifyCause(record, null, NOW);

    expect(result.evidence[0].source).toBe('radarr');
  });

  it('Rule 4: force-import is offered only when the record has a downloadId', () => {
    const withDownloadId = baseRecord({
      status: 'completed',
      trackedDownloadStatus: 'warning',
      downloadId: 'HASH1',
      statusMessages: [{ title: 'Rejected', messages: ['reason'] }],
    });
    const withoutDownloadId = baseRecord({
      status: 'completed',
      trackedDownloadStatus: 'warning',
      downloadId: null,
      statusMessages: [{ title: 'Rejected', messages: ['reason'] }],
    });

    expect(classifyCause(withDownloadId, null, NOW).remedies).toEqual(['force-import', 'remove-and-blocklist']);
    expect(classifyCause(withoutDownloadId, null, NOW).remedies).toEqual(['remove-and-blocklist']);
  });

  describe('Rules 5/6: the five-minute client-completion dwell (REQ-QUEUE-018 / OQ-8)', () => {
    function completedRecord(overrides: Partial<QueueRecord> = {}): QueueRecord {
      return baseRecord({
        status: 'completed',
        trackedDownloadStatus: 'ok',
        trackedDownloadState: 'importPending',
        statusMessages: [],
        ...overrides,
      });
    }

    it('exactly at the boundary (completionOn = now - DWELL) is still "importing"', () => {
      const record = completedRecord();
      const torrent = baseTorrent({ progress: 1, dlspeed: 0, numSeeds: 1, completionOn: NOW - IMPORT_NOT_PERFORMED_DWELL_MS });

      const result = classifyCause(record, torrent, NOW);

      expect(result.kind).toBe('importing');
      expect(result.provenance).toBe('inferred');
      expect(result.remedies).toEqual(['wait']);
      expect(result.evidence).toEqual([
        { source: 'sonarr', text: 'trackedDownloadStatus ok' },
        { source: 'sonarr', text: 'trackedDownloadState importPending' },
        { source: 'qbittorrent', text: 'client completed 5m ago' },
      ]);
    });

    it('one millisecond past the boundary is "import-not-performed"', () => {
      const record = completedRecord();
      const torrent = baseTorrent({
        progress: 1,
        dlspeed: 0,
        numSeeds: 1,
        completionOn: NOW - IMPORT_NOT_PERFORMED_DWELL_MS - 1,
      });

      const result = classifyCause(record, torrent, NOW);

      expect(result.kind).toBe('import-not-performed');
      // force-import is offered because this record carries a downloadId
      // (REQ-QUEUE-021: the only two causes that can recommend it).
      expect(result.remedies).toEqual(['force-import']);
    });

    it('import-not-performed offers no remedy when the record has no downloadId', () => {
      const record = completedRecord({ downloadId: null });
      const torrent = baseTorrent({
        progress: 1,
        dlspeed: 0,
        numSeeds: 1,
        completionOn: NOW - IMPORT_NOT_PERFORMED_DWELL_MS - 1,
      });

      const result = classifyCause(record, torrent, NOW);

      expect(result.kind).toBe('import-not-performed');
      expect(result.remedies).toEqual([]);
    });

    it('completionOn null on an otherwise-matching completed record is never classified healthy', () => {
      // The dwell rules require the client's own completion clock
      // (`torrent.completionOn != null`); without it the record falls through
      // past rules 5/6 rather than asserting one of them. The code's rule 7
      // requires `status === 'downloading'`, which this record is not, so it
      // reaches rule 8: `unknown` — the safe outcome, never `healthy`.
      const record = completedRecord();
      const torrent = baseTorrent({ progress: 0.5, dlspeed: 500_000, numSeeds: 5, completionOn: null });

      const result = classifyCause(record, torrent, NOW);

      expect(result.kind).not.toBe('healthy');
      expect(result.kind).toBe('unknown');
    });
  });

  it('Rule 7: downloading with no stall is "healthy", reported, with no inferred callout', () => {
    const record = baseRecord({ status: 'downloading', trackedDownloadStatus: 'ok' });
    // Zero seeds but actively transferring — the stall rule requires ALL three
    // conditions (progress < 1 AND dlspeed === 0 AND numSeeds === 0), so a
    // nonzero transfer rate with no seeds is not a stall.
    const torrent = baseTorrent({ progress: 0.3, dlspeed: 400_000, numSeeds: 0 });
    expect(classifyStall(torrent).stalled).toBe(false);

    const result = classifyCause(record, torrent, NOW);

    expect(result.kind).toBe('healthy');
    expect(result.provenance).toBe('reported');
    expect(result.evidence).toEqual([
      { source: 'sonarr', text: 'trackedDownloadStatus ok' },
      { source: 'qbittorrent', text: `state ${torrent.state}` },
    ]);
    expect(result.remedies).toEqual([]);
  });

  it('Rule 7 needs the client side (REQ-QUEUE-018): downloading with a warning and no matched torrent is unknown, not healthy', () => {
    // Rule 1 does not catch this record — it carries a warning — so without a
    // torrent guard on rule 7 it would be called healthy on the *arr's word alone.
    const record = baseRecord({
      status: 'downloading',
      trackedDownloadStatus: 'warning',
      statusMessages: [{ title: 'Slow download', messages: [] }],
    });

    const result = classifyCause(record, null, NOW);

    expect(result.kind).toBe('unknown');
    expect(result.kind).not.toBe('healthy');
  });

  it('a torrent meeting the stall rule (0 peers, no progress) is "stalled" rather than "healthy", for the same downloading record shape', () => {
    const record = baseRecord({ status: 'downloading', trackedDownloadStatus: 'ok' });
    const torrent = baseTorrent({ progress: 0.3, dlspeed: 0, numSeeds: 0 });

    const result = classifyCause(record, torrent, NOW);

    expect(result.kind).toBe('stalled');
  });

  it('Rule 8: a status outside the table (queued), matched to a torrent, falls through to "unknown" with evidence naming the status', () => {
    const record = baseRecord({
      status: 'queued',
      trackedDownloadStatus: 'ok',
      trackedDownloadState: 'queued',
      statusMessages: [],
    });
    const torrent = baseTorrent({ progress: 0, dlspeed: 0, numSeeds: 3 });

    const result = classifyCause(record, torrent, NOW);

    expect(result.kind).toBe('unknown');
    expect(result.evidence).toEqual([
      {
        source: 'helparr',
        text: 'status queued, trackedDownloadStatus ok matched none of the closed taxonomy\'s rules.',
      },
    ]);
    expect(result.remedies).toEqual([]);
  });

  it('Rule 8: "paused" likewise falls through to "unknown"', () => {
    const record = baseRecord({
      status: 'paused',
      trackedDownloadStatus: 'ok',
      trackedDownloadState: 'paused',
      statusMessages: [],
    });
    const torrent = baseTorrent({ progress: 0.4, dlspeed: 0, numSeeds: 3 });

    const result = classifyCause(record, torrent, NOW);

    expect(result.kind).toBe('unknown');
    expect(result.evidence[0].text).toContain('status paused');
  });

  it('closed taxonomy (REQ-QUEUE-018): every result kind is a member of QUEUE_CAUSES', () => {
    const cases: Array<[QueueRecord, TorrentState | null]> = [
      [baseRecord({ statusMessages: [] }), null],
      [baseRecord({ status: 'downloading' }), baseTorrent({ state: 'missingFiles' })],
      [baseRecord({ status: 'downloading' }), baseTorrent({ progress: 0.1, dlspeed: 0, numSeeds: 0 })],
      [
        baseRecord({ status: 'completed', trackedDownloadStatus: 'warning', statusMessages: [{ title: 'x', messages: ['y'] }] }),
        null,
      ],
      [
        baseRecord({ status: 'completed', trackedDownloadStatus: 'ok', statusMessages: [] }),
        baseTorrent({ progress: 1, dlspeed: 0, numSeeds: 1, completionOn: NOW - 1000 }),
      ],
      [
        baseRecord({ status: 'completed', trackedDownloadStatus: 'ok', statusMessages: [] }),
        baseTorrent({ progress: 1, dlspeed: 0, numSeeds: 1, completionOn: NOW - IMPORT_NOT_PERFORMED_DWELL_MS - 1 }),
      ],
      [baseRecord({ status: 'downloading' }), baseTorrent({ progress: 0.5, dlspeed: 400_000, numSeeds: 2 })],
      [baseRecord({ status: 'queued', statusMessages: [] }), baseTorrent({ progress: 0, dlspeed: 0, numSeeds: 2 })],
    ];

    for (const [record, torrent] of cases) {
      const result = classifyCause(record, torrent, NOW);
      expect(QUEUE_CAUSES).toContain(result.kind);
    }
  });
});

describe('enrichRecords — exactly one cause per record, over a mixed batch (REQ-QUEUE-018)', () => {
  it('classifies every record in the batch, each to exactly one closed-taxonomy cause', () => {
    const records: QueueRecord[] = [
      baseRecord({ id: 'a', recordId: 1, downloadId: 'HASH-HEALTHY', status: 'downloading', statusMessages: [] }),
      baseRecord({ id: 'b', recordId: 2, downloadId: 'HASH-STALLED', status: 'downloading', statusMessages: [] }),
      baseRecord({ id: 'c', recordId: 3, downloadId: null, statusMessages: [] }),
      baseRecord({
        id: 'd',
        recordId: 4,
        downloadId: null,
        status: 'completed',
        trackedDownloadStatus: 'warning',
        statusMessages: [{ title: 'Rejected', messages: ['reason'] }],
      }),
    ];
    const torrents: TorrentState[] = [
      baseTorrent({ hash: 'hash-healthy', progress: 0.5, dlspeed: 400_000, numSeeds: 3, completionOn: null }),
      baseTorrent({ hash: 'hash-stalled', progress: 0.2, dlspeed: 0, numSeeds: 0, completionOn: null }),
    ];

    const result = enrichRecords(records, torrents, NOW);

    expect(result).toHaveLength(4);
    for (const record of result) {
      expect(QUEUE_CAUSES).toContain(record.cause.kind);
    }
    const byId = new Map(result.map((r) => [r.id, r]));
    expect(byId.get('a')?.cause.kind).toBe('healthy');
    expect(byId.get('b')?.cause.kind).toBe('stalled');
    expect(byId.get('c')?.cause.kind).toBe('unknown');
    expect(byId.get('d')?.cause.kind).toBe('import-rejected');
  });
});

/**
 * REQ-QUEUE-023 — the taxonomy degrades per instance, the same contract
 * `queue-resilience.test.ts` establishes for the read itself. These go through
 * the real `readQueue()` fan-out rather than calling `classifyCause` directly,
 * because the point under test is that one instance's outage never costs
 * another instance's rows their cause.
 */
describe('cause classification degrades per instance (REQ-QUEUE-023)', () => {
  const created: string[] = [];
  let sonarr: FakeArr;
  let radarr: FakeArr;
  let qbit: FakeQbit;

  beforeAll(async () => {
    sonarr = await startFakeArr({ apiKey: 'sonarr-key' });
    radarr = await startFakeArr({ apiKey: 'radarr-key' });
    qbit = await startFakeQbit({ username: 'admin', password: 'adminadmin' });
  });

  afterEach(() => {
    for (const id of created.splice(0)) deleteInstance(id);
    for (const arr of [sonarr, radarr]) {
      arr.hits.length = 0;
      arr.setMode('ok');
      arr.setQueue([]);
    }
    qbit.setTorrents([]);
    resetQueueReadState();
    disposeAllBreakers();
  });

  afterAll(async () => {
    closeDb();
    await sonarr.close();
    await radarr.close();
    await qbit.close();
    cleanupTestDir();
  });

  it('Radarr unreachable: Sonarr rows still carry causes, Radarr is named as an error, the screen is not empty', async () => {
    sonarr.setQueue([{
      id: 1,
      title: 'Show.S01E01.1080p.WEB-DL',
      status: 'downloading',
      trackedDownloadStatus: 'ok',
      trackedDownloadState: 'downloading',
      downloadId: 'SONARRHASH1',
      series: { title: 'Show' },
      episodes: [{ seasonNumber: 1, episodeNumber: 1 }],
    }]);
    radarr.setMode('server-error');

    const sonarrDto = createInstance({
      kind: 'sonarr',
      label: 'Sonarr',
      baseUrl: sonarr.url,
      credential: { type: 'api-key', apiKey: 'sonarr-key' },
    });
    created.push(sonarrDto.id);
    const radarrDto = createInstance({
      kind: 'radarr',
      label: 'Radarr',
      baseUrl: radarr.url,
      credential: { type: 'api-key', apiKey: 'radarr-key' },
    });
    created.push(radarrDto.id);
    created.push(createInstance({
      kind: 'download-client',
      label: 'qBittorrent',
      baseUrl: qbit.url,
      credential: { type: 'userpass', username: 'admin', password: 'adminadmin' },
    }).id);

    const result = await readQueue();

    // Not empty, and Radarr's outage is named rather than silently dropping
    // the screen's content.
    expect(result.records.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.instanceId === radarrDto.id)).toBe(true);

    const sonarrRecords = result.records.filter((r) => r.instanceId === sonarrDto.id);
    expect(sonarrRecords).toHaveLength(1);
    for (const record of sonarrRecords) {
      expect(QUEUE_CAUSES).toContain(record.cause.kind);
    }
  });

  it('download client unreachable: *arr rows are still classified, and none of them is "healthy" on an absent read', async () => {
    // No warning on either record, so Rule 1 (no torrent, no warning) is what
    // every row should resolve to once the download client cannot be read —
    // never "healthy", which rule 7 would otherwise require a downloading
    // status alone to reach.
    sonarr.setQueue([
      {
        id: 1,
        title: 'Show.S01E01.1080p.WEB-DL',
        status: 'downloading',
        trackedDownloadStatus: 'ok',
        trackedDownloadState: 'downloading',
        downloadId: 'SONARRHASH1',
        series: { title: 'Show' },
        episodes: [{ seasonNumber: 1, episodeNumber: 1 }],
      },
      {
        id: 2,
        title: 'Show.S01E02.1080p.WEB-DL',
        status: 'completed',
        trackedDownloadStatus: 'warning',
        trackedDownloadState: 'importPending',
        downloadId: 'SONARRHASH2',
        statusMessages: [{ title: 'Not a Custom Format upgrade', messages: ['skipping'] }],
        series: { title: 'Show' },
        episodes: [{ seasonNumber: 1, episodeNumber: 2 }],
      },
    ]);

    const sonarrDto = createInstance({
      kind: 'sonarr',
      label: 'Sonarr',
      baseUrl: sonarr.url,
      credential: { type: 'api-key', apiKey: 'sonarr-key' },
    });
    created.push(sonarrDto.id);
    // A download client no socket answers on — the registry has to be given a
    // real address, so `baseUrl` points at a port deliberately left dead.
    const port = await deadPort();
    const deadClient = createInstance({
      kind: 'download-client',
      label: 'qBittorrent',
      baseUrl: `http://127.0.0.1:${port}`,
      credential: { type: 'userpass', username: 'admin', password: 'adminadmin' },
    });
    created.push(deadClient.id);

    const result = await readQueue();

    expect(result.errors.some((e) => e.instanceId === deadClient.id)).toBe(true);
    expect(result.records).toHaveLength(2);
    for (const record of result.records) {
      expect(record.cause.kind).not.toBe('healthy');
      expect(QUEUE_CAUSES).toContain(record.cause.kind);
    }
    const byRecordId = new Map(result.records.map((r) => [r.recordId, r]));
    expect(byRecordId.get(1)?.cause.kind).toBe('unknown');
    expect(byRecordId.get(2)?.cause.kind).toBe('import-rejected');
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { cleanupTestDir } from './helpers/env';
import { startFakeArr, type FakeArr, type FakeQueueRecord } from './helpers/fakeArr';
import { startFakeQbit, type FakeQbit } from './helpers/fakeQbit';
import { clearAllSessions } from '@/server/clients/qbit';
import { closeDb } from '@/server/db';
import { createInstance, deleteInstance } from '@/server/instances/registry';
import { readQueue, resetQueueReadState } from '@/server/queue/aggregate';
import { disposeAllBreakers } from '@/server/resilience/breaker';

/**
 * T22 / REQ-QUEUE-005 — helparr is allowed to disagree with the *arr.
 *
 * The premise of the whole screen: a torrent stuck fetching metadata reports
 * `trackedDownloadStatus: "ok"` upstream, because from Sonarr's side nothing has
 * gone wrong — it handed the release to the client and is waiting. The stall
 * verdict therefore comes from download-client evidence alone, and the test
 * asserts exactly that disagreement rather than the agreement case.
 */

const created: string[] = [];

/** A record the *arr is perfectly happy with. */
function healthyRecord(id: number, downloadId: string | null): FakeQueueRecord {
  return {
    id,
    title: `Show.S02E${String(id).padStart(2, '0')}.2160p.WEB-DL`,
    size: 4_000_000_000,
    sizeleft: 4_000_000_000,
    protocol: downloadId ? 'torrent' : 'usenet',
    indexer: 'Indexer',
    status: 'downloading',
    trackedDownloadStatus: 'ok',
    trackedDownloadState: 'downloading',
    downloadId,
    series: { title: 'Show' },
    episodes: [{ seasonNumber: 2, episodeNumber: id }],
  };
}

describe('stall classification against the download client', () => {
  let sonarr: FakeArr;
  let qbit: FakeQbit;

  beforeAll(async () => {
    sonarr = await startFakeArr({ apiKey: 'sonarr-key' });
    qbit = await startFakeQbit({ username: 'admin', password: 'adminadmin' });

    created.push(createInstance({
      kind: 'sonarr',
      label: 'Sonarr',
      baseUrl: sonarr.url,
      credential: { type: 'api-key', apiKey: 'sonarr-key' },
    }).id);
    created.push(createInstance({
      kind: 'download-client',
      label: 'qBittorrent',
      baseUrl: qbit.url,
      credential: { type: 'userpass', username: 'admin', password: 'adminadmin' },
    }).id);
  });

  afterEach(() => {
    resetQueueReadState();
  });

  afterAll(async () => {
    for (const id of created.splice(0)) deleteInstance(id);
    disposeAllBreakers();
    clearAllSessions();
    closeDb();
    await sonarr.close();
    await qbit.close();
    cleanupTestDir();
  });

  it('flags a torrent stuck fetching metadata while its *arr record reports ok', async () => {
    sonarr.setQueue([healthyRecord(1, 'ABCDEF0123456789')]);
    qbit.setTorrents([{
      // Lowercase where the *arr wrote uppercase — the join is deliberately
      // case-insensitive (ADR-3).
      hash: 'abcdef0123456789',
      state: 'metaDL',
      progress: 0,
      num_seeds: 0,
      dlspeed: 0,
    }]);

    const result = await readQueue();

    expect(result.errors).toEqual([]);
    expect(result.records).toHaveLength(1);
    const [record] = result.records;

    // The disagreement, stated in one place: the *arr says this is fine.
    expect(record.trackedDownloadStatus).toBe('ok');
    expect(record.status).toBe('downloading');

    // helparr says otherwise, and cites the evidence rather than asserting it.
    expect(record.stall.stalled).toBe(true);
    expect(record.stall.evidence).toContain('metadata');
    expect(record.torrent?.fetchingMetadata).toBe(true);
    expect(record.torrent?.hash).toBe('abcdef0123456789');
  });

  it('flags a torrent with no peers and no progress', async () => {
    sonarr.setQueue([healthyRecord(2, 'BEEF0001')]);
    qbit.setTorrents([{
      hash: 'beef0001',
      state: 'stalledDL',
      progress: 0.42,
      num_seeds: 0,
      dlspeed: 0,
    }]);

    const result = await readQueue();

    expect(result.records[0].stall).toEqual({ stalled: true, evidence: '0 peers, no progress' });
  });

  it('leaves a healthy torrent and an un-joined record alone', async () => {
    sonarr.setQueue([
      healthyRecord(3, 'CAFE0001'),
      // Usenet: no torrent to consult. Absence of evidence is not evidence of a
      // stall, and flagging it would light up every usenet row in the queue.
      healthyRecord(4, null),
    ]);
    qbit.setTorrents([{
      hash: 'cafe0001',
      state: 'downloading',
      progress: 0.5,
      num_seeds: 12,
      dlspeed: 4_200_000,
    }]);

    const result = await readQueue();
    const byRecordId = new Map(result.records.map((r) => [r.recordId, r]));

    expect(byRecordId.get(3)?.stall.stalled).toBe(false);
    expect(byRecordId.get(3)?.torrent?.numSeeds).toBe(12);

    expect(byRecordId.get(4)?.torrent).toBeNull();
    expect(byRecordId.get(4)?.stall).toEqual({ stalled: false, evidence: '' });
  });
});

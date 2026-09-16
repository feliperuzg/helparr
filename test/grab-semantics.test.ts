import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { cleanupTestDir } from './helpers/env';
import { parsedSeries, startFakeArr, type FakeArr } from './helpers/fakeArr';
import { startFakeProwlarr, type FakeProwlarr } from './helpers/fakeProwlarr';
import { closeDb } from '@/server/db';
import { createInstance, deleteInstance } from '@/server/instances/registry';
import { listOperations, purgeOperations } from '@/server/operations/log';
import { disposeAllBreakers } from '@/server/resilience/breaker';
import { evaluateRelease, grab, resolveTarget } from '@/server/search/grab';

/**
 * T23 / FR7..FR9, REQ-OPS-001, -002, -007; ADR-2, ADR-3, ADR-5.
 *
 * The server half of "nothing is sent before the operator confirms". Everything
 * the confirmation needs — what the destination makes of the release name, and
 * what it would say about it — is a GET, and this suite asserts that by counting
 * the pushes the upstream actually received rather than by reading the code.
 *
 * The other half is `search-grab.test.ts`, which drives the real dialog in a
 * browser. Both are needed: this one proves the orchestration sends nothing, and
 * that one proves the UI never reaches the orchestration until confirm.
 */

const created: string[] = [];

const RELEASE = {
  title: 'Show.S01E01.1080p.WEB-DL-GROUP',
  downloadUrl: 'http://prowlarr.invalid/4/download?apikey=PROWLARR-API-KEY&guid=1',
  protocol: 'torrent' as const,
  publishDate: '2026-09-01T00:00:00Z',
  indexer: 'TorrentDay',
  entityRef: 'Show — S01E01',
};

describe('grab semantics', () => {
  let sonarr: FakeArr;
  let prowlarr: FakeProwlarr;
  let sonarrId: string;

  beforeAll(async () => {
    sonarr = await startFakeArr({ apiKey: 'sonarr-key' });
    prowlarr = await startFakeProwlarr({ apiKey: 'prowlarr-key' });
  });

  afterEach(() => {
    for (const id of created.splice(0)) deleteInstance(id);
    sonarr.hits.length = 0;
    sonarr.pushes.length = 0;
    sonarr.setParse(null);
    sonarr.setCandidates([]);
    sonarr.setPushResult({});
    sonarr.setMode('ok');
    purgeOperations();
    disposeAllBreakers();
  });

  afterAll(async () => {
    closeDb();
    await sonarr.close();
    await prowlarr.close();
    cleanupTestDir();
  });

  function register(): string {
    const dto = createInstance({
      kind: 'sonarr',
      label: 'Sonarr',
      baseUrl: sonarr.url,
      credential: { type: 'api-key', apiKey: 'sonarr-key' },
    });
    created.push(dto.id);
    sonarrId = dto.id;
    return dto.id;
  }

  /* ── Before the confirmation ────────────────────────────────────────────── */

  it('resolves what the destination will attach the release to, sending nothing', async () => {
    sonarr.setParse(parsedSeries({ quality: 'WEBDL-1080p', releaseGroup: 'GROUP' }));
    register();

    const resolved = await resolveTarget(sonarrId, RELEASE.title);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    // `/release/push` takes a title, not a target — so the confirmation names
    // what the *instance* resolved, not what the operator clicked (REQ-OPS-007).
    expect(resolved.value.resolved).toBe(true);
    expect(resolved.value.label).toBe('Show — S01E01');
    expect(resolved.value.seriesId).toBe(42);
    expect(resolved.value.quality).toBe('WEBDL-1080p');
    expect(resolved.value.releaseGroup).toBe('GROUP');

    // The whole point: a GET, and nothing else.
    expect(sonarr.pushes).toHaveLength(0);
    expect(sonarr.hits.every((hit) => hit.method === 'GET')).toBe(true);
    expect(sonarr.hits.some((hit) => hit.path.startsWith('/api/v3/parse'))).toBe(true);
  });

  it('degrades to the unresolved branch rather than refusing to continue', async () => {
    // A name Sonarr cannot place is a designed state of the dialog, not an
    // error: the operator can still grab, and the log will say "unresolved".
    sonarr.setParse(null);
    register();

    const resolved = await resolveTarget(sonarrId, 'Something.Unparseable');
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.resolved).toBe(false);
    expect(resolved.value.label).toBeNull();
    expect(sonarr.pushes).toHaveLength(0);
  });

  it('asks the destination for its own verdict without pushing anything', async () => {
    sonarr.setParse(parsedSeries());
    sonarr.setCandidates([{
      title: RELEASE.title,
      infoHash: 'HASH-1',
      guid: 'sonarr-1',
      // Both shapes the *arr APIs use, in one answer.
      rejections: [
        'Existing file meets cutoff: WEBDL-1080p',
        { reason: 'Not a preferred word upgrade for existing episode file(s)', type: 'permanent' },
      ],
    }]);
    register();

    const evaluated = await evaluateRelease(sonarrId, RELEASE.title, 'HASH-1');
    expect(evaluated.ok).toBe(true);
    if (!evaluated.ok) return;

    expect(evaluated.value.matched).toBe(true);
    // Verbatim: not sentence-cased, not summarised, not merged into one line.
    expect(evaluated.value.rejections).toEqual([
      'Existing file meets cutoff: WEBDL-1080p',
      'Not a preferred word upgrade for existing episode file(s)',
    ]);
    expect(sonarr.pushes).toHaveLength(0);
  });

  it('reports "the instance never returned this release" as such', async () => {
    sonarr.setParse(parsedSeries());
    sonarr.setCandidates([{ title: 'Some.Other.Release', infoHash: 'OTHER', rejections: ['no'] }]);
    register();

    const evaluated = await evaluateRelease(sonarrId, RELEASE.title, 'HASH-1');
    expect(evaluated.ok).toBe(true);
    if (!evaluated.ok) return;

    // Not an invented verdict. "Sonarr's own search never returned this" is
    // itself the answer the operator came for.
    expect(evaluated.value).toEqual({ matched: false, rejections: [] });
    expect(sonarr.pushes).toHaveLength(0);
  });

  /* ── The write ─────────────────────────────────────────────────────────── */

  it('sends the release exactly once and records the acceptance', async () => {
    sonarr.setPushResult({ rejected: false, rejections: [] });
    register();

    const outcome = await grab({ instanceId: sonarrId, ...RELEASE });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.value.status).toBe('succeeded');
    expect(outcome.value.rejected).toBe(false);
    expect(outcome.value.entityRef).toBe('Show — S01E01');

    // Once. A push is not idempotent from the operator's point of view, so
    // there is no retry — a landed push whose response was lost must not grab
    // the release a second time.
    expect(sonarr.pushes).toHaveLength(1);
    expect(sonarr.pushes[0].body).toMatchObject({
      title: RELEASE.title,
      downloadUrl: RELEASE.downloadUrl,
      protocol: 'torrent',
      publishDate: RELEASE.publishDate,
    });

    const log = listOperations();
    expect(log.operations).toHaveLength(1);
    expect(log.operations[0].outcome).toBe('succeeded');
    expect(log.operations[0].id).toBe(outcome.value.operationId);
    expect(log.operations[0].summary).toBe('Grabbed into Sonarr — Show — S01E01');
  });

  it('records a rejection as a failure and keeps every reason verbatim', async () => {
    const reasons = [
      'Existing file meets cutoff: WEBDL-1080p',
      'Not a preferred word upgrade for existing episode file(s)',
      'Quality WEBDL-1080p is not wanted in profile',
    ];
    sonarr.setPushResult({ rejected: true, rejections: reasons });
    register();

    const outcome = await grab({ instanceId: sonarrId, ...RELEASE });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // No optimistic success: the verdict comes from the response, and a
    // successful HTTP request that says no is still a refusal.
    expect(outcome.value.status).toBe('failed');
    expect(outcome.value.rejected).toBe(true);
    expect(outcome.value.rejections).toEqual(reasons);

    const [row] = listOperations().operations;
    // Recorded as "failed" verbatim (REQ-OPS-001), with `rejected` carrying the
    // split between "your profile said no" and "sonarr returned 502".
    expect(row.outcome).toBe('failed');
    expect(row.rejected).toBe(true);
    // Three reasons, three lines — a joined string would make two of them one.
    expect(row.detail).toEqual(reasons);
    expect(row.summary).toBe('Grab into Sonarr — Show — S01E01');
  });

  it('separates a transport failure from a rejection', async () => {
    sonarr.setPushResult(502);
    register();

    const outcome = await grab({ instanceId: sonarrId, ...RELEASE });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.value.status).toBe('failed');
    expect(outcome.value.rejected).toBe(false);
    expect(outcome.value.rejections).toEqual([]);
    expect(outcome.value.detail).not.toBeNull();

    // One attempt, one row — a failed push is still an attempt, and an attempt
    // that left no trace is the thing the log exists to prevent (ADR-6).
    expect(sonarr.pushes).toHaveLength(1);
    const [row] = listOperations().operations;
    expect(row.outcome).toBe('failed');
    expect(row.rejected).toBe(false);
    expect(row.detail).toHaveLength(1);
  });

  it('records the unresolved grab as unresolved rather than guessing', async () => {
    sonarr.setPushResult({ rejected: false });
    register();

    const outcome = await grab({ instanceId: sonarrId, ...RELEASE, entityRef: null });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const [row] = listOperations().operations;
    expect(row.summary).toBe('Grabbed into Sonarr — unresolved target');
    expect(row.entityRef).toBeNull();
  });

  /* ── Refusals: nothing sent, nothing logged ─────────────────────────────── */

  it('refuses a result that carried no link, before anything is sent', async () => {
    register();

    const outcome = await grab({ instanceId: sonarrId, ...RELEASE, downloadUrl: '' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.kind).toBe('no-url');

    // A refusal is not an attempt: nothing reached Sonarr, so there is nothing
    // to record and the log stays a record of writes only.
    expect(sonarr.pushes).toHaveLength(0);
    expect(listOperations().operations).toHaveLength(0);
  });

  it('refuses a destination that cannot take a release', async () => {
    const dto = createInstance({
      kind: 'prowlarr',
      label: 'Prowlarr',
      baseUrl: prowlarr.url,
      credential: { type: 'api-key', apiKey: 'prowlarr-key' },
    });
    created.push(dto.id);

    const outcome = await grab({ instanceId: dto.id, ...RELEASE });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.kind).toBe('not-grabbable');
    expect(outcome.refusal.reason).toContain('Sonarr or Radarr');
    expect(listOperations().operations).toHaveLength(0);
  });

  it('refuses an instance that is not registered', async () => {
    const outcome = await grab({ instanceId: 'no-such-instance', ...RELEASE });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.kind).toBe('no-instance');
    expect(listOperations().operations).toHaveLength(0);
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { cleanupTestDir } from './helpers/env';
import { fakeQueue, startFakeArr, type FakeArr } from './helpers/fakeArr';
import { closeDb } from '@/server/db';
import { createInstance, deleteInstance } from '@/server/instances/registry';
import { probeAll, resetHysteresis } from '@/server/health/poller';
import { readQueue, resetQueueReadState } from '@/server/queue/aggregate';
import { disposeAllBreakers, isOpen } from '@/server/resilience/breaker';

/**
 * T21 / REQ-QUEUE-007, -008, -010 — the degradation contract.
 *
 * Every case here is the same assertion from a different angle: one instance
 * failing costs the operator that instance's rows and nothing else. The failure
 * is named, attributed, and bounded, and the retry policy is asymmetric on
 * purpose — a 500 gets one more attempt, a rejected credential does not.
 */

const created: string[] = [];

function register(kind: 'sonarr' | 'radarr', label: string, arr: FakeArr, apiKey: string) {
  const dto = createInstance({
    kind,
    label,
    baseUrl: arr.url,
    credential: { type: 'api-key', apiKey },
  });
  created.push(dto.id);
  return dto;
}

function queueHits(arr: FakeArr): number {
  return arr.hits.filter((h) => h.path.startsWith('/api/v3/queue')).length;
}

describe('queue read degradation', () => {
  let sonarr: FakeArr;
  let radarr: FakeArr;

  beforeAll(async () => {
    sonarr = await startFakeArr({ apiKey: 'sonarr-key' });
    radarr = await startFakeArr({ apiKey: 'radarr-key' });
  });

  afterEach(() => {
    for (const id of created.splice(0)) deleteInstance(id);
    for (const arr of [sonarr, radarr]) {
      arr.hits.length = 0;
      arr.setMode('ok');
      arr.setQueue([]);
      arr.setDelay(0);
    }
    resetQueueReadState();
    resetHysteresis();
    disposeAllBreakers();
  });

  afterAll(async () => {
    closeDb();
    await sonarr.close();
    await radarr.close();
    cleanupTestDir();
  });

  it('attributes an upstream 500 to its instance and keeps the other one whole', async () => {
    sonarr.setQueue(fakeQueue(4));
    radarr.setMode('server-error');
    const sonarrDto = register('sonarr', 'Sonarr', sonarr, 'sonarr-key');
    const radarrDto = register('radarr', 'Radarr', radarr, 'radarr-key');

    const result = await readQueue();

    // The healthy instance is untouched. This is the whole point of the
    // fan-out: Radarr being broken must not cost the operator Sonarr's rows.
    expect(result.records).toHaveLength(4);
    expect(result.records.every((r) => r.instanceId === sonarrDto.id)).toBe(true);

    expect(result.errors).toHaveLength(1);
    const [error] = result.errors;
    expect(error.instanceId).toBe(radarrDto.id);
    expect(error.instanceLabel).toBe('Radarr');
    expect(error.kind).toBe('upstream-error');
    expect(error.reason).toContain('500');
    expect(error.retryAt).toBeNull();

    // Exactly one retry (REQ-QUEUE-010): a 500 is often a restarting upstream,
    // so it is worth a second attempt — but only one.
    expect(queueHits(radarr)).toBe(2);

    // A failed instance has no successful read to stamp, which is what makes
    // the banner able to say how stale the remaining rows are.
    expect(result.lastReadAt[radarrDto.id]).toBeUndefined();
    expect(result.lastReadAt[sonarrDto.id]).toBeTruthy();
  });

  it('does not retry a rejected credential', async () => {
    radarr.setMode('unauthorized');
    const radarrDto = register('radarr', 'Radarr', radarr, 'radarr-key');

    const result = await readQueue();

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].kind).toBe('unauthorized');

    // One request, not two. Retrying a 401 only doubles the failed-login noise
    // in someone's log, and against a download client it can earn a temporary
    // IP ban.
    expect(queueHits(radarr)).toBe(1);

    // And it never opens the breaker: the endpoint is up and answering, the
    // credential is simply wrong. "Not contacted" would be the wrong thing to
    // tell an operator who is in the middle of pasting a new key.
    expect(isOpen(radarrDto.id)).toBe(false);
  });

  it('opens the breaker after repeated failures and then issues no request at all', async () => {
    sonarr.setQueue(fakeQueue(2));
    radarr.setMode('server-error');
    const sonarrDto = register('sonarr', 'Sonarr', sonarr, 'sonarr-key');
    const radarrDto = register('radarr', 'Radarr', radarr, 'radarr-key');

    await readQueue();
    await readQueue();
    expect(isOpen(radarrDto.id)).toBe(true);

    const hitsBeforeOpen = queueHits(radarr);
    const result = await readQueue();

    // REQ-QUEUE-008, literally: no socket is opened while the circuit is open.
    expect(queueHits(radarr)).toBe(hitsBeforeOpen);

    const error = result.errors.find((e) => e.instanceId === radarrDto.id);
    expect(error?.kind).toBe('circuit-open');
    // The rail renders this as "next attempt in 3m 40s" — the operator needs to
    // tell "we tried and it failed" apart from "we have stopped trying".
    expect(error?.retryAt).toBeTruthy();

    // The healthy instance is still read on the same cycle, and still hits the
    // network — one open breaker is one instance, not a global pause.
    expect(result.records).toHaveLength(2);
    expect(result.records.every((r) => r.instanceId === sonarrDto.id)).toBe(true);
    expect(isOpen(sonarrDto.id)).toBe(false);
  });

  it('surfaces the open breaker through the health probe, not just the queue read', async () => {
    radarr.setMode('server-error');
    const sonarrDto = register('sonarr', 'Sonarr', sonarr, 'sonarr-key');
    const radarrDto = register('radarr', 'Radarr', radarr, 'radarr-key');

    await readQueue();
    await readQueue();
    expect(isOpen(radarrDto.id)).toBe(true);

    // The probe shares the breaker with the queue read, so an instance that has
    // been given up on cannot keep answering "ok" on the rail. `unreachable`
    // plus a `retryAt` is exactly the pair InstanceHealthRail maps to
    // "not contacted" — the state that tells the operator we stopped trying
    // rather than that we tried and failed.
    const health = await probeAll();
    const radarrHealth = health.instances.find((i) => i.instanceId === radarrDto.id);
    expect(radarrHealth?.state).toBe('unreachable');
    expect(radarrHealth?.retryAt).toBeTruthy();
    expect(radarrHealth?.reason).toBeTruthy();

    // And it costs no request: the rail goes quiet with the read.
    expect(radarr.hits.filter((h) => h.path.startsWith('/api/v3/system/status'))).toHaveLength(0);

    // The healthy instance is probed normally on the same pass.
    const sonarrHealth = health.instances.find((i) => i.instanceId === sonarrDto.id);
    expect(sonarrHealth?.state).toBe('ok');
    expect(sonarrHealth?.retryAt).toBeNull();
    expect(health.degradedCount).toBe(1);
  });

  it('abandons a slow instance at the deadline and returns with everyone else', async () => {
    sonarr.setQueue(fakeQueue(3));
    radarr.setQueue(fakeQueue(3));
    radarr.setDelay(5_000);
    const sonarrDto = register('sonarr', 'Sonarr', sonarr, 'sonarr-key');
    const radarrDto = register('radarr', 'Radarr', radarr, 'radarr-key');

    // The caller's deadline, shorter than the fan-out's own 8s backstop so the
    // test asserts the mechanism rather than waiting on it.
    const started = Date.now();
    const result = await readQueue(AbortSignal.timeout(300));
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(4_000);

    expect(result.records).toHaveLength(3);
    expect(result.records.every((r) => r.instanceId === sonarrDto.id)).toBe(true);

    const error = result.errors.find((e) => e.instanceId === radarrDto.id);
    expect(error?.kind).toBe('timeout');

    // A timeout is not retried either: the budget that exists to stop one slow
    // instance holding the screen is already spent.
    expect(queueHits(radarr)).toBe(1);
  });
});

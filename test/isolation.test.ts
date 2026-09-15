import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cleanupTestDir } from './helpers/env';
import { deadPort, startFakeArr, type FakeArr } from './helpers/fakeArr';
import { closeDb } from '@/server/db';
import { probeAll, resetHysteresis } from '@/server/health/poller';
import { createInstance } from '@/server/instances/registry';
import { disposeAllBreakers } from '@/server/resilience/breaker';

/**
 * T19 / AC10 — a failing instance is isolated.
 *
 * `project.md` states the requirement plainly: Prowlarr being down must not
 * break the Gaps or Rename screens. The mechanism is a per-instance breaker
 * plus an allSettled fan-out, so this asserts the observable consequence: the
 * healthy instances still report ok, and the failure is scoped to one row.
 */
describe('per-instance failure isolation', () => {
  let sonarr: FakeArr;
  let radarr: FakeArr;
  let prowlarrPort: number;

  beforeAll(async () => {
    sonarr = await startFakeArr({ apiKey: 'sonarr-key', version: '4.0.10.2544' });
    radarr = await startFakeArr({ apiKey: 'radarr-key', version: '5.14.0.9383' });
    prowlarrPort = await deadPort();

    createInstance({
      kind: 'sonarr', label: 'Sonarr', baseUrl: sonarr.url,
      credential: { type: 'api-key', apiKey: 'sonarr-key' },
    });
    createInstance({
      kind: 'radarr', label: 'Radarr', baseUrl: radarr.url,
      credential: { type: 'api-key', apiKey: 'radarr-key' },
    });
    createInstance({
      kind: 'prowlarr', label: 'Prowlarr', baseUrl: `http://127.0.0.1:${prowlarrPort}`,
      credential: { type: 'api-key', apiKey: 'prowlarr-key' },
    });
  });

  afterAll(async () => {
    disposeAllBreakers();
    closeDb();
    await sonarr.close();
    await radarr.close();
    cleanupTestDir();
  });

  it('absorbs a single failure without flapping the badge', async () => {
    resetHysteresis();
    const first = await probeAll();

    const prowlarr = first.instances.find((i) => i.kind === 'prowlarr');
    // Hysteresis: one failed probe is not yet a down instance, so the operator
    // keeps seeing the previous state rather than a badge that flickers.
    expect(prowlarr?.state).not.toBe('unreachable');

    expect(first.instances.find((i) => i.kind === 'sonarr')?.state).toBe('ok');
    expect(first.instances.find((i) => i.kind === 'radarr')?.state).toBe('ok');
  });

  it('reports the down instance, and only that instance, on the second failure', async () => {
    const second = await probeAll();

    const byKind = Object.fromEntries(second.instances.map((i) => [i.kind, i]));

    expect(byKind.sonarr?.state).toBe('ok');
    expect(byKind.sonarr?.version).toBe('4.0.10.2544');
    expect(byKind.radarr?.state).toBe('ok');
    expect(byKind.radarr?.version).toBe('5.14.0.9383');

    expect(byKind.prowlarr?.state).toBe('unreachable');
    expect(byKind.prowlarr?.reason).toBeTruthy();

    // Exactly one instance is degraded — the failure did not generalise into a
    // global error state.
    expect(second.degradedCount).toBe(1);
  });

  it('keeps answering for the healthy instances once the breaker has opened', async () => {
    // Enough rounds to trip the breaker on the dead host. Once it is open the
    // fallback answers without a network call, and the healthy instances must
    // be entirely unaffected by that.
    for (let i = 0; i < 3; i += 1) await probeAll();

    const result = await probeAll();
    expect(result.instances.find((i) => i.kind === 'sonarr')?.state).toBe('ok');
    expect(result.instances.find((i) => i.kind === 'radarr')?.state).toBe('ok');
    expect(result.degradedCount).toBe(1);
  });

  it('recovers the healthy instances when one of them starts failing too', async () => {
    radarr.setMode('unauthorized');
    await probeAll();
    const result = await probeAll();

    // A rejected credential is deterministic, so it is reported immediately —
    // it is never subject to the two-failure hysteresis.
    expect(result.instances.find((i) => i.kind === 'radarr')?.state).toBe('unauthorized');
    expect(result.instances.find((i) => i.kind === 'sonarr')?.state).toBe('ok');

    radarr.setMode('ok');
    const recovered = await probeAll();
    expect(recovered.instances.find((i) => i.kind === 'radarr')?.state).toBe('ok');
  });
});

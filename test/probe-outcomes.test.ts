import { describe, expect, it } from 'vitest';

import { ArrClient } from '@/server/clients/arr';
import { deadPort, startFakeArr } from './helpers/fakeArr';

/**
 * T18 / AC2–AC4 — the four connection-test outcomes are distinguished.
 *
 * They are separate states rather than "worked / did not work" because the
 * operator's next action differs for every one: paste a new key, start the
 * service, fix the base URL, or look at the reverse proxy.
 */
describe('connection test outcomes', () => {
  it('reports ok with the reported version and a latency', async () => {
    const fake = await startFakeArr({ apiKey: 'good-key', version: '4.0.10.2544' });
    try {
      const result = await new ArrClient({
        kind: 'sonarr',
        baseUrl: fake.url,
        credential: { type: 'api-key', apiKey: 'good-key' },
      }).probe();

      expect(result.state).toBe('ok');
      if (result.state !== 'ok') return;
      expect(result.version).toBe('4.0.10.2544');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);

      // The probe hits system/status, not /health: /health only replays
      // upstream's cached task results and can abort entirely when the host is
      // offline, which would make "no problems" indistinguishable from "down".
      expect(fake.hits.at(-1)?.path).toContain('/api/v3/system/status');
      expect(fake.hits.at(-1)?.apiKey).toBe('good-key');
    } finally {
      await fake.close();
    }
  });

  it('reports unauthorized when the key is rejected', async () => {
    const fake = await startFakeArr({ apiKey: 'good-key' });
    try {
      const result = await new ArrClient({
        kind: 'sonarr',
        baseUrl: fake.url,
        credential: { type: 'api-key', apiKey: 'wrong-key' },
      }).probe();

      expect(result.state).toBe('unauthorized');
      expect(result.state === 'unauthorized' && result.reason).toBeTruthy();
    } finally {
      await fake.close();
    }
  });

  it('reports unreachable when nothing is listening', async () => {
    const port = await deadPort();
    const result = await new ArrClient({
      kind: 'sonarr',
      baseUrl: `http://127.0.0.1:${port}`,
      credential: { type: 'api-key', apiKey: 'any' },
    }).probe();

    expect(result.state).toBe('unreachable');
    expect(result.state === 'unreachable' && result.reason).toBeTruthy();
  });

  it('reports an unexpected response when something answers with HTML', async () => {
    const fake = await startFakeArr({ apiKey: 'good-key', mode: 'html' });
    try {
      const result = await new ArrClient({
        kind: 'sonarr',
        baseUrl: fake.url,
        credential: { type: 'api-key', apiKey: 'good-key' },
      }).probe();

      // Distinct from unreachable: something IS listening, it just is not the
      // API. Usually a reverse proxy login page or the wrong port.
      expect(result.state).toBe('degraded');
      expect(result.state === 'degraded' && result.reason).toBeTruthy();
    } finally {
      await fake.close();
    }
  });

  it('reports an unexpected response when the base URL points at the wrong path', async () => {
    const fake = await startFakeArr({ apiKey: 'good-key', mode: 'notfound' });
    try {
      const result = await new ArrClient({
        kind: 'sonarr',
        baseUrl: fake.url,
        credential: { type: 'api-key', apiKey: 'good-key' },
      }).probe();

      expect(result.state).toBe('degraded');
      expect(result.state === 'degraded' && result.reason).toMatch(/base URL/i);
    } finally {
      await fake.close();
    }
  });

  it('uses /api/v1 for Prowlarr and /api/v3 for Sonarr and Radarr', async () => {
    const prowlarr = await startFakeArr({ apiKey: 'k', apiBase: '/api/v1' });
    try {
      const ok = await new ArrClient({
        kind: 'prowlarr',
        baseUrl: prowlarr.url,
        credential: { type: 'api-key', apiKey: 'k' },
      }).probe();
      expect(ok.state).toBe('ok');
      expect(prowlarr.hits.at(-1)?.path).toContain('/api/v1/system/status');

      // The same server refuses a v3 probe — which is exactly the failure a
      // hardcoded /api/v3 would cause against a real Prowlarr.
      const wrong = await new ArrClient({
        kind: 'sonarr',
        baseUrl: prowlarr.url,
        credential: { type: 'api-key', apiKey: 'k' },
      }).probe();
      expect(wrong.state).not.toBe('ok');
    } finally {
      await prowlarr.close();
    }
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { cleanupTestDir } from './helpers/env';
import { startFakeArr, type FakeArr } from './helpers/fakeArr';
import { closeDb } from '@/server/db';
import { createInstance, deleteInstance } from '@/server/instances/registry';
import { disposeAllBreakers } from '@/server/resilience/breaker';
import { readUnmapped } from '@/server/unmapped/aggregate';

/**
 * T25 / REQ-GAPS-025, -026; ADR-9.
 *
 * The whole point of this read is that "unknown" and "none" are never allowed
 * to collapse into each other, and that a down instance never costs the
 * operator the roots an instance that answered is still holding. Every case
 * here is one of those two guarantees from a different angle, plus the
 * read-only guarantee ADR-9 makes explicit: this screen cannot mutate
 * anything, so no fake ever sees a write.
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

describe('unmapped folders aggregation', () => {
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
      arr.commands.length = 0;
      arr.setMode('ok');
      arr.setRootFolders([]);
    }
    disposeAllBreakers();
  });

  afterAll(async () => {
    closeDb();
    await sonarr.close();
    await radarr.close();
    cleanupTestDir();
  });

  it('reports unknown, never none, when the key is absent entirely', async () => {
    // Omitting `unmappedFolders` is how the fake models a scan that ran out of
    // its own budget before this root folder — REQ-GAPS-023/-026, ADR-9.
    sonarr.setRootFolders([{ id: 1, path: '/tv', accessible: true, freeSpace: 1_000 }]);
    register('sonarr', 'Sonarr', sonarr, 'sonarr-key');

    const result = await readUnmapped();

    const [instance] = result.instances;
    expect(instance.status).toBe('ok');
    const [root] = instance.roots;
    expect(root.state).toBe('unknown');
    expect(root.count).toBeNull();
    expect(root.folders).toEqual([]);
  });

  it('reports none, with a count of zero, when the key is present but empty', async () => {
    sonarr.setRootFolders([{
      id: 1, path: '/tv', accessible: true, freeSpace: 1_000, unmappedFolders: [],
    }]);
    register('sonarr', 'Sonarr', sonarr, 'sonarr-key');

    const [root] = (await readUnmapped()).instances[0].roots;

    expect(root.state).toBe('none');
    expect(root.count).toBe(0);
    expect(root.folders).toEqual([]);
  });

  it('lists one row per unmapped folder, attributed to its instance, with an encoded search link', async () => {
    sonarr.setRootFolders([{
      id: 1,
      path: '/tv',
      accessible: true,
      freeSpace: 2_000,
      unmappedFolders: [
        { name: 'Some Show & Friends', path: '/tv/Some Show & Friends', relativePath: null },
      ],
    }]);
    const dto = register('sonarr', 'Sonarr', sonarr, 'sonarr-key');

    const [root] = (await readUnmapped()).instances[0].roots;

    expect(root.state).toBe('listed');
    expect(root.count).toBe(1);
    expect(root.freeSpace).toBe(2_000);
    const [row] = root.folders;
    expect(row.instanceId).toBe(dto.id);
    expect(row.instanceLabel).toBe('Sonarr');
    expect(row.instanceKind).toBe('sonarr');
    expect(row.rootPath).toBe('/tv');
    expect(row.name).toBe('Some Show & Friends');
    expect(row.path).toBe('/tv/Some Show & Friends');
    expect(row.searchUrl).toBe(`/search?q=${encodeURIComponent('Some Show & Friends')}`);
    // A literal `&` or space in the raw name would otherwise land in the URL
    // unescaped and either break the query string or merge with another param.
    expect(row.searchUrl).not.toContain(' ');
    expect(row.searchUrl).not.toMatch(/[^=]&/);
  });

  it('names Radarr as unreachable while Sonarr\'s roots still render', async () => {
    sonarr.setRootFolders([{
      id: 1, path: '/tv', accessible: true, freeSpace: 1_000, unmappedFolders: [],
    }]);
    radarr.setMode('server-error');
    const sonarrDto = register('sonarr', 'Sonarr', sonarr, 'sonarr-key');
    const radarrDto = register('radarr', 'Radarr', radarr, 'radarr-key');

    const result = await readUnmapped();

    const radarrInstance = result.instances.find((i) => i.instanceId === radarrDto.id);
    expect(radarrInstance?.status).toBe('unreachable');
    expect(radarrInstance?.error).toBeTruthy();
    expect(radarrInstance?.roots).toEqual([]);

    const sonarrInstance = result.instances.find((i) => i.instanceId === sonarrDto.id);
    expect(sonarrInstance?.status).toBe('ok');
    expect(sonarrInstance?.roots).toHaveLength(1);
    expect(sonarrInstance?.roots[0].state).toBe('none');
  });

  it('attributes multiple roots across both instances correctly', async () => {
    sonarr.setRootFolders([
      {
        id: 1, path: '/tv', accessible: true, freeSpace: 1_000,
        unmappedFolders: [{ name: 'Orphan A', path: '/tv/Orphan A', relativePath: null }],
      },
      {
        id: 2, path: '/tv2', accessible: true, freeSpace: 2_000, unmappedFolders: [],
      },
    ]);
    radarr.setRootFolders([
      {
        id: 1, path: '/movies', accessible: true, freeSpace: 3_000,
        unmappedFolders: [
          { name: 'Orphan B', path: '/movies/Orphan B', relativePath: null },
          { name: 'Orphan C', path: '/movies/Orphan C', relativePath: null },
        ],
      },
    ]);
    const sonarrDto = register('sonarr', 'Sonarr', sonarr, 'sonarr-key');
    const radarrDto = register('radarr', 'Radarr', radarr, 'radarr-key');

    const result = await readUnmapped();

    const sonarrInstance = result.instances.find((i) => i.instanceId === sonarrDto.id)!;
    expect(sonarrInstance.roots).toHaveLength(2);
    expect(sonarrInstance.roots[0].rootPath).toBe('/tv');
    expect(sonarrInstance.roots[0].state).toBe('listed');
    expect(sonarrInstance.roots[0].folders[0].instanceId).toBe(sonarrDto.id);
    expect(sonarrInstance.roots[1].rootPath).toBe('/tv2');
    expect(sonarrInstance.roots[1].state).toBe('none');

    const radarrInstance = result.instances.find((i) => i.instanceId === radarrDto.id)!;
    expect(radarrInstance.roots).toHaveLength(1);
    expect(radarrInstance.roots[0].count).toBe(2);
    expect(radarrInstance.roots[0].folders.map((f) => f.name)).toEqual(['Orphan B', 'Orphan C']);
    expect(radarrInstance.roots[0].folders.every((f) => f.instanceId === radarrDto.id)).toBe(true);
    expect(radarrInstance.roots[0].folders.every((f) => f.instanceKind === 'radarr')).toBe(true);
  });

  it('carries freeSpace through for every state', async () => {
    sonarr.setRootFolders([
      { id: 1, path: '/tv', accessible: true, freeSpace: 12_345 },
      { id: 2, path: '/tv2', accessible: true, freeSpace: 0, unmappedFolders: [] },
      {
        id: 3, path: '/tv3', accessible: true, freeSpace: 999,
        unmappedFolders: [{ name: 'X', path: '/tv3/X', relativePath: null }],
      },
    ]);
    register('sonarr', 'Sonarr', sonarr, 'sonarr-key');

    const [root1, root2, root3] = (await readUnmapped()).instances[0].roots;
    expect(root1.freeSpace).toBe(12_345);
    expect(root2.freeSpace).toBe(0);
    expect(root3.freeSpace).toBe(999);
  });

  it('never sends a write of any kind to any instance', async () => {
    sonarr.setRootFolders([{
      id: 1, path: '/tv', accessible: true, freeSpace: 1_000,
      unmappedFolders: [{ name: 'Orphan', path: '/tv/Orphan', relativePath: null }],
    }]);
    radarr.setMode('server-error');
    register('sonarr', 'Sonarr', sonarr, 'sonarr-key');
    register('radarr', 'Radarr', radarr, 'radarr-key');

    await readUnmapped();

    // ADR-9: this screen is a read, full stop. A POST to /command on either
    // instance would mean it had started adding or searching on its own.
    expect(sonarr.commands).toEqual([]);
    expect(radarr.commands).toEqual([]);
  });
});

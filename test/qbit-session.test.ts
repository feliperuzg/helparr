import { afterEach, describe, expect, it } from 'vitest';

import { startFakeQbit, type FakeQbit } from './helpers/fakeQbit';
import { QbitClient, clearAllSessions, extractSessionCookie } from '@/server/clients/qbit';

/**
 * The session cookie's *name* is version-dependent.
 *
 * qBittorrent 5.1 renamed it from `SID` to `QBT_SID_<port>` so two instances on
 * one host stop clobbering each other's session. A client that looks for `SID=`
 * finds nothing and reports a perfectly good password as rejected; one that
 * finds the value but replays it under an assumed name gets a 403 that looks
 * exactly like an expired session.
 *
 * Found against a live server (v5.2.3 / WebAPI 2.15.1). It survived an entire
 * feature because the fake emitted the pre-5.1 name — so these tests
 * pin both names, and the fake now defaults to the one real servers send.
 */

const open: FakeQbit[] = [];

async function qbitClient(options: { legacyCookieName?: boolean } = {}) {
  const qbit = await startFakeQbit({
    username: 'admin',
    password: 'adminadmin',
    ...options,
  });
  open.push(qbit);

  const client = new QbitClient(`instance-${open.length}`, {
    kind: 'download-client',
    baseUrl: qbit.url,
    credential: { type: 'userpass', username: 'admin', password: 'adminadmin' },
  });

  return { qbit, client };
}

afterEach(async () => {
  clearAllSessions();
  await Promise.all(open.splice(0).map((q) => q.close()));
});

describe('qBittorrent session cookie', () => {
  it('logs in against a current server, which names the cookie QBT_SID_<port>', async () => {
    const { client } = await qbitClient();

    const result = await client.probe();

    // Before the fix this was `unauthorized` — the password was fine, the
    // client simply could not see the cookie it was handed.
    expect(result.state).toBe('ok');
    if (result.state === 'ok') expect(result.version).toBe('v5.2.3');
  });

  it('replays the cookie under the name the server issued, not an assumed one', async () => {
    const { qbit, client } = await qbitClient();

    // The fake 403s any request whose Cookie header is not byte-identical to
    // what it set, which is what a real server does. Reaching the torrent list
    // at all proves the name survived the round trip.
    const torrents = await client.torrents(AbortSignal.timeout(5_000));
    expect(torrents.ok).toBe(true);

    // And it did so on one login, not on a re-login papering over a 403.
    expect(qbit.hits.filter((h) => h.path === '/api/v2/auth/login')).toHaveLength(1);
  });

  it('still logs in against a pre-5.1 server, which names it SID', async () => {
    const { client } = await qbitClient({ legacyCookieName: true });

    // Both names are in the field; dropping the old one would trade one broken
    // deployment for another.
    const result = await client.probe();
    expect(result.state).toBe('ok');
  });

  it('reads the name and value off the cookie without mistaking its metadata', async () => {
    const current = new Headers();
    current.append('set-cookie', 'QBT_SID_8080=abc123; HttpOnly; SameSite=Lax; path=/');
    expect(extractSessionCookie(current)).toBe('QBT_SID_8080=abc123');

    const legacy = new Headers();
    legacy.append('set-cookie', 'SID=abc123; HttpOnly; path=/');
    expect(extractSessionCookie(legacy)).toBe('SID=abc123');

    // An unrelated cookie is not a session. Returning one would send the client
    // into a re-login loop against a server that is answering correctly.
    const unrelated = new Headers();
    unrelated.append('set-cookie', 'theme=dark; path=/');
    expect(extractSessionCookie(unrelated)).toBeNull();

    // Neither is a name that merely contains the old one.
    const lookalike = new Headers();
    lookalike.append('set-cookie', 'NOT_A_SID=abc123; path=/');
    expect(extractSessionCookie(lookalike)).toBeNull();

    // A session cookie among others is still found.
    const mixed = new Headers();
    mixed.append('set-cookie', 'theme=dark; path=/');
    mixed.append('set-cookie', 'QBT_SID_9091=xyz789; HttpOnly; path=/');
    expect(extractSessionCookie(mixed)).toBe('QBT_SID_9091=xyz789');
  });
});

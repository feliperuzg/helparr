#!/usr/bin/env node
/**
 * T26 / ADR-3 — verify the `downloadId` ↔ torrent-hash assumption against a
 * live pair.
 *
 * ADR-3 says *arr writes the infohash into `downloadId` uppercase while
 * qBittorrent reports `hash` lowercase, so `src/server/queue/enrich.ts` joins
 * the two case-insensitively and never on title. That claim comes from the
 * upstream sources, not from this deployment — which is exactly why it is worth
 * checking against real hardware before trusting an entire screen to it.
 *
 * This is a read-only script. It issues GETs (plus the one POST qBittorrent
 * requires to log in), mutates nothing, and prints no credentials — hashes are
 * truncated in the output so a shared terminal log does not become a list of
 * what the operator is downloading.
 *
 * Usage:
 *
 *   SONARR_URL=http://10.0.0.5:8989 SONARR_API_KEY=… \
 *   QBIT_URL=http://10.0.0.5:8080 QBIT_USER=admin QBIT_PASS=… \
 *     npm run verify:downloadid
 *
 * RADARR_URL / RADARR_API_KEY are optional and checked the same way.
 *
 * Exit codes: 0 = assumption holds, 1 = assumption broken, 2 = could not check
 * (missing config, unreachable host, or no torrent-protocol records in flight).
 */

const env = (name) => process.env[name]?.trim() || null;

/** First 8 and last 4 of a hash — enough to align two lists, not enough to be a magnet link. */
const brief = (hash) => (hash.length > 14 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash);

const CASING = (s) => {
  const letters = s.replace(/[^a-zA-Z]/g, '');
  if (!letters) return 'digits-only';
  if (letters === letters.toUpperCase()) return 'uppercase';
  if (letters === letters.toLowerCase()) return 'lowercase';
  return 'mixed';
};

async function arrQueue(label, baseUrl, apiKey) {
  const url = new URL('/api/v3/queue', baseUrl);
  url.searchParams.set('pageSize', '200');
  url.searchParams.set('includeUnknownSeriesItems', 'true');
  url.searchParams.set('includeUnknownMovieItems', 'true');

  const response = await fetch(url, { headers: { 'X-Api-Key': apiKey } });
  if (!response.ok) throw new Error(`${label} queue returned HTTP ${response.status}`);
  const body = await response.json();
  return (body.records ?? []).map((r) => ({
    source: label,
    title: r.title ?? '(untitled)',
    protocol: r.protocol ?? null,
    downloadId: typeof r.downloadId === 'string' ? r.downloadId : null,
  }));
}

async function qbitTorrents(baseUrl, username, password) {
  const base = new URL(baseUrl);

  // qBittorrent 403s any request whose Referer does not match Host, and a
  // successful login is a 2xx plus a session cookie — never the body, which
  // changed shape in 5.2.0. The cookie's name changed too (`SID` pre-5.1,
  // `QBT_SID_<port>` after), so the whole pair is replayed verbatim. All three
  // rules are the same ones QbitClient follows.
  const login = await fetch(new URL('/api/v2/auth/login', base), {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      Referer: base.origin,
    },
    body: new URLSearchParams({ username, password }).toString(),
    redirect: 'manual',
  });
  if (!login.ok) throw new Error(`qBittorrent login returned HTTP ${login.status}`);

  const session = (login.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';', 1)[0]?.trim())
    .find((pair) => pair && /^(SID|QBT_SID_\d+)=.+/.test(pair));
  if (!session) throw new Error('qBittorrent login succeeded but returned no session cookie');

  const response = await fetch(new URL('/api/v2/torrents/info', base), {
    headers: { Cookie: session, Referer: base.origin },
  });
  if (!response.ok) throw new Error(`qBittorrent torrents/info returned HTTP ${response.status}`);

  const body = await response.json();
  return body
    .map((t) => ({ hash: typeof t.hash === 'string' ? t.hash : '', name: t.name ?? '' }))
    .filter((t) => t.hash !== '');
}

async function main() {
  const qbitUrl = env('QBIT_URL');
  const qbitUser = env('QBIT_USER');
  const qbitPass = env('QBIT_PASS');
  const arrs = [
    ['Sonarr', env('SONARR_URL'), env('SONARR_API_KEY')],
    ['Radarr', env('RADARR_URL'), env('RADARR_API_KEY')],
  ].filter(([, url, key]) => url && key);

  if (!qbitUrl || !qbitUser || !qbitPass || arrs.length === 0) {
    console.error('Set QBIT_URL, QBIT_USER, QBIT_PASS and at least one of');
    console.error('SONARR_URL/SONARR_API_KEY or RADARR_URL/RADARR_API_KEY. See the header of this file.');
    process.exit(2);
  }

  const torrents = await qbitTorrents(qbitUrl, qbitUser, qbitPass);
  const records = (await Promise.all(arrs.map(([label, url, key]) => arrQueue(label, url, key)))).flat();

  const torrentRecords = records.filter((r) => r.protocol === 'torrent' && r.downloadId);

  console.log(`qBittorrent torrents: ${torrents.length}`);
  console.log(`*arr queue records:   ${records.length} (${torrentRecords.length} torrent-protocol with a downloadId)`);

  if (torrents.length === 0 || torrentRecords.length === 0) {
    console.error('\nINCONCLUSIVE — nothing in flight to join. Start a torrent grab and re-run.');
    process.exit(2);
  }

  const arrCasings = new Set(torrentRecords.map((r) => CASING(r.downloadId)));
  const qbitCasings = new Set(torrents.map((t) => CASING(t.hash)));
  console.log(`downloadId casing:    ${[...arrCasings].join(', ')}`);
  console.log(`qBittorrent casing:   ${[...qbitCasings].join(', ')}`);

  const exact = new Set(torrents.map((t) => t.hash));
  const insensitive = new Set(torrents.map((t) => t.hash.toLowerCase()));

  const matched = [];
  const unmatched = [];
  let exactWouldMatch = 0;

  for (const record of torrentRecords) {
    if (exact.has(record.downloadId)) exactWouldMatch += 1;
    if (insensitive.has(record.downloadId.toLowerCase())) matched.push(record);
    else unmatched.push(record);
  }

  console.log('');
  console.log(`case-insensitive join: ${matched.length}/${torrentRecords.length} matched`);
  console.log(`case-sensitive join:   ${exactWouldMatch}/${torrentRecords.length} matched (what the naive compare would find)`);

  for (const record of unmatched) {
    console.log(`  unmatched: [${record.source}] ${brief(record.downloadId)}  ${record.title}`);
  }

  if (unmatched.length > 0) {
    // Not necessarily a defect: a record can name a torrent the client has
    // already removed. But ADR-3 is only safe to keep if this is rare and
    // explainable, so it does not pass silently.
    console.error('\nBROKEN — some torrent-protocol records did not join. Re-check ADR-3 before relying on enrichment.');
    process.exit(1);
  }

  console.log('\nHOLDS — every torrent-protocol record joined case-insensitively.');
  if (exactWouldMatch < torrentRecords.length) {
    console.log(`The case-insensitive compare is load-bearing: ${torrentRecords.length - exactWouldMatch} record(s) would have been missed by an exact compare.`);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(`\nINCONCLUSIVE — ${error.message}`);
  process.exit(2);
});

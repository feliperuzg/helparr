import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { login, seedInstance, startApp, type AppServer } from './helpers/appServer';
import { parsedSeries, startFakeArr, type FakeArr, type FakeGapRecord } from './helpers/fakeArr';

/**
 * T20 / AC1, AC5..AC9, AC11 — the gaps screen in a real browser.
 *
 * Three claims that only a browser can settle, and that the server suites
 * (`gaps-aggregate`, `gaps-attach`) cannot reach:
 *
 *  1. **Grouping is presentational, navigation is flat.** The series headings
 *     are rows the cursor must never land on, and `j` from the last episode of
 *     one series has to land on the first episode of the next. An off-by-one
 *     here is invisible until a group boundary.
 *  2. **The count the operator reads is the count the command carries.** The
 *     filter, the `N of M shown` line, the bulk bar and the dialog all have to
 *     agree — a dialog that says 2 and sends 6 is the failure this screen is
 *     built to make impossible.
 *  3. **Nothing is sent before a confirmation.** Asserted by counting what the
 *     upstream actually received, not by reading the handlers: opening the
 *     attach dialog costs one `GET /parse` and zero pushes; opening the bulk
 *     dialog costs nothing at all.
 *
 * Gated behind HELPARR_E2E_TEST (set by `npm run test:e2e`).
 */

const PORT = 3995;
const PASSWORD = 'operator-password-for-the-gaps-keys-run';

/** Two series on one Sonarr, so `j` has a group boundary to cross. */
const SERIES = [
  { id: 1, title: 'Reacher', path: '/tv/Reacher', qualityProfileId: 3 },
  { id: 2, title: 'Silo', path: '/tv/Silo', qualityProfileId: 3 },
];

function episode(id: number, seriesId: number, season: number, number_: number): FakeGapRecord {
  return {
    id,
    seriesId,
    seasonNumber: season,
    episodeNumber: number_,
    title: `Episode ${number_}`,
    airDateUtc: '2025-01-01T00:00:00Z',
    monitored: true,
    hasFile: false,
  };
}

/** Grouped in the order they are served — the read does not re-sort (T13). */
const WANTED: FakeGapRecord[] = [
  episode(101, 1, 1, 1),
  episode(102, 1, 1, 2),
  episode(103, 1, 1, 3),
  episode(201, 2, 2, 1),
  episode(202, 2, 2, 2),
];

const FILM: FakeGapRecord = {
  id: 7,
  title: 'Dune: Part Two',
  year: 2024,
  status: 'released',
  monitored: true,
  hasFile: false,
  path: '/films/Dune Part Two (2024)',
  qualityProfileId: 1,
};

/** Five episodes + one film. Three groups: Reacher, Silo, Films. */
const TOTAL = WANTED.length + 1;

let app: AppServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let sonarr: FakeArr;
let radarr: FakeArr;

/** The item code of the row the cursor is on — the grid's one tab stop. */
const cursorCode = () => page.textContent('.ggrid__body-row.is-cursor .gcol-code');

/** Loads the screen and waits for the library read to land. */
async function openGaps(): Promise<void> {
  await page.goto(`${app.origin}/gaps`);
  await expect.poll(() => page.locator('.ggrid__body-row').count(), { timeout: 30_000 })
    .toBe(TOTAL);
}

/** Scopes to one instance and moves focus off the filter field. */
async function scopeTo(label: 'All' | 'Sonarr' | 'Radarr'): Promise<void> {
  await page.click(`.chip-row button:has-text("${label}")`);
}

describe('gaps interaction', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    sonarr = await startFakeArr({ apiKey: 'sonarr-key' });
    sonarr.setWanted(WANTED);
    sonarr.setSeries(SERIES);
    sonarr.setProfiles([{ id: 3, name: 'HD-1080p' }]);
    // The same answer for any name helparr synthesizes: S01E01 of Reacher. It
    // matches the first gap and mismatches every other one, which is how both
    // branches of the pre-flight get exercised against one fake.
    sonarr.setParse(parsedSeries({ id: 1, title: 'Reacher', season: 1, episode: 1 }));

    radarr = await startFakeArr({ apiKey: 'radarr-key' });
    radarr.setWanted([FILM]);
    radarr.setProfiles([{ id: 1, name: 'Ultra-HD' }]);

    app = await startApp({ port: PORT, password: PASSWORD });

    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();

    await login(page, app.origin, PASSWORD);
    await seedInstance(page, 'sonarr', 'Sonarr', sonarr.url, { type: 'api-key', apiKey: 'sonarr-key' });
    await seedInstance(page, 'radarr', 'Radarr', radarr.url, { type: 'api-key', apiKey: 'radarr-key' });
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await app?.close();
    await sonarr?.close();
    await radarr?.close();
  });

  beforeEach(async () => {
    sonarr.pushes.length = 0;
    sonarr.commands.length = 0;
    radarr.commands.length = 0;
    sonarr.setPushResult({ rejected: false, rejections: [] });
    // A fresh load each time: what is asserted is the state a read leaves
    // behind, not the state the previous test left behind.
    await openGaps();
  });

  /* ── The read (AC1, AC5) ────────────────────────────────────────────────── */

  it('groups the read by series and by instance, counting each group', async () => {
    // Instance order, then the order the instance listed its items in — the
    // grid groups, it does not sort. The registry reads `ORDER BY kind, label`,
    // so Radarr's one group comes before Sonarr's two.
    const headings = await page.locator('.ggrid__group-title').allTextContents();
    expect(headings).toEqual(['Films', 'Reacher', 'Silo']);

    // The count in a heading is built as the group is built, so it cannot
    // disagree with the rows beneath it.
    expect(await page.locator('.ggrid__group-meta').allTextContents())
      .toEqual(['1 missing', '3 missing', '2 missing']);

    // Every Radarr gap sits under the literal group `Films` (FR5), named by the
    // instance that holds it rather than by a series it does not have.
    expect(await page.locator('.ggrid__group-instance').allTextContents())
      .toEqual(['Radarr', 'Sonarr', 'Sonarr']);

    // Headings are rows too — the grid's row count has to describe what is on
    // screen, not just the gaps.
    expect(await page.getAttribute('.ggrid', 'aria-rowcount')).toBe(String(TOTAL + 3 + 1));
  });

  it('reports what is listed against what was read, on every keystroke', async () => {
    expect(await page.textContent('.toolbar [role="status"]')).toBe(`${TOTAL} of ${TOTAL} shown`);

    await page.fill('#list-search', 'silo');
    await expect.poll(() => page.locator('.ggrid__body-row').count()).toBe(2);
    expect(await page.textContent('.toolbar [role="status"]')).toBe(`2 of ${TOTAL} shown`);
    expect(await page.locator('.ggrid__group-title').allTextContents()).toEqual(['Silo']);

    // A filter that matches nothing is the operator's doing, and the empty
    // state says so rather than making a claim about the library.
    await page.fill('#list-search', 'nothing-matches-this');
    await page.waitForSelector('.empty');
    expect(await page.textContent('.empty')).toContain('Nothing matches that filter');

    await page.fill('#list-search', '');
    await expect.poll(() => page.locator('.ggrid__body-row').count()).toBe(TOTAL);
  });

  it('scopes to one instance without losing the other from the count', async () => {
    await scopeTo('Radarr');
    await expect.poll(() => page.locator('.ggrid__body-row').count()).toBe(1);
    expect(await page.textContent('.toolbar [role="status"]')).toBe(`1 of ${TOTAL} shown`);
    expect(await page.locator('.ggrid__group-title').allTextContents()).toEqual(['Films']);

    await scopeTo('All');
    await expect.poll(() => page.locator('.ggrid__body-row').count()).toBe(TOTAL);
  });

  /* ── The keyboard (AC5) ─────────────────────────────────────────────────── */

  it('walks j/k across a group heading without ever landing on one', async () => {
    await scopeTo('Sonarr');
    await expect.poll(() => page.locator('.ggrid__body-row').count()).toBe(WANTED.length);
    // Two headings between five rows — the boundary this test exists for.
    expect(await page.locator('.ggrid__group').count()).toBe(2);

    await page.keyboard.press('Home');
    expect(await cursorCode()).toBe('S01E01');

    // Three presses from the first Reacher episode: the last one steps over the
    // Silo heading and has to land on an episode, not on the heading.
    await page.keyboard.press('j');
    await page.keyboard.press('j');
    expect(await cursorCode()).toBe('S01E03');
    await page.keyboard.press('j');
    expect(await cursorCode()).toBe('S02E01');

    // And back, which is the same boundary in the other direction.
    await page.keyboard.press('k');
    expect(await cursorCode()).toBe('S01E03');

    // Exactly one row is the cursor, and it is never a heading.
    expect(await page.locator('.is-cursor').count()).toBe(1);
    expect(await page.locator('.ggrid__group.is-cursor').count()).toBe(0);

    await page.keyboard.press('End');
    expect(await cursorCode()).toBe('S02E02');

    await scopeTo('All');
  });

  it('opens the cursor row in the inspector and closes it with one Escape', async () => {
    await scopeTo('Sonarr');
    await page.keyboard.press('Home');
    await page.keyboard.press('j');

    await page.keyboard.press('Enter');
    await page.waitForSelector('.inspector');
    expect(await page.textContent('.inspector__title')).toBe('Reacher — S01E02');

    await page.keyboard.press('Escape');
    await expect.poll(() => page.locator('.inspector').count()).toBe(0);
    // The cursor stayed where it was — Escape closed the panel, it did not
    // also move or clear anything.
    expect(await cursorCode()).toBe('S01E02');

    await scopeTo('All');
  });

  /* ── The bulk confirmation (AC7, AC9) ───────────────────────────────────── */

  it('carries the selected count from the bulk bar into the dialog and the command', async () => {
    await scopeTo('Sonarr');
    await page.keyboard.press('Home');
    await page.keyboard.press(' ');
    await page.keyboard.press('j');
    await page.keyboard.press(' ');

    await page.waitForSelector('.bulkbar');
    expect(await page.textContent('.bulkbar__count')).toBe('2 gaps selected');

    await page.click('.bulkbar button:has-text("Search automatically")');
    await page.waitForSelector('.modal');
    // The count appears three times and all three read the same array.
    expect(await page.textContent('.modal__title')).toBe('Search for 2 gaps');
    expect(await page.textContent('.bulk-list')).toContain('S01E01, S01E02');

    // The dialog is the only path to a command, and it has not been confirmed.
    expect(sonarr.commands).toHaveLength(0);

    await page.click('.modal__foot button:has-text("Search 2 gaps")');
    await expect.poll(() => sonarr.commands.length, { timeout: 15_000 }).toBe(1);

    // One command for the instance, carrying every id — five separate commands
    // would be five queue entries for what was asked once (REQ-GAPS-009).
    expect(sonarr.commands[0].body).toMatchObject({ name: 'EpisodeSearch', episodeIds: [101, 102] });
    expect(radarr.commands).toHaveLength(0);

    await page.waitForSelector('.toast');
    expect(await page.textContent('.toast')).toBe('Sonarr queued a search for 2 items.');

    // The gaps stay listed: the instance was asked to search, which is not the
    // same as having found anything (REQ-GAPS-011, D4).
    await expect.poll(() => page.locator('.ggrid__body-row').count()).toBe(WANTED.length);
    await expect.poll(() => page.locator('.bulkbar').count()).toBe(0);

    await scopeTo('All');
  });

  it('states the exact count and the quota it costs, for every one of five', async () => {
    await scopeTo('Sonarr');
    await page.keyboard.press('Home');
    // Every Sonarr gap, one at a time, across the Reacher/Silo boundary — five
    // is the number AC7 names, and selecting them by hand is what makes the
    // count below a measurement rather than a restatement of the fixture.
    for (let i = 0; i < WANTED.length; i += 1) {
      await page.keyboard.press(' ');
      await page.keyboard.press('j');
    }

    await page.waitForSelector('.bulkbar');
    expect(await page.textContent('.bulkbar__count')).toBe('5 gaps selected');

    await page.click('.bulkbar button:has-text("Search automatically")');
    await page.waitForSelector('.modal');

    // The count in all three places it appears, and all three read the one
    // array the confirm handler sends.
    expect(await page.textContent('.modal__title')).toBe('Search for 5 gaps');
    expect(await page.textContent('.modal__body')).toContain('these 5 items');
    expect(await page.textContent('.modal__foot .btn-primary')).toBe('Search 5 gaps');

    // Listed, not merely counted: the operator can check the five against what
    // they selected, in both groups.
    const list = await page.textContent('.bulk-list');
    expect(list).toContain('S01E01, S01E02, S01E03');
    expect(list).toContain('S02E01, S02E02');

    // What the five cost. A bulk search is cheap for helparr and metered for
    // the operator, so the price is on the confirmation (NFR3).
    const warning = await page.textContent('.modal__body');
    expect(warning).toContain('queries every indexer Prowlarr manages');
    expect(warning).toContain('daily API limit');
    expect(warning).toContain('5 searches now');

    // Still nothing sent, with five queued behind the button.
    expect(sonarr.commands).toHaveLength(0);

    await page.click('.modal__foot button:has-text("Cancel")');
    await scopeTo('All');
  });

  it('closes a bulk confirmation whose subject moved underneath it', async () => {
    await page.keyboard.press('Home');
    await page.keyboard.press(' ');
    await page.click('.bulkbar button:has-text("Search automatically")');
    await page.waitForSelector('.modal');

    // Re-scoping silently would be worse than closing: the operator confirmed
    // a specific list, and a filter change makes that list a different one.
    await page.fill('#list-search', 'silo');
    await expect.poll(() => page.locator('.modal').count()).toBe(0);
    expect(sonarr.commands).toHaveLength(0);

    await page.fill('#list-search', '');
    await expect.poll(() => page.locator('.ggrid__body-row').count()).toBe(TOTAL);
  });

  /* ── The attach confirmation (AC6, AC8, AC11) ───────────────────────────── */

  it('resolves the destination without sending anything', async () => {
    await scopeTo('Sonarr');
    await page.click('.ggrid__body-row:has-text("S01E01")');
    await page.waitForSelector('.inspector');
    await page.click('.inspector button:has-text("Attach")');
    await page.waitForSelector('.modal');

    // The pre-flight resolved the gap the operator selected, so the dialog can
    // name the destination rather than warn about it.
    await page.waitForSelector('.grab-target');
    expect(await page.textContent('.grab-target')).toContain('Reacher — S01E01');
    expect(await page.textContent('.grab-target')).toContain('/tv/Reacher');

    // With a well-formed link in hand the button names where this is going —
    // and the assertions below are that it has gone nowhere yet.
    await page.fill('#attach-link', 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567');
    await expect.poll(() => page.textContent('.modal__foot .btn-primary')).toBe('Attach to Sonarr');

    // The name being offered, shown plainly — it is the whole mechanism.
    expect(await page.textContent('.modal__body')).toContain('sending as Reacher.S01E01.WEBDL-1080p');

    // A GET, and nothing else. The dialog is open and the upstream has received
    // no push (REQ-GAPS-017).
    expect(sonarr.pushes).toHaveLength(0);
    expect(sonarr.hits.some((h) => h.path.startsWith('/api/v3/parse'))).toBe(true);

    await page.click('.modal__foot button:has-text("Cancel")');
    await expect.poll(() => page.locator('.modal').count()).toBe(0);
    expect(sonarr.pushes).toHaveLength(0);

    await scopeTo('All');
  });

  it('names both readings when the instance resolves a different episode', async () => {
    await scopeTo('Sonarr');
    // The fake resolves every name to S01E01, so opening this on S01E03 is the
    // mismatch branch.
    await page.click('.ggrid__body-row:has-text("S01E03")');
    await page.waitForSelector('.inspector');
    await page.click('.inspector button:has-text("Attach")');
    await page.waitForSelector('text=Sonarr reads this as a different episode');

    const body = await page.textContent('.modal__body');
    expect(body).toContain('Sonarr reads this as a different episode');
    // Both readings, side by side. The operator is not stopped — they cannot
    // miss it either (REQ-GAPS-017).
    expect(body).toContain('Reacher — S01E03');
    expect(body).toContain('Reacher — S01E01');

    // And the verb changes, so the button itself says it is the risky one.
    await page.fill('#attach-link', 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567');
    expect(await page.textContent('.modal__foot .btn-outline')).toBe('Attach anyway');

    await page.click('.modal__foot button:has-text("Cancel")');
    await scopeTo('All');
  });

  it('refuses a link that is neither a magnet nor a .torrent, without asking', async () => {
    await scopeTo('Sonarr');
    await page.click('.ggrid__body-row:has-text("S01E01")');
    await page.waitForSelector('.inspector');
    await page.click('.inspector button:has-text("Attach")');
    await page.waitForSelector('.grab-target');

    await page.fill('#attach-link', 'https://example.invalid/page.html');
    // Decided locally, by the same predicate the route refuses on — no request
    // is made to find out (REQ-GAPS-010).
    expect(await page.getAttribute('#attach-link', 'aria-invalid')).toBe('true');
    expect(await page.isDisabled('.modal__foot .btn-primary')).toBe(true);
    expect(sonarr.pushes).toHaveLength(0);

    // The other accepted shape, in the same dialog: a URL whose path ends in
    // `.torrent`. Asserting only the refusal above would pass just as well on a
    // predicate that refuses everything (REQ-GAPS-010).
    await page.fill('#attach-link', 'https://indexer.invalid/download/abc123.torrent');
    await expect.poll(() => page.getAttribute('#attach-link', 'aria-invalid')).toBe('false');
    await expect.poll(() => page.textContent('.modal__foot .btn-primary')).toBe('Attach to Sonarr');
    expect(await page.isDisabled('.modal__foot .btn-primary')).toBe(false);

    // And the standing risk is on the confirmation, not a branch of it: the
    // mapping is by name, so a file that is something else is filed as this.
    const warning = await page.textContent('.modal__body');
    expect(warning).toContain('mapped to this episode regardless of what the release name says');
    expect(warning).toContain('Sonarr will import it under the wrong number');

    // Enabled is not sent.
    expect(sonarr.pushes).toHaveLength(0);

    await page.click('.modal__foot button:has-text("Cancel")');
    await scopeTo('All');
  });

  it('pushes once on confirm, reports the outcome, and leaves the gap listed', async () => {
    await scopeTo('Sonarr');
    await page.click('.ggrid__body-row:has-text("S01E01")');
    await page.waitForSelector('.inspector');
    await page.click('.inspector button:has-text("Attach")');
    await page.waitForSelector('#attach-link');

    const magnet = 'magnet:?xt=urn:btih:9f2c1d4a7b3e5f6089abcdef0123456789abcdef';
    await page.fill('#attach-link', magnet);
    await page.click('.modal__foot button:has-text("Attach to Sonarr")');

    await expect.poll(() => sonarr.pushes.length, { timeout: 15_000 }).toBe(1);
    expect(sonarr.pushes[0].body).toMatchObject({
      title: 'Reacher.S01E01.WEBDL-1080p',
      downloadUrl: magnet,
      protocol: 'torrent',
    });

    // The dialog closes on the response and the outcome arrives as a toast —
    // never the other way round (FR8).
    await expect.poll(() => page.locator('.modal').count()).toBe(0);
    await page.waitForSelector('.toast');
    expect(await page.textContent('.toast'))
      .toBe('Attached to Sonarr — will import as Reacher — S01E01');

    // Not optimistic. The instance accepted a *download*, which is not the same
    // as having the episode: only a later library read can say that.
    await expect.poll(() => page.locator('.ggrid__body-row').count()).toBe(WANTED.length);
    expect(await page.locator('.ggrid__body-row:has-text("S01E01")').count()).toBe(1);

    // Still once, after the refetch the attach triggered.
    expect(sonarr.pushes).toHaveLength(1);

    await scopeTo('All');
  });

  it('reports a refusal as a refusal, and still leaves the gap listed', async () => {
    sonarr.setPushResult({
      rejected: true,
      rejections: ['Existing file meets cutoff: WEBDL-1080p', 'Not an upgrade for existing file'],
    });

    await scopeTo('Sonarr');
    await page.click('.ggrid__body-row:has-text("S01E01")');
    await page.waitForSelector('.inspector');
    await page.click('.inspector button:has-text("Attach")');
    await page.waitForSelector('#attach-link');

    await page.fill('#attach-link', 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567');
    await page.click('.modal__foot button:has-text("Attach to Sonarr")');

    await expect.poll(() => sonarr.pushes.length, { timeout: 15_000 }).toBe(1);
    await page.waitForSelector('.toast');
    // The count here, the reasons verbatim in the operation log: a toast that
    // disappears in four seconds is the wrong place for text that has to be
    // read carefully (REQ-GAPS-013).
    expect(await page.textContent('.toast'))
      .toBe('Sonarr declined the release — 2 reasons. See Activity.');

    await expect.poll(() => page.locator('.ggrid__body-row').count()).toBe(WANTED.length);
    await scopeTo('All');
  });
});

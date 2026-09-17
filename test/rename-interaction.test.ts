import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { login, seedInstance, startApp, type AppServer } from './helpers/appServer';
import { startFakeArr, type FakeArr } from './helpers/fakeArr';

/**
 * T17 / FR1, FR7, FR9, FR10; REQ-RENAME-010; ADR-6, ADR-8; NFR1.
 *
 * The browser half of the feature, and its claims are the ones no server test
 * can make — because every one of them is about the moment *before* a write,
 * measured from what the upstream actually received:
 *
 *  1. **The typed gate has three states and no fourth.** Empty, wrong, right.
 *     The rename button is disabled through the first two and the number is
 *     frozen at open, so a poll landing mid-keystroke cannot move the target.
 *  2. **Zero files have moved at the moment of confirmation.** Asserted by
 *     counting `RenameFiles` commands on the fake, not by reading the handlers:
 *     picking a scope sends none, generating a preview sends none, opening the
 *     dialog sends none, and typing the right number sends none. The click on a
 *     control that says "Rename 3 files" is the first one.
 *  3. **There is no bypass, anywhere (ADR-8).** No checkbox, no preference, no
 *     "apply anyway" — and no text offering one, which matters as much: an
 *     operator who believes the gate can be turned off will go looking for the
 *     setting instead of reading the plan.
 *
 * The exclusion case carries the fourth claim, which is ADR-6's whole point: the
 * count the gate demands, the count on the button and the file ids in the
 * command are one number, and excluding a row moves all three together.
 *
 * `test/rename-plan.test.ts` covers the server half.
 *
 * Gated behind HELPARR_E2E_TEST (set by `npm run test:e2e`).
 */

const PORT = 3989;
const PASSWORD = 'operator-password-for-the-rename-gate-run';

const SERIES_ROOT = '/tv/Reacher';

/** One Sonarr preview row in the shape the real `/rename` returns. */
function previewRow(fileId: number, existing: string, proposed: string): unknown {
  return {
    seriesId: 1,
    seasonNumber: 1,
    episodeNumbers: [fileId - 10],
    episodeFileId: fileId,
    existingPath: existing,
    newPath: proposed,
  };
}

/** Three files pending on one series — enough that a count is worth checking. */
const PENDING = [
  previewRow(11, 'reacher.s01e01.mkv', 'Season 1/Reacher - S01E01.mkv'),
  previewRow(12, 'reacher.s01e02.mkv', 'Season 1/Reacher - S01E02.mkv'),
  previewRow(13, 'reacher.s01e03.mkv', 'Season 1/Reacher - S01E03.mkv'),
];

let app: AppServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let sonarr: FakeArr;
let radarr: FakeArr;

/** Every `RenameFiles` the Sonarr has been asked for, whatever else it got. */
const renameCommands = () => sonarr.commands.filter((c) => c.body.name === 'RenameFiles');

/**
 * Picks Reacher and waits for the plan grid.
 *
 * The whole walk, every time: a plan is built per test rather than shared,
 * because what is being asserted is the state a fresh build leaves behind and
 * five minutes of expiry is not long enough to pretend otherwise.
 */
async function buildPlan(): Promise<void> {
  await page.goto(`${app.origin}/rename`);
  await page.waitForSelector('.scope__item', { timeout: 30_000 });
  await page.check('.scope__item:has-text("Reacher") input[type="checkbox"]');
  await page.click('.scope__foot button');
  await expect.poll(() => page.locator('.pgrid__body-row').count(), { timeout: 30_000 })
    .toBe(PENDING.length);
}

/** Opens the confirmation and waits for the gate to be on screen. */
async function openConfirm(): Promise<void> {
  await page.click('.bulkbar--apply button:has-text("Apply")');
  await page.waitForSelector('#rename-typed-count');
}

const hint = () => page.textContent('#rename-typed-hint');
const confirmDisabled = () => page.isDisabled('.modal__foot .btn-danger-solid');

describe('rename interaction', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    sonarr = await startFakeArr({ apiKey: 'sonarr-key' });
    sonarr.setSeries([
      { id: 1, title: 'Reacher', path: SERIES_ROOT, statistics: { episodeFileCount: 3 } },
      // No files, so the picker must not offer it — a title with nothing to
      // move has nothing to preview (FR1).
      { id: 2, title: 'Silo', path: '/tv/Silo', statistics: { episodeFileCount: 0 } },
    ]);
    sonarr.setSeriesDetail({ id: 1, title: 'Reacher', path: SERIES_ROOT });

    radarr = await startFakeArr({ apiKey: 'radarr-key' });
    radarr.setMovies([{ id: 7, title: 'Dune', year: 2021, hasFile: true }]);

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

  beforeEach(() => {
    sonarr.commands.length = 0;
    sonarr.renameReads.length = 0;
    radarr.commands.length = 0;
    sonarr.setFilesystem({});
    sonarr.setCommandOutcome({ status: 'completed', result: 'successful', message: null });
    // Call 0 is the build's preview, call 1 is the drift check the apply runs
    // first, and everything after it is the verification re-read — empty, so a
    // rename that is sent is a rename that is seen to have landed. Setting the
    // resolver also resets the per-title call counter, which is what makes the
    // numbering above true in every test rather than only the first.
    sonarr.setRenamePreview((_query, callIndex) => (callIndex <= 1 ? PENDING : []));
  });

  /* ── The picker (FR1) ───────────────────────────────────────────────────── */

  it('offers titles across instances and sends nothing while they are picked', async () => {
    await page.goto(`${app.origin}/rename`);
    await page.waitForSelector('.scope__item', { timeout: 30_000 });

    const labels = await page.locator('.scope__label').allTextContents();
    expect(labels).toContain('Reacher');
    expect(labels).toContain('Dune (2021)');
    // The file floor is the whole filter, and it is applied before the operator
    // can select anything — not after they have waited for a build.
    expect(labels).not.toContain('Silo');

    await page.check('.scope__item:has-text("Reacher") input[type="checkbox"]');
    await page.check('.scope__item:has-text("Dune") input[type="checkbox"]');

    // The button states the count before it is pressed, because pressing it is
    // the first thing in this flow that costs an instance any work.
    expect(await page.textContent('.scope__foot button')).toContain('2 titles');

    // Selecting is free. No rescan, no preview, no rename — on either instance.
    expect(sonarr.commands).toEqual([]);
    expect(radarr.commands).toEqual([]);
    expect(sonarr.renameReads).toEqual([]);
  });

  /* ── The preview (FR3, FR10) ────────────────────────────────────────────── */

  it('says nothing has been renamed, and has renamed nothing', async () => {
    await buildPlan();

    expect(await page.textContent('.ribbon--preview')).toContain('nothing has been renamed');
    expect(await page.textContent('.bulkbar__count')).toContain('3 files will be renamed');

    // The build rescans and reads. It does not rename, and the difference is
    // the entire premise of the screen.
    expect(sonarr.commands.some((c) => c.body.name === 'RescanSeries')).toBe(true);
    expect(renameCommands()).toHaveLength(0);
  });

  /* ── The typed gate (FR9, REQ-RENAME-010, ADR-8) ────────────────────────── */

  it('walks the gate through its three states and sends nothing until the last', async () => {
    await buildPlan();
    await openConfirm();

    // State one: untouched. The dialog says what has happened so far, which is
    // nothing, and says what will make something happen.
    expect(await page.textContent('.modal__lead')).toContain('Nothing has been renamed yet');
    expect(await hint()).toContain('Nothing is sent until this field reads 3');
    expect(await confirmDisabled()).toBe(true);

    // State two: wrong. Refused without scolding, and explicit that the refusal
    // is what keeps the button dead.
    await page.fill('#rename-typed-count', '2');
    expect(await hint()).toContain('That is not 3');
    expect(await page.getAttribute('#rename-typed-count', 'aria-invalid')).toBe('true');
    expect(await confirmDisabled()).toBe(true);

    // A near miss is still a miss: the field is compared to the count, not
    // parsed for intent.
    await page.fill('#rename-typed-count', '3 ');
    expect(await confirmDisabled()).toBe(false); // trimmed — whitespace is not a typo
    await page.fill('#rename-typed-count', '03');
    expect(await confirmDisabled()).toBe(true);

    // State three: right. Enabled, and still nothing sent — the button is a
    // button, not a consequence of typing.
    await page.fill('#rename-typed-count', '3');
    expect(await hint()).toContain('Matches');
    expect(await confirmDisabled()).toBe(false);
    expect(await page.textContent('.modal__foot .btn-danger-solid')).toContain('Rename 3 files');

    // Everything above happened with zero renames on the wire. This is the
    // assertion the whole dialog exists to make true.
    expect(renameCommands()).toHaveLength(0);
  });

  it('offers no way anywhere to skip the gate', async () => {
    await buildPlan();
    await openConfirm();

    // The only controls in the dialog: the count field, Cancel, and the rename
    // itself. No third button, no checkbox, no link to a setting.
    const buttons = await page.locator('.modal button').allTextContents();
    expect(buttons).toHaveLength(2);
    expect(buttons.join(' ')).toContain('Cancel');
    expect(buttons.join(' ')).toContain('Rename 3 files');
    expect(await page.locator('.modal input').count()).toBe(1);

    // And no text offering one. An operator who believes the gate is optional
    // goes looking for the switch instead of reading the plan, so the absence
    // has to hold in the prose as well as in the DOM.
    const text = (await page.textContent('.modal')) ?? '';
    for (const bypass of [/skip/i, /bypass/i, /don.t ask/i, /disable/i, /apply anyway/i, /force/i]) {
      expect(text).not.toMatch(bypass);
    }

    // Cancel is a real exit, and it renames nothing on the way out.
    await page.click('.modal__foot .btn-ghost');
    await page.waitForSelector('.modal', { state: 'detached' });
    expect(renameCommands()).toHaveLength(0);
    expect(await page.textContent('.ribbon--preview')).toContain('nothing has been renamed');
  });

  /* ── Exclusion (FR7, ADR-6) ─────────────────────────────────────────────── */

  it('moves the count, the button and the command together when a row is excluded', async () => {
    await buildPlan();

    // Addressed by the row's own accessible name rather than by its visible
    // text: the cell renders the diff with brackets around the changed span, so
    // the filename is deliberately not one contiguous string on screen.
    // Clicked and then waited for, rather than `uncheck`ed: the tick is not
    // local state. It is a PATCH whose answer is the re-read plan, which is the
    // only reason the count below can be trusted to match what would be sent.
    await page.click('input[aria-label="Include reacher.s01e02.mkv in this plan"]');
    await expect.poll(() => page.textContent('.bulkbar__count'), { timeout: 10_000 })
      .toContain('2 files will be renamed');

    await openConfirm();
    // The gate demands the new number, not the one the plan was built with.
    expect(await hint()).toContain('Nothing is sent until this field reads 2');
    await page.fill('#rename-typed-count', '3');
    expect(await confirmDisabled()).toBe(true);
    await page.fill('#rename-typed-count', '2');
    expect(await confirmDisabled()).toBe(false);

    expect(await page.textContent('.modal')).toContain('1 file you excluded will not be sent');

    await page.click('.modal__foot .btn-danger-solid');
    await expect.poll(() => renameCommands().length, { timeout: 30_000 }).toBe(1);

    // ADR-6: the command names the files, and names exactly the ones left
    // checked. An exclusion that did not reach the payload would be a lie told
    // by the grid.
    expect(renameCommands()[0].body).toMatchObject({ name: 'RenameFiles', seriesId: 1 });
    expect(renameCommands()[0].body.files).toEqual([11, 13]);
  });

  /* ── Apply (FR10, FR13) ─────────────────────────────────────────────────── */

  it('renames only on the confirmed click, and reports each file once it lands', async () => {
    await buildPlan();
    await openConfirm();
    await page.fill('#rename-typed-count', '3');

    expect(renameCommands()).toHaveLength(0);
    await page.click('.modal__foot .btn-danger-solid');

    await expect.poll(() => page.textContent('.ribbon--done'), { timeout: 30_000 })
      .toContain('these files have been renamed');

    expect(renameCommands()).toHaveLength(1);
    expect(renameCommands()[0].body.files).toEqual([11, 12, 13]);

    // Reported per file, from the re-read preview rather than from the command
    // having been accepted (ADR-7).
    expect(await page.textContent('.tally')).toContain('3 renamed');
    expect(await page.textContent('.tally')).toContain('0 failed');
    expect(await page.textContent('.bulkbar__count')).toContain('3 files renamed');
  });
});

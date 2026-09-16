import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { login, seedInstance, startApp, type AppServer } from './helpers/appServer';
import { parsedSeries, startFakeArr, type FakeArr } from './helpers/fakeArr';
import { fakeReleases, startFakeProwlarr, type FakeProwlarr } from './helpers/fakeProwlarr';

/**
 * AC6, AC15 / FR13 — what the operator can reach from the results, by keyboard
 * and in the inspector.
 *
 * `useListKeyboard` is shared with the Overview, and `queue-interaction.test.ts`
 * already proves the hook itself. What is asserted here is this screen's wiring
 * of it, which is different in the two ways that matter:
 *
 *  1. **There is no selection.** One Escape closes the inspector, and that is
 *     the whole contract — there is no second press with a second meaning.
 *  2. **The confirmation owns the keyboard.** While the dialog is up the grid's
 *     handler is disabled, because `j`/`k` moving a cursor behind a dialog is
 *     how the wrong release gets grabbed.
 *
 * And the panel those keys open has to identify the release it is showing:
 * `guid` and originating indexer are what the operator carries to the indexer's
 * own site when a grab goes wrong, so they are shown rather than summarized.
 *
 * Gated behind HELPARR_E2E_TEST (set by `npm run test:e2e`).
 */

const PORT = 3994;
const PASSWORD = 'operator-password-for-the-search-keys-run';

const RELEASES = fakeReleases(4, 'TorrentDay', 5);

let app: AppServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let prowlarr: FakeProwlarr;
let sonarr: FakeArr;

/** The title of the row the cursor is on — the grid's one tab stop. */
const cursorText = () => page.textContent('.rgrid__body-row.is-cursor .rgrid__cell');

describe('search interaction', { timeout: 90_000 }, () => {
  beforeAll(async () => {
    prowlarr = await startFakeProwlarr({
      apiKey: 'prowlarr-key',
      indexers: [{ id: 4, name: 'TorrentDay' }],
    });
    prowlarr.setResults(4, RELEASES);
    sonarr = await startFakeArr({ apiKey: 'sonarr-key' });
    sonarr.setParse(parsedSeries());
    app = await startApp({ port: PORT, password: PASSWORD });

    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();

    await login(page, app.origin, PASSWORD);
    await seedInstance(page, 'prowlarr', 'Prowlarr', prowlarr.url, { type: 'api-key', apiKey: 'prowlarr-key' });
    await seedInstance(page, 'sonarr', 'Sonarr', sonarr.url, { type: 'api-key', apiKey: 'sonarr-key' });
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await app?.close();
    await prowlarr?.close();
    await sonarr?.close();
  });

  beforeEach(async () => {
    // A fresh load each time: the keyboard state this asserts is the state a
    // search leaves behind, not the state the previous test left behind.
    await page.goto(`${app.origin}/search`);
    await page.fill('#search-query', 'show');
    await page.click('form.stoolbar button[type="submit"]');
    await expect.poll(() => page.locator('.rgrid__body-row').count(), { timeout: 20_000 })
      .toBe(RELEASES.length);
    // Away from the query field, which swallows the keys by design.
    await page.click('.rgrid__head');
  });

  it('walks the results, inspects one, and closes it again', async () => {
    const first = await cursorText();
    await page.keyboard.press('j');
    const second = await cursorText();
    expect(second).not.toBe(first);
    await page.keyboard.press('k');
    expect(await cursorText()).toBe(first);

    // Enter inspects the cursor row — and it is the cursor row, not whichever
    // release happens to be first.
    await page.keyboard.press('j');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.inspector');
    expect(await page.textContent('.inspector__title')).toBe(second);

    // One Escape, one thing. There is no selection on this screen, so closing
    // the inspector is all it has to do.
    await page.keyboard.press('Escape');
    await expect.poll(() => page.locator('.inspector').count()).toBe(0);
    expect(await cursorText()).toBe(second);
  });

  it('identifies the opened release by guid and by the indexer it came from', async () => {
    // The second row, so this cannot pass by reading whatever the panel would
    // show for the first release in the fixture.
    await page.keyboard.press('j');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.inspector');

    const title = await page.textContent('.inspector__title');
    const release = RELEASES.find((r) => r.title === title);
    expect(release, `the panel is showing "${title}", which is not one of the results`)
      .toBeDefined();

    // The indexer, twice over: the eyebrow is where it is read at a glance, the
    // field is where it is read deliberately.
    expect(await page.textContent('.inspector__eyebrow'))
      .toBe(`${release!.indexer} · ${release!.protocol}`);

    const identity = await page.evaluate(() => {
      const group = [...document.querySelectorAll('.inspector__group')]
        .find((g) => g.querySelector('.inspector__group-title')?.textContent === 'Identity');
      const out: Record<string, string> = {};
      const keys = group?.querySelectorAll('.kv__k') ?? [];
      const values = group?.querySelectorAll('.kv__v') ?? [];
      keys.forEach((key, i) => {
        const value = values[i];
        // The full value lives in the title — a long guid is middle-ellipsized
        // on screen, and the ellipsis is not what the operator pastes.
        out[key.textContent ?? ''] = value?.querySelector('.monoval__text')?.getAttribute('title')
          ?? value?.textContent
          ?? '';
      });
      return out;
    });

    expect(identity.guid).toBe(release!.guid);
    expect(identity.Indexer).toBe(release!.indexer);
    expect(identity.infoHash).toBe(release!.infoHash);

    await page.keyboard.press('Escape');
  });

  it('gives the keys to the query field and takes them back', async () => {
    // `/` reaches the field from anywhere on the screen…
    await page.keyboard.press('/');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('search-query');

    // …and from there `j` and `k` are characters, not commands. This is the bug
    // the pattern always ships with: typing "jk" moving the cursor instead of
    // reaching the input.
    await page.fill('#search-query', '');
    await page.keyboard.press('j');
    await page.keyboard.press('k');
    expect(await page.inputValue('#search-query')).toBe('jk');
    // Nothing was searched — the draft changed, the results did not. helparr
    // never queries an indexer that the operator did not ask it to (NFR1).
    expect(await page.locator('.rgrid__body-row').count()).toBe(RELEASES.length);

    // Escape still fires while typing — it is how the operator gets back out.
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => document.activeElement?.id)).not.toBe('search-query');
  });

  it('yields the keyboard to the grab confirmation', async () => {
    await page.keyboard.press('Enter');
    await page.waitForSelector('.inspector');
    const inspected = await page.textContent('.inspector__title');

    await page.click('.inspector__foot .btn-primary');
    await page.waitForSelector('.modal[role="dialog"]');

    // `j` behind a dialog would move the cursor under a confirmation that names
    // a different release — the one way this screen could grab something the
    // operator did not look at.
    await page.keyboard.press('j');
    await page.keyboard.press('j');
    expect(await cursorText()).toBe(inspected);
    expect(await page.locator('.modal[role="dialog"]').count()).toBe(1);

    // Escape closes the confirmation and nothing else, and the keys come back.
    await page.keyboard.press('Escape');
    await expect.poll(() => page.locator('.modal[role="dialog"]').count()).toBe(0);
    await page.keyboard.press('j');
    expect(await cursorText()).not.toBe(inspected);
  });
});

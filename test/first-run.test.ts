import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { login, seedInstance, startApp, type AppServer } from './helpers/appServer';
import { startFakeArr, type FakeArr } from './helpers/fakeArr';

/**
 * T18 / AC13 — FR10; REQ-DEPLOY-013.
 *
 * The claim is about a state that only exists once per install: the very first
 * screen after the very first login, before anything is connected. It cannot be
 * asserted against a seeded database, and it cannot be asserted in jsdom either,
 * because the thing under test is which of five real screens renders — a
 * decision made from the live health query the shell polls.
 *
 * So: a real standalone server, a genuinely empty database, and a walk through
 * all five list screens before a single instance exists. Then one instance is
 * added, and the guidance has to get out of the way on its own.
 *
 * Gated behind HELPARR_E2E_TEST (set by `npm run test:e2e`).
 */

const PORT = 3984;
const PASSWORD = 'operator-password-for-the-first-run-walk';

/** Every list screen, with the crumb each one puts in the topbar. */
const SCREENS: Array<[string, string]> = [
  ['/', 'Overview'],
  ['/search', 'Search'],
  ['/gaps', 'Gaps'],
  ['/rename', 'Rename'],
  ['/operations', 'Activity'],
];

let app: AppServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let sonarr: FakeArr;

describe('guided first run', { timeout: 150_000 }, () => {
  beforeAll(async () => {
    sonarr = await startFakeArr({ apiKey: 'sonarr-key' });
    app = await startApp({ port: PORT, password: PASSWORD });

    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();

    await login(page, app.origin, PASSWORD);
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await app?.close();
    await sonarr?.close();
  });

  it('takes over every list screen, not just the one the operator landed on', async () => {
    for (const [path, crumb] of SCREENS) {
      await page.goto(`${app.origin}${path}`);
      await page.waitForSelector('.firstrun');

      // Still the screen it claims to be — the takeover replaces the body, not
      // the shell, so the operator can tell where they are and navigate away.
      expect(await page.locator('.topbar__crumb').textContent()).toBe(crumb);
      expect(await page.locator('.firstrun__title').textContent()).toBe('Welcome to helparr');
    }
  });

  it('names the three kinds and what each one unlocks, without a checklist', async () => {
    await page.goto(`${app.origin}/`);
    await page.waitForSelector('.firstrun');

    await expect.poll(() => page.locator('.firstrun__name').allTextContents()).toEqual([
      'Sonarr / Radarr', 'Prowlarr', 'Download client (qBittorrent)',
    ]);

    // No "0 of 3". These are options, and Sonarr-only is a legitimate end state
    // this screen has no business asking anyone to justify.
    expect(await page.locator('.firstrun').textContent()).not.toMatch(/\d\s*of\s*3/);
    expect(await page.locator('.firstrun').textContent())
      .toContain('There is no required order');
  });

  it('hands off to the real add form rather than a second copy of it', async () => {
    await page.click('.firstrun a.btn-primary');
    await page.waitForURL(`${app.origin}/settings?add=1`);

    // The form is already open — that is the whole point of the deep link — and
    // it is `AddInstanceCard` itself, test-then-save gate included: Save stays
    // disabled until a connection test has actually passed.
    await page.waitForSelector('#new-url');
    await expect.poll(() => page.locator('button:has-text("Save instance")').isDisabled()).toBe(true);
  });

  it('gets out of the way as soon as one instance answers', async () => {
    await seedInstance(page, 'sonarr', 'Sonarr', sonarr.url, {
      type: 'api-key', apiKey: 'sonarr-key',
    });

    for (const [path] of SCREENS) {
      await page.goto(`${app.origin}${path}`);
      await page.waitForSelector('main#main');
      // Poll rather than assert once: the shell's health query is what clears
      // this, and it lands a beat after the screen paints.
      await expect.poll(() => page.locator('.firstrun').count()).toBe(0);
    }
  });

  it('keeps a softer nudge on Overview alone, naming only what is still missing', async () => {
    await page.goto(`${app.origin}/`);
    await expect.poll(() => page.locator('.firstrun__nudge').count()).toBe(1);

    const nudge = await page.locator('.firstrun__nudge').textContent();
    // Sonarr is connected, so it is not chased; the download client is optional,
    // so it never is.
    expect(nudge).toContain('Radarr');
    expect(nudge).toContain('Prowlarr');
    expect(nudge).not.toContain('qBittorrent');

    // Overview only. Repeating one generic nudge on all five screens would be
    // the empty-screens problem's mirror image — noise instead of silence.
    for (const [path] of SCREENS.slice(1)) {
      await page.goto(`${app.origin}${path}`);
      await page.waitForSelector('main#main');
      expect(await page.locator('.firstrun__nudge').count()).toBe(0);
    }
  });

  it('forgets the nudge for good once it is dismissed', async () => {
    await page.goto(`${app.origin}/`);
    await page.waitForSelector('.firstrun__nudge');
    await page.click('.firstrun__nudge button:has-text("Dismiss")');
    await expect.poll(() => page.locator('.firstrun__nudge').count()).toBe(0);

    // A dismissal, not a snooze: it does not come back on the next visit.
    await page.goto(`${app.origin}/`);
    await page.waitForSelector('main#main');
    await expect.poll(() => page.locator('.firstrun__nudge').count()).toBe(0);
  });
});

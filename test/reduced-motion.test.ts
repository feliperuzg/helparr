import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { login, seedInstance, startApp, type AppServer } from './helpers/appServer';
import { fakeQueue, startFakeArr, type FakeArr } from './helpers/fakeArr';
import { fakeReleases, startFakeProwlarr, type FakeProwlarr } from './helpers/fakeProwlarr';

/**
 * T22 / AC19 — FR16; REQ-A11Y-006.
 *
 * DESIGN.md has mandated `prefers-reduced-motion` from the start and
 * `globals.css` carries the global override, but nothing has ever verified it
 * as a set. A stylesheet that contains the rule and an app that honours it are
 * different claims: a keyframe added to a new surface is covered by the
 * universal selector, an animation driven from JavaScript is not, and no amount
 * of reading the CSS tells you which kind a given screen has.
 *
 * So this asserts the *behaviour*, in a real browser launched with the
 * preference set, on the surfaces that actually animate: the pulsing status
 * dot, the loading skeletons, the spinner, the inspector and bulk-bar entrances
 * and the modal. Plus the one thing the CSS override provably cannot reach —
 * `scrollIntoView`/`scrollToIndex` from keyboard navigation inside a
 * virtualized grid, which is a scroll issued by script, not a transition.
 *
 * Gated behind HELPARR_E2E_TEST (set by `npm run test:e2e`).
 */

const PORT = 3983;
const PASSWORD = 'operator-password-for-the-reduced-motion-sweep';

let app: AppServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let sonarr: FakeArr;
let prowlarr: FakeProwlarr;

/** Every duration the browser resolved for an element, in milliseconds. */
async function durations(selector: string): Promise<number[]> {
  return page.evaluate((sel) => {
    const out: number[] = [];
    for (const el of document.querySelectorAll(sel)) {
      const style = getComputedStyle(el);
      for (const group of [style.animationDuration, style.transitionDuration]) {
        for (const part of group.split(',')) {
          const value = part.trim();
          if (value.endsWith('ms')) out.push(Number.parseFloat(value));
          else if (value.endsWith('s')) out.push(Number.parseFloat(value) * 1000);
        }
      }
    }
    return out;
  }, selector);
}

/** Asserts every animation and transition on `selector` is effectively instant. */
async function isStill(selector: string) {
  const found = await durations(selector);
  // An empty result would pass vacuously — and silently stop testing the moment
  // a class is renamed, which is exactly when this check is worth having.
  expect(found.length, `nothing matched ${selector}`).toBeGreaterThan(0);
  for (const ms of found) expect(ms, `${selector} animates for ${ms}ms`).toBeLessThanOrEqual(1);
}

describe('prefers-reduced-motion', { timeout: 150_000 }, () => {
  beforeAll(async () => {
    sonarr = await startFakeArr({ apiKey: 'sonarr-key', queue: fakeQueue(60) });
    prowlarr = await startFakeProwlarr({
      apiKey: 'prowlarr-key',
      indexers: [{ id: 4, name: 'TorrentDay' }],
    });
    prowlarr.setResults(null, fakeReleases(4, 'TorrentDay', 40));

    app = await startApp({ port: PORT, password: PASSWORD });

    browser = await chromium.launch();
    // The whole point: the preference is set at the context level, so every
    // media query in the app resolves against a browser that really is asking
    // for less motion.
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: 'reduce',
    });
    page = await context.newPage();

    await login(page, app.origin, PASSWORD);
    await seedInstance(page, 'sonarr', 'Sonarr', sonarr.url, {
      type: 'api-key', apiKey: 'sonarr-key',
    });
    await seedInstance(page, 'prowlarr', 'Prowlarr', prowlarr.url, {
      type: 'api-key', apiKey: 'prowlarr-key',
    });
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await app?.close();
    await sonarr?.close();
    await prowlarr?.close();
  });

  it('stills the shell chrome — the pulsing health dot and every hover transition', async () => {
    await page.goto(`${app.origin}/`);
    await page.waitForSelector('.dot--pulse');
    await isStill('.dot--pulse');
    await isStill('.navlink');
    await isStill('.btn');
  });

  it('stills the inspector and the bulk bar, which both animate in', async () => {
    await page.waitForSelector('.qgrid__body-row');
    await page.click('.qgrid__body-row');
    await page.waitForSelector('.inspector');
    await isStill('.inspector');

    await page.keyboard.press('Escape');
    await page.keyboard.press(' ');
    await page.waitForSelector('.bulkbar');
    await isStill('.bulkbar');
  });

  it('stills the modal and its backdrop', async () => {
    await page.click('.bulkbar .btn-danger');
    await page.waitForSelector('.modal');
    await isStill('.modal');
    await isStill('.modal-backdrop');
    await page.click('.modal__foot .btn-ghost');
  });

  it('never smooth-scrolls a virtualized grid from the keyboard', async () => {
    // The residual risk the wireframe pass flagged: the CSS override sets
    // `scroll-behavior: auto`, but a script-issued scroll carries its own
    // behaviour and ignores the stylesheet entirely. The only honest check is
    // whether the scroll position moves in one step or is animated over frames.
    await page.goto(`${app.origin}/`);
    await page.waitForSelector('.qgrid__body-row');
    await page.click('.qgrid__body-row');
    await page.keyboard.press('Escape');

    const scroller = '.qgrid__scroll';
    const before = await page.locator(scroller).evaluate((el) => el.scrollTop);
    await page.keyboard.press('End');

    // One frame later, not a hundred. A smooth scroll would still be mid-flight.
    await page.waitForTimeout(50);
    const after = await page.locator(scroller).evaluate((el) => el.scrollTop);
    expect(after).toBeGreaterThan(before);

    await page.waitForTimeout(400);
    const settled = await page.locator(scroller).evaluate((el) => el.scrollTop);
    expect(settled, 'the grid was still scrolling 50ms in').toBe(after);
  });

  it('stills the loading skeleton on the search screen', async () => {
    // Held open deliberately. The skeleton is only up while a search is in
    // flight, and racing a local fake would make this assert nothing most runs.
    prowlarr.stallSearches([4], 3_000);
    await page.goto(`${app.origin}/search`);
    await page.waitForSelector('.stoolbar .filter-chip:has-text("TorrentDay")');
    await page.fill('#search-query', 'anything');
    // Scoped, so the stall above is the one the app actually waits on.
    await page.click('.stoolbar .filter-chip:has-text("TorrentDay")');
    await page.click('form.stoolbar button[type="submit"]');

    await page.waitForSelector('.qgrid__skeleton');
    await isStill('.qgrid__skeleton span');
    prowlarr.stallSearches([], 0);
  });
});

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { login, seedInstance, startApp, type AppServer } from './helpers/appServer';
import { fakeReleases, startFakeProwlarr, type FakeProwlarr } from './helpers/fakeProwlarr';

/**
 * T26 / NFR6 — a full 300-release answer renders, re-sorts and scrolls without
 * perceptible lag.
 *
 * 300 is not an arbitrary round number: it is `SEARCH_RESULT_CAP`, so this is
 * the largest result set the screen can ever be handed. The queue harness
 * (`queue-perf.test.ts`) makes the same argument about the Overview, and the
 * reasoning carries over unchanged — "perceptible lag" is not directly
 * measurable, so what is asserted is the two things that cause it:
 *
 *  1. **The DOM stays bounded.** The cost that makes a long list lag is 300 rows
 *     of layout per frame. Sorting is where this is easiest to lose: a re-sort
 *     changes every row's content, and a grid that re-renders the full list
 *     instead of the window will still *look* fine here and fall over on the
 *     operator's hardware. The bound is checked after every sort, not only on
 *     first paint.
 *  2. **The work stays off the frame.** Re-sorting is measured from the click to
 *     the paint that shows the new order, and a full traversal of the list is
 *     measured frame by frame. Both thresholds are deliberately generous: this
 *     is a regression guard against an O(n)-per-frame re-render, not a
 *     benchmark, and a tight budget measured on a dev machine would only produce
 *     a flaky test that says nothing about the modest hardware NFR6 names.
 *
 * Gated behind HELPARR_E2E_TEST (set by `npm run test:e2e`).
 */

const PORT = 3993;
const PASSWORD = 'operator-password-for-the-search-perf-run';

/** `SEARCH_RESULT_CAP` — the largest answer the screen can be handed. */
const RESULT_COUNT = 300;

/** Frames longer than this read as a stutter rather than a smooth scroll. */
const LONG_FRAME_MS = 50;

/** Click to painted re-sort. Two orders of magnitude over a 300-item sort. */
const SORT_BUDGET_MS = 400;

/**
 * 300 releases across two indexers, with sizes and ages that do not follow the
 * seeder order — otherwise every column sorts to the same sequence and a re-sort
 * that silently did nothing would still pass.
 */
const RELEASES = [
  ...fakeReleases(4, 'TorrentDay', 150),
  ...fakeReleases(7, 'Nyaa', 150),
].map((release, i) => ({
  ...release,
  guid: `release-${i + 1}`,
  title: `Show.S${String((i % 9) + 1).padStart(2, '0')}E${String(i + 1).padStart(3, '0')}.1080p.WEB-DL-GROUP`,
  seeders: ((i * 37) % 300) + 1,
  leechers: ((i * 11) % 90) + 1,
  size: 1_000_000_000 + ((i * 7919) % 900) * 1_000_000,
  ageHours: ((i * 13) % 400) + 1,
}));

let app: AppServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let prowlarr: FakeProwlarr;

/** The one search this screen ever runs, answered with the full cap. */
async function search() {
  await page.goto(`${app.origin}/search`);
  await page.waitForSelector('form.stoolbar');
  await page.fill('#search-query', 'show');
  await page.click('form.stoolbar button[type="submit"]');
  await page.waitForSelector('.rgrid__body-row', { timeout: 30_000 });
}

/** The seeder counts of the rows currently in the DOM, in painted order. */
async function renderedSeeders(): Promise<number[]> {
  return page.evaluate(() => [...document.querySelectorAll('.rgrid__body-row')]
    .sort((a, b) => Number(a.getAttribute('aria-rowindex')) - Number(b.getAttribute('aria-rowindex')))
    .map((row) => Number(row.querySelector('.rcol-seeders')?.textContent?.trim())));
}

describe('search result-set performance', () => {
  beforeAll(async () => {
    prowlarr = await startFakeProwlarr({
      apiKey: 'prowlarr-key',
      indexers: [{ id: 4, name: 'TorrentDay' }, { id: 7, name: 'Nyaa' }],
    });
    prowlarr.setResults(4, RELEASES.filter((r) => r.indexerId === 4));
    prowlarr.setResults(7, RELEASES.filter((r) => r.indexerId === 7));
    app = await startApp({ port: PORT, password: PASSWORD });

    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();

    await login(page, app.origin, PASSWORD);
    await seedInstance(page, 'prowlarr', 'Prowlarr', prowlarr.url, {
      type: 'api-key', apiKey: 'prowlarr-key',
    });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await app?.close();
    await prowlarr?.close();
  });

  it('renders a 300-release answer as a bounded window', async () => {
    const started = Date.now();
    await search();
    const elapsed = Date.now() - started;

    // The whole answer arrived — 300 is the cap, so nothing was dropped on the
    // way and the grid is being asked for the worst case it will ever face.
    expect(await page.getAttribute('.rgrid', 'aria-rowcount')).toBe(String(RESULT_COUNT + 1));

    // And it is on the screen's terms: a window of rows, not 300 of them. 80 is
    // well above the ~26 visible rows plus the 12-row overscan on either side,
    // and far below anything that would mean virtualization broke.
    const rendered = await page.locator('.rgrid__body-row').count();
    expect(rendered, `${rendered} rows in the DOM — the grid stopped virtualizing`)
      .toBeLessThan(80);

    // Generous, and still an order of magnitude under the point where an
    // operator would go looking for the spinner. This covers the round trip to
    // both indexers as well as the render.
    expect(elapsed, `first row took ${elapsed}ms`).toBeLessThan(15_000);
  }, 90_000);

  it('re-sorts the full set within a frame budget, and stays a window while doing it', async () => {
    await search();

    // The server orders by seeders so the cap cuts the right end; the screen
    // opens on that order, which is what the first click has to reverse.
    const initial = await renderedSeeders();
    expect(initial.length).toBeGreaterThan(0);
    expect([...initial].sort((a, b) => b - a)).toEqual(initial);

    /**
     * Click to paint, measured in the page.
     *
     * A `MutationObserver` on the canvas is what makes this a measurement of the
     * re-sort rather than of the click: it resolves on the commit that changed
     * the rows, and the two `requestAnimationFrame`s after it push the reading
     * past the frame that painted them.
     */
    async function sortBy(column: string) {
      return page.evaluate(async (selector) => {
        const button = document.querySelector<HTMLButtonElement>(selector);
        if (!button) throw new Error(`no sort control at ${selector}`);
        const canvas = document.querySelector('.rgrid__canvas')!;

        const committed = new Promise<void>((resolve) => {
          const observer = new MutationObserver(() => { observer.disconnect(); resolve(); });
          observer.observe(canvas, { subtree: true, childList: true, characterData: true });
        });

        const t0 = performance.now();
        button.click();
        await committed;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return {
          ms: performance.now() - t0,
          rows: document.querySelectorAll('.rgrid__body-row').length,
        };
      }, column);
    }

    // Same column, so the sort has to reverse 300 rows — the most expensive
    // thing a click on this header can ask for.
    const reversed = await sortBy('.rgrid__head .rcol-seeders .rgrid__sort');
    expect(await page.getAttribute('.rgrid__head .rcol-seeders', 'aria-sort')).toBe('ascending');
    const ascending = await renderedSeeders();
    expect([...ascending].sort((a, b) => a - b)).toEqual(ascending);
    expect(ascending[0]).toBeLessThan(initial[0]);

    // A different column, which also re-reads every row's content rather than
    // reversing a sequence it already had.
    const bySize = await sortBy('.rgrid__head .rcol-size .rgrid__sort');
    expect(await page.getAttribute('.rgrid__head .rcol-size', 'aria-sort')).toBe('descending');
    expect(await page.getAttribute('.rgrid__head .rcol-seeders', 'aria-sort')).toBe('none');

    for (const [label, result] of [['seeders', reversed], ['size', bySize]] as const) {
      expect(result.ms, `re-sort by ${label} took ${result.ms.toFixed(1)}ms`)
        .toBeLessThan(SORT_BUDGET_MS);
      // The bound that matters most: a re-sort is exactly where a grid stops
      // virtualizing, because every row changed and the cheap thing to do is
      // render all of them.
      expect(result.rows, `re-sort by ${label} left ${result.rows} rows in the DOM`)
        .toBeLessThan(80);
    }
  }, 90_000);

  it('scrolls the full 300 releases without dropping frames', async () => {
    await search();

    const result = await page.evaluate(async ({ maxSteps, pixelsPerStep }) => {
      const scroller = document.querySelector('.rgrid__scroll') as HTMLElement;
      const frames: number[] = [];
      let maxRows = 0;
      let last = performance.now();

      const atBottom = () =>
        scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;

      await new Promise<void>((resolve) => {
        let i = 0;
        const step = () => {
          const now = performance.now();
          frames.push(now - last);
          last = now;
          maxRows = Math.max(maxRows, document.querySelectorAll('.rgrid__body-row').length);
          scroller.scrollTop += pixelsPerStep;
          // Run to the end of the list rather than for a fixed count, so the
          // sweep stays complete when the viewport or row height changes.
          if (atBottom() || ++i >= maxSteps) resolve();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });

      return {
        // The first interval measures the gap to the rAF that started the loop,
        // not a rendered frame.
        frames: frames.slice(1),
        maxRows,
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
      };
    }, { maxSteps: 400, pixelsPerStep: 34 * 6 });

    // The scroll really did traverse the list, so the frame numbers describe
    // work rather than a no-op loop against an already-pinned scrollTop.
    expect(result.scrollTop + result.clientHeight)
      .toBeGreaterThanOrEqual(result.scrollHeight - 1);

    // Still a window, at every point during the traversal.
    expect(result.maxRows, `peaked at ${result.maxRows} rows in the DOM`).toBeLessThan(80);

    const long = result.frames.filter((f) => f > LONG_FRAME_MS);
    const median = [...result.frames].sort((a, b) => a - b)[Math.floor(result.frames.length / 2)];

    // A handful of long frames is the machine, not the grid; a majority of them
    // is a re-render that scales with the list.
    expect(long.length, `${long.length}/${result.frames.length} frames over ${LONG_FRAME_MS}ms`)
      .toBeLessThanOrEqual(Math.ceil(result.frames.length * 0.1));
    expect(median, `median frame ${median.toFixed(1)}ms`).toBeLessThan(LONG_FRAME_MS);
  }, 90_000);
});

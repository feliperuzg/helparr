import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { login, seedInstance, startApp, type AppServer } from './helpers/appServer';
import { fakeQueue, startFakeArr, type FakeArr } from './helpers/fakeArr';

/**
 * T25 / NFR7 — a 500-row queue renders and scrolls without perceptible lag.
 *
 * "Perceptible lag" is not directly measurable, so this asserts the two things
 * that produce it, and does so in a real browser because neither survives a
 * jsdom render:
 *
 *  1. **The DOM stays bounded.** The cost that makes a long queue lag is
 *     500 rows of layout per frame. If the rendered window ever stops being a
 *     window, the frame budget is gone no matter how fast the machine is — and
 *     this is the assertion that still holds on hardware slower than this one.
 *  2. **Frames stay short while scrolling.** The thresholds are deliberately
 *     generous: this is a regression guard against an O(n)-per-frame re-render,
 *     not a benchmark, and a tight budget measured on a dev machine would only
 *     produce a flaky test that says nothing about the "modest hardware" NFR7
 *     actually names.
 *
 * Gated behind HELPARR_E2E_TEST (set by `npm run test:e2e`).
 */

const PORT = 3990;
const PASSWORD = 'operator-password-for-the-perf-run';
const QUEUE_SIZE = 500;

/** Frames longer than this read as a stutter rather than a smooth scroll. */
const LONG_FRAME_MS = 50;

let app: AppServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let sonarr: FakeArr;

describe('queue performance', () => {
  beforeAll(async () => {
    sonarr = await startFakeArr({ apiKey: 'sonarr-key', queue: fakeQueue(QUEUE_SIZE) });
    app = await startApp({ port: PORT, password: PASSWORD });

    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();

    await login(page, app.origin, PASSWORD);
    await seedInstance(page, 'sonarr', 'Sonarr', sonarr.url, {
      type: 'api-key', apiKey: 'sonarr-key',
    });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await app?.close();
    await sonarr?.close();
  });

  it('renders a 500-row queue as a bounded window', async () => {
    const started = Date.now();
    await page.goto(app.origin);
    await page.waitForSelector('.qgrid__body-row');
    const elapsed = Date.now() - started;

    expect(await page.getAttribute('.qgrid', 'aria-rowcount')).toBe(String(QUEUE_SIZE + 1));

    // The whole queue is on the screen's terms — a window of rows, not 500 of
    // them. 80 is well above the ~26 visible rows plus the 12-row overscan on
    // either side, and far below anything that would mean virtualization broke.
    const rendered = await page.locator('.qgrid__body-row').count();
    expect(rendered, `${rendered} rows in the DOM — the grid stopped virtualizing`)
      .toBeLessThan(80);

    // Generous, and still an order of magnitude under the point where an
    // operator would go looking for the spinner.
    expect(elapsed, `first row took ${elapsed}ms`).toBeLessThan(10_000);
  }, 60_000);

  it('scrolls the full 500 rows without dropping frames', async () => {
    await page.goto(app.origin);
    await page.waitForSelector('.qgrid__body-row');

    const result = await page.evaluate(async ({ maxSteps, pixelsPerStep }) => {
      const scroller = document.querySelector('.qgrid__scroll') as HTMLElement;
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
          maxRows = Math.max(maxRows, document.querySelectorAll('.qgrid__body-row').length);
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
  }, 60_000);
});

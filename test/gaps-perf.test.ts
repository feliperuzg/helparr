import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { login, seedInstance, startApp, type AppServer } from './helpers/appServer';
import { startFakeArr, type FakeGapRecord, type FakeArr } from './helpers/fakeArr';

/**
 * T21 / NFR2 — 2,000 gaps across 40 series render, filter and scroll without
 * perceptible lag.
 *
 * The number is the one the proposal names, and it is not the ceiling: the read
 * itself is bounded at 25 pages of 200. What makes this screen harder than the
 * search grid is the *interleaving* — the list the virtualizer measures is not
 * the list of gaps, it is gaps plus a group heading every fifty rows, and the
 * cursor addresses the gaps while the window addresses the render rows. A
 * mistake in that translation shows up as either a DOM that stops being a
 * window or a scroll that stutters, which is what this file measures.
 *
 * "Perceptible lag" is not directly measurable, so what is asserted is the two
 * things that cause it, exactly as in `search-perf.test.ts`:
 *
 *  1. **The DOM stays bounded** — on first paint, while filtering, and at every
 *     point during a full traversal. A grid that renders all 2,000 rows will
 *     still look fine on this machine and fall over on the operator's.
 *  2. **The work stays off the frame** — filtering is measured from the
 *     keystroke to the paint that shows the narrowed list, and the traversal is
 *     measured frame by frame. Both budgets are deliberately generous: this is a
 *     regression guard against an O(n)-per-frame re-render, not a benchmark.
 *
 * Gated behind HELPARR_E2E_TEST (set by `npm run test:e2e`).
 */

const PORT = 3996;
const PASSWORD = 'operator-password-for-the-gaps-perf-run';

/** 40 headings × 50 episodes. The interleaving is the point (see above). */
const SERIES_COUNT = 40;
const PER_SERIES = 50;
const GAP_COUNT = SERIES_COUNT * PER_SERIES;

/** Frames longer than this read as a stutter rather than a smooth scroll. */
const LONG_FRAME_MS = 50;

/** Keystroke to painted re-filter over 2,000 rows. */
const FILTER_BUDGET_MS = 400;

const seriesName = (n: number) => `Series ${String(n).padStart(2, '0')}`;

const SERIES = Array.from({ length: SERIES_COUNT }, (_, i) => ({
  id: i + 1,
  title: seriesName(i + 1),
  path: `/tv/${seriesName(i + 1)}`,
  qualityProfileId: 3,
}));

/**
 * Every episode of every series is missing. Titles carry the series number too,
 * so the filter under test has to narrow on something other than a prefix that
 * happens to be unique.
 */
const WANTED: FakeGapRecord[] = SERIES.flatMap((series, s) => (
  Array.from({ length: PER_SERIES }, (_, e) => ({
    id: s * PER_SERIES + e + 1,
    seriesId: series.id,
    seasonNumber: 1,
    episodeNumber: e + 1,
    title: `Episode ${e + 1}`,
    airDateUtc: '2025-01-01T00:00:00Z',
    monitored: true,
    hasFile: false,
  }))
));

let app: AppServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let sonarr: FakeArr;

/** Opens the screen and waits for the whole answer to be on it. */
async function openGaps() {
  await page.goto(`${app.origin}/gaps`);
  await expect
    .poll(() => page.getAttribute('.ggrid', 'aria-rowcount'), { timeout: 60_000 })
    .toBe(String(GAP_COUNT + SERIES_COUNT + 1));
}

describe('library-gaps performance', () => {
  beforeAll(async () => {
    sonarr = await startFakeArr({ apiKey: 'sonarr-key' });
    sonarr.setWanted(WANTED);
    sonarr.setSeries(SERIES);
    sonarr.setProfiles([{ id: 3, name: 'HD-1080p' }]);

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

  it('renders 2,000 gaps across 40 headings as a bounded window', async () => {
    const started = Date.now();
    await openGaps();
    const elapsed = Date.now() - started;

    // Nothing was dropped on the way: 2,000 gaps is ten pages of the upstream's
    // 200, so the paging loop ran to the end rather than trusting page one.
    expect(sonarr.wantedRequests.length).toBeGreaterThanOrEqual(GAP_COUNT / 200);

    // The count the toolbar reads is the whole answer, not the window.
    expect(await page.textContent('.toolbar [role="status"]'))
      .toContain(`${GAP_COUNT} of ${GAP_COUNT} shown`);

    // And it is on the screen's terms: a window of rows, not 2,000 of them. 80
    // is well above the ~25 visible rows plus the 12-row overscan on either
    // side, and far below anything that would mean virtualization broke.
    const rendered = await page.locator('.ggrid__body-row').count();
    expect(rendered, `${rendered} rows in the DOM — the grid stopped virtualizing`)
      .toBeLessThan(80);

    // Group headings are windowed too — they are render rows like any other, and
    // a grid that rendered all 40 of them would be rendering 40 headings for the
    // ~2 an operator can see.
    const headings = await page.locator('.ggrid__group').count();
    expect(headings, `${headings} headings in the DOM`).toBeLessThan(20);

    // Generous, and still well under the point where an operator goes looking
    // for the spinner. Covers the ten-page upstream read and the library join
    // as well as the render.
    expect(elapsed, `first full answer took ${elapsed}ms`).toBeLessThan(30_000);
  }, 120_000);

  it('filters 2,000 gaps within a frame budget, and stays a window while doing it', async () => {
    await openGaps();

    /**
     * Keystroke to paint, measured in the page.
     *
     * The value is set through the native setter and announced with a bubbling
     * `input` event, which is what React listens for — `input.value = x` alone
     * changes the DOM without telling the component. A `MutationObserver` on the
     * canvas resolves on the commit that changed the rows, and the two
     * `requestAnimationFrame`s after it push the reading past the frame that
     * painted them.
     */
    async function filterTo(needle: string) {
      return page.evaluate(async (value) => {
        const input = document.querySelector<HTMLInputElement>('#list-search');
        if (!input) throw new Error('no filter input');
        const canvas = document.querySelector('.ggrid__canvas')!;
        const setValue = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value',
        )!.set!;

        const committed = new Promise<void>((resolve) => {
          const observer = new MutationObserver(() => { observer.disconnect(); resolve(); });
          observer.observe(canvas, { subtree: true, childList: true, characterData: true });
        });

        const t0 = performance.now();
        setValue.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await committed;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return {
          ms: performance.now() - t0,
          rows: document.querySelectorAll('.ggrid__body-row').length,
        };
      }, needle);
    }

    // One heading's worth: 2,000 candidates in, 50 rows out. Every gap is tested
    // against the needle, so this is the whole list's cost on one keystroke.
    const narrowed = await filterTo(seriesName(7));
    await expect
      .poll(() => page.textContent('.toolbar [role="status"]'))
      .toContain(`${PER_SERIES} of ${GAP_COUNT} shown`);
    expect(await page.getAttribute('.ggrid', 'aria-rowcount')).toBe(String(PER_SERIES + 1 + 1));
    expect(await page.textContent('.ggrid__group-title')).toBe(seriesName(7));

    // Widening again is the more expensive direction — the row count goes back
    // up rather than down, so a grid that only virtualizes on the way in fails
    // here rather than above.
    const widened = await filterTo('Episode 1');
    await expect
      .poll(() => page.getAttribute('.ggrid', 'aria-rowcount'), { timeout: 10_000 })
      .not.toBe(String(PER_SERIES + 1 + 1));

    for (const [label, result] of [['narrow', narrowed], ['widen', widened]] as const) {
      expect(result.ms, `filter (${label}) took ${result.ms.toFixed(1)}ms`)
        .toBeLessThan(FILTER_BUDGET_MS);
      // The bound that matters most: a re-filter is exactly where a grid stops
      // virtualizing, because every row changed and the cheap thing to do is
      // render all of them.
      expect(result.rows, `filter (${label}) left ${result.rows} rows in the DOM`)
        .toBeLessThan(80);
    }

    // Leave the screen as it was found, so a re-ordering of these tests does not
    // hand the next one a filtered grid.
    await page.fill('#list-search', '');
  }, 120_000);

  it('scrolls all 2,000 gaps and 40 headings without dropping frames', async () => {
    await openGaps();

    const result = await page.evaluate(async ({ maxSteps, pixelsPerStep }) => {
      const scroller = document.querySelector('.ggrid__scroll') as HTMLElement;
      const frames: number[] = [];
      let maxRows = 0;
      let headingsSeen = 0;
      let last = performance.now();

      const atBottom = () =>
        scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;

      await new Promise<void>((resolve) => {
        let i = 0;
        const step = () => {
          const now = performance.now();
          frames.push(now - last);
          last = now;
          maxRows = Math.max(maxRows, document.querySelectorAll('.ggrid__body-row').length);
          headingsSeen = Math.max(
            headingsSeen,
            document.querySelectorAll('.ggrid__group').length,
          );
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
        headingsSeen,
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
      };
    }, { maxSteps: 1_200, pixelsPerStep: 36 * 8 });

    // The scroll really did traverse the list, so the frame numbers describe
    // work rather than a no-op loop against an already-pinned scrollTop.
    expect(result.scrollTop + result.clientHeight)
      .toBeGreaterThanOrEqual(result.scrollHeight - 1);

    // Headings were crossed on the way — the interleaved case actually happened,
    // rather than the sweep running over one long run of plain rows.
    expect(result.headingsSeen).toBeGreaterThan(0);

    // Still a window, at every point during the traversal.
    expect(result.maxRows, `peaked at ${result.maxRows} rows in the DOM`).toBeLessThan(80);

    const long = result.frames.filter((f) => f > LONG_FRAME_MS);
    const median = [...result.frames].sort((a, b) => a - b)[Math.floor(result.frames.length / 2)];

    // A handful of long frames is the machine, not the grid; a majority of them
    // is a re-render that scales with the list.
    expect(long.length, `${long.length}/${result.frames.length} frames over ${LONG_FRAME_MS}ms`)
      .toBeLessThanOrEqual(Math.ceil(result.frames.length * 0.1));
    expect(median, `median frame ${median.toFixed(1)}ms`).toBeLessThan(LONG_FRAME_MS);
  }, 120_000);
});

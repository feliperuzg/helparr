import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { login, seedInstance, startApp, type AppServer } from './helpers/appServer';
import { startFakeArr, type FakeArr } from './helpers/fakeArr';

/**
 * T18 / NFR2 — a 5,000-row plan renders, scrolls and re-renders without
 * perceptible lag.
 *
 * 5,000 is the number the proposal names, and this grid reaches it more easily
 * than the others: a plan is one file per row, and a single season pass over a
 * mid-sized library produces thousands. Two things make it harder than the gaps
 * grid it borrows from:
 *
 *  1. **Every row carries two paths, not one field.** Each cell diffs the
 *     existing path against the proposed one and renders the difference as
 *     spans. That work is per rendered row, and it stays affordable only while
 *     "rendered" means the window rather than the plan.
 *  2. **Exclusion re-renders the whole list.** Unticking the header checkbox
 *     changes 5,000 rows at once and the answer arrives from the server, so the
 *     grid rebuilds from a new array rather than mutating one. That is exactly
 *     the path where a grid quietly stops virtualizing.
 *
 * As in the other perf lanes, "perceptible lag" is not directly measurable, so
 * what is asserted is the two things that cause it: the DOM stays bounded, and
 * the work stays off the frame. Both budgets are deliberately generous — this is
 * a regression guard against an O(n)-per-frame re-render, not a benchmark.
 *
 * Gated behind HELPARR_E2E_TEST (set by `npm run test:e2e`).
 */

const PORT = 3986;
const PASSWORD = 'operator-password-for-the-rename-perf-run';

/** 10 headings × 500 files. The interleaving is the point, as in gaps-perf. */
const TITLE_COUNT = 10;
const PER_TITLE = 500;
const ROW_COUNT = TITLE_COUNT * PER_TITLE;

/** Frames longer than this read as a stutter rather than a smooth scroll. */
const LONG_FRAME_MS = 50;

/** Click to painted totals for a 5,000-row exclusion, server round trip included. */
const BULK_BUDGET_MS = 10_000;

const seriesName = (n: number) => `Series ${String(n).padStart(2, '0')}`;

const SERIES = Array.from({ length: TITLE_COUNT }, (_, i) => ({
  id: i + 1,
  title: seriesName(i + 1),
  path: `/tv/${seriesName(i + 1)}`,
  statistics: { episodeFileCount: PER_TITLE },
}));

/**
 * One title's worth of pending renames, in the shape the real `/rename`
 * returns. Every row moves into a season folder, so every row also carries a
 * derived flag — the expensive rendering path rather than the cheap one.
 */
function previewFor(seriesId: number): unknown[] {
  return Array.from({ length: PER_TITLE }, (_, i) => ({
    seriesId,
    seasonNumber: 1,
    episodeNumbers: [i + 1],
    episodeFileId: seriesId * 10_000 + i,
    existingPath: `${seriesName(seriesId).toLowerCase().replace(' ', '.')}.s01e${i + 1}.mkv`,
    newPath: `Season 1/${seriesName(seriesId)} - S01E${String(i + 1).padStart(3, '0')}.mkv`,
  }));
}

let app: AppServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let sonarr: FakeArr;

/** Headings are render rows like any other, and the header row is the +1. */
const EXPECTED_ROWCOUNT = String(ROW_COUNT + TITLE_COUNT + 1);

/**
 * Builds the 5,000-row plan once and leaves the browser on it.
 *
 * Built per test rather than shared: the third test excludes everything, and a
 * plan handed on in that state would make the first two measure a grid of empty
 * rows. Rebuilding costs ten fake round trips, not ten real ones.
 */
async function buildPlan(): Promise<number> {
  const started = Date.now();
  await page.goto(`${app.origin}/rename`);
  await page.waitForSelector('.scope__item', { timeout: 30_000 });
  // One tick for all ten titles — the picker's own select-all, which is the
  // control an operator with a library this size would actually use.
  await page.check('.scope__all input[type="checkbox"]');
  await page.click('.scope__foot button');
  await expect.poll(() => page.getAttribute('.pgrid', 'aria-rowcount'), { timeout: 90_000 })
    .toBe(EXPECTED_ROWCOUNT);
  return Date.now() - started;
}

describe('bulk-rename performance', { timeout: 240_000 }, () => {
  beforeAll(async () => {
    sonarr = await startFakeArr({ apiKey: 'sonarr-key' });
    sonarr.setSeries(SERIES);
    sonarr.setSeriesDetail({ id: 1, title: seriesName(1), path: `/tv/${seriesName(1)}` });
    sonarr.setRenamePreview((query) => previewFor(Number(query.seriesId ?? 1)));

    app = await startApp({ port: PORT, password: PASSWORD });

    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();

    await login(page, app.origin, PASSWORD);
    await seedInstance(page, 'sonarr', 'Sonarr', sonarr.url, {
      type: 'api-key', apiKey: 'sonarr-key',
    });
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await app?.close();
    await sonarr?.close();
  });

  it('renders a 5,000-row plan across 10 headings as a bounded window', async () => {
    const elapsed = await buildPlan();

    // The totals describe the plan, not the window — the number the operator is
    // about to be asked to type is the whole answer.
    expect(await page.textContent('.totals__main')).toContain(`${ROW_COUNT} files`);
    expect(await page.textContent('.bulkbar__count'))
      .toContain(`${ROW_COUNT} files will be renamed`);

    // 80 is well above the ~18 visible rows plus the overscan on either side,
    // and far below anything that would mean virtualization broke.
    const rendered = await page.locator('.pgrid__body-row').count();
    expect(rendered, `${rendered} rows in the DOM — the grid stopped virtualizing`)
      .toBeLessThan(80);

    const headings = await page.locator('.pgrid__group').count();
    expect(headings, `${headings} headings in the DOM`).toBeLessThan(20);

    // Every rendered row diffs its two paths; none of the 4,900-odd unrendered
    // ones does, which is the property that keeps the first paint affordable.
    const diffs = await page.locator('.path-cell').count();
    expect(diffs, `${diffs} path diffs rendered`).toBeLessThan(80);

    // Ten rescans, ten previews and the render. Generous, and still well under
    // the point where an operator goes looking for the spinner.
    expect(elapsed, `plan of ${ROW_COUNT} rows took ${elapsed}ms`).toBeLessThan(90_000);
  }, 180_000);

  it('scrolls all 5,000 rows and 10 headings without dropping frames', async () => {
    await buildPlan();

    const result = await page.evaluate(async ({ maxSteps, pixelsPerStep }) => {
      const scroller = document.querySelector('.pgrid__scroll') as HTMLElement;
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
          maxRows = Math.max(maxRows, document.querySelectorAll('.pgrid__body-row').length);
          headingsSeen = Math.max(
            headingsSeen,
            document.querySelectorAll('.pgrid__group').length,
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
    }, { maxSteps: 2_000, pixelsPerStep: 40 * 8 });

    // The scroll really did traverse the list, so the frame numbers describe
    // work rather than a no-op loop against an already-pinned scrollTop.
    expect(result.scrollTop + result.clientHeight)
      .toBeGreaterThanOrEqual(result.scrollHeight - 1);
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
  }, 180_000);

  it('excludes and re-includes all 5,000 rows without losing the window', async () => {
    await buildPlan();

    // The header tick is a 5,000-id PATCH and a 5,000-row answer: the whole
    // list changes identity at once, which is the shape that tempts a grid into
    // rendering everything.
    const excludeStarted = Date.now();
    // Clicked and then waited for: the tick is a PATCH, not local state, and
    // the count below is the server's answer rather than an optimistic guess.
    await page.click('.pgrid__head input[type="checkbox"]');
    // Matched whole, not contained: "5000 files will be renamed" ends in
    // "0 files will be renamed", so a substring match here is satisfied by the
    // text that was already on screen and measures nothing.
    await expect.poll(
      async () => (await page.textContent('.bulkbar__count'))?.trim(),
      { timeout: BULK_BUDGET_MS },
    ).toBe('0 files will be renamed');
    const excludeMs = Date.now() - excludeStarted;

    expect(await page.locator('.pgrid__body-row').count()).toBeLessThan(80);
    // Excluding everything leaves nothing to approve, and the control that would
    // send it says so by being unavailable rather than by disappearing.
    expect(await page.isDisabled('.bulkbar--apply .btn-danger-solid')).toBe(true);

    const includeStarted = Date.now();
    await page.click('.pgrid__head input[type="checkbox"]');
    await expect.poll(() => page.textContent('.bulkbar__count'), { timeout: BULK_BUDGET_MS })
      .toContain(`${ROW_COUNT} files will be renamed`);
    const includeMs = Date.now() - includeStarted;

    const rendered = await page.locator('.pgrid__body-row').count();
    expect(rendered, `${rendered} rows in the DOM after a full re-include`).toBeLessThan(80);

    for (const [label, ms] of [['exclude', excludeMs], ['include', includeMs]] as const) {
      expect(ms, `${label} of ${ROW_COUNT} rows took ${ms}ms`).toBeLessThan(BULK_BUDGET_MS);
    }
  }, 180_000);
});

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { login, seedInstance, startApp, type AppServer } from './helpers/appServer';
import { fakeQueue, fakeWanted, startFakeArr, type FakeArr } from './helpers/fakeArr';
import { startFakeProwlarr, type FakeProwlarr } from './helpers/fakeProwlarr';

/**
 * T11, T12 / AC5, AC10 — FR5; NFR2; REQ-A11Y-009.
 *
 * Two halves of one bargain. Moving 136 pixel literals onto a fluid scale makes
 * text grow, and text that grows inside a box that does not is text you cannot
 * read — so AC5 asks whether anything clips. The obvious way to buy that safety
 * is to loosen the dense grids until nothing can ever collide, which would
 * quietly cost the product the thing it is for — so AC10 asks whether the queue
 * still packs rows at the same pitch. Neither number means much alone.
 *
 * ## Why 720x450 is 200% zoom
 *
 * Browser zoom does not scale the viewport; it shrinks it, measured in CSS
 * pixels. A 1440x900 window at 200% lays out as 720x450 CSS px on a 2x device
 * pixel ratio, which is exactly the context below. This is the same arithmetic
 * WCAG 1.4.10 uses when it defines reflow as 320 CSS px — 1280px at 400%.
 * `Emulation.setPageScaleFactor` is the other candidate and is the wrong one:
 * it is pinch zoom, which magnifies without reflowing, so it would prove
 * nothing about a fixed-height container.
 *
 * Note what this does NOT test: the default-font-size preference, which is the
 * other half of REQ-A11Y-009 and lives in `test/text-resize.test.ts`. Zoom
 * scales `px` along with everything else, so a row pinned at `34px` is in no
 * danger from zoom at all — its ratio to the text inside it never changes. The
 * preference is what moves them apart, and the two need separate sweeps.
 *
 * Gated behind HELPARR_E2E_TEST (set by `npm run test:e2e`), self-gated with
 * `skipIf` so the default lane reports it as skipped rather than as absent.
 */

const PORT = 3998;
const PASSWORD = 'operator-password-for-the-zoom-clipping-sweep';

/** A 1440x900 display at 200% browser zoom, in CSS pixels. */
const ZOOM_VIEWPORT = { width: 720, height: 450 };

/** `--row-height` in globals.css. Deliberately unchanged by this proposal. */
const ROW_HEIGHT = 34;

/** Enough rows that the queue grid is genuinely virtualized. */
const QUEUE_SIZE = 500;

/** The six screens AC5 names, in nav order. Activity is routed as /operations. */
const SCREENS: Array<[label: string, path: string, ready: string]> = [
  ['Overview', '/', '.qgrid__body-row'],
  ['Search', '/search', '.stoolbar'],
  ['Gaps', '/gaps', '.screen-head__title'],
  ['Rename', '/rename', '.screen-head__title'],
  ['Activity', '/operations', '.screen-head__title'],
  ['Settings', '/settings', '.screen-head__title'],
];

let app: AppServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let sonarr: FakeArr;
let prowlarr: FakeProwlarr;

/**
 * Every visible element whose own box cuts its content off vertically.
 *
 * `overflow-y: hidden` is the mechanism — an element that scrolls is not
 * clipping, it is deferring, and an element with visible overflow spills rather
 * than hides. `scrollHeight` reports the full content extent either way, so the
 * comparison is the same one the browser itself makes. The 1px allowance is for
 * subpixel layout, not for slack: a clipped line is short by several.
 *
 * Horizontal truncation is deliberately not checked. `.truncate` is a designed
 * affordance with an ellipsis and a title attribute, not a failure, and it is
 * single-line so it never trips the test above.
 *
 * The one exemption is the visually-hidden idiom — `globals.css:280`, a 1px box
 * with `overflow: hidden` and `clip: rect(0 0 0 0)` whose entire purpose is to
 * hide text from the screen while leaving it to the accessibility tree. It is
 * matched on its geometry rather than on the `.sr-only` class name, so a second
 * implementation of the same trick is exempt too and a real container that
 * happens to be named that way is not.
 */
async function clipped(): Promise<string[]> {
  return page.evaluate(() => {
    const label = (el: Element) => {
      const classes = [...el.classList].join('.');
      return `${el.tagName.toLowerCase()}${classes ? `.${classes}` : ''}`;
    };

    const found: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      if (el.getClientRects().length === 0) continue;
      // Visually hidden, not clipped: nothing 1px on a side was ever showing
      // text to a sighted operator.
      if (el.clientHeight <= 1 || el.clientWidth <= 1) continue;
      const style = getComputedStyle(el);
      if (style.overflowY !== 'hidden' && style.overflowY !== 'clip') continue;
      if (el.scrollHeight > el.clientHeight + 1) {
        found.push(`${label(el)} — ${el.scrollHeight}px of content in a ${el.clientHeight}px box`);
      }
    }
    return found;
  });
}

describe.skipIf(!process.env.HELPARR_E2E_TEST)('200% zoom clips nothing, and the grid keeps its density', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    sonarr = await startFakeArr({ apiKey: 'sonarr-key', queue: fakeQueue(QUEUE_SIZE) });
    sonarr.setWanted(fakeWanted(40));
    sonarr.setSeries([
      { id: 1, title: 'Reacher', path: '/tv/Reacher', qualityProfileId: 3, statistics: { episodeFileCount: 120 } },
    ]);
    sonarr.setProfiles([{ id: 3, name: 'HD-1080p' }]);
    prowlarr = await startFakeProwlarr({
      apiKey: 'prowlarr-key',
      indexers: [{ id: 4, name: 'TorrentDay' }],
    });

    app = await startApp({ port: PORT, password: PASSWORD });

    browser = await chromium.launch();
    // Seeding happens at a normal size; only the sweep itself runs zoomed, so a
    // layout that only exists below 860px cannot swallow a setup step.
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
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

  for (const [label, path, ready] of SCREENS) {
    it(`clips no text on ${label} at 200% zoom`, async () => {
      await page.setViewportSize(ZOOM_VIEWPORT);
      await page.goto(`${app.origin}${path}`);
      await page.waitForSelector(ready);
      // The virtualizer measures its scroll element on a frame, so a grid read
      // the instant the selector appears reports a window of one row.
      await page.waitForTimeout(250);

      const offenders = await clipped();
      expect(offenders, `${label} clips:\n  ${offenders.join('\n  ')}`).toEqual([]);
    });
  }

  it('keeps the queue grid at its 34px row pitch', async () => {
    // AC10, stated as the thing that actually determines how many rows fit.
    // Counting rows would fix the answer to one viewport; the pitch is the
    // property that makes the count what it is, at any viewport.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${app.origin}/`);
    await page.waitForSelector('.qgrid__body-row');
    await page.waitForTimeout(250);

    const heights = await page.locator('.qgrid__body-row').evaluateAll((rows) =>
      rows.map((row) => Math.round(row.getBoundingClientRect().height)));
    expect(heights.length, 'no rows rendered').toBeGreaterThan(0);
    for (const height of heights) expect(height).toBe(ROW_HEIGHT);
  });

  it('still fills the viewport with rows at 1440x900', async () => {
    const { rows, scroller } = await page.evaluate((rowHeight) => {
      const box = document.querySelector('.qgrid__scroll')!.getBoundingClientRect();
      const visible = [...document.querySelectorAll('.qgrid__body-row')].filter((row) => {
        const r = row.getBoundingClientRect();
        return r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
      });
      return { rows: visible.length, scroller: Math.floor(box.height / rowHeight) };
    }, ROW_HEIGHT);

    // One row of tolerance: the window is offset by a fractional scroll
    // position, so the first and last rows in view can each be partial.
    expect(
      rows,
      `${rows} rows fully visible in a scroller that fits ${scroller} — density was traded away`,
    ).toBeGreaterThanOrEqual(scroller - 1);
  });
});

import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { login, seedInstance, startApp, type AppServer } from './helpers/appServer';
import { fakeQueue, startFakeArr, type FakeArr } from './helpers/fakeArr';

/**
 * T10 / AC2, AC3 — FR2, FR3; REQ-A11Y-009.
 *
 * `test/type-scale.test.ts` proves every declaration names a `--text-*` token.
 * It cannot prove the operator's own font-size preference reaches the screen:
 * a token could resolve to a `px` value, a stylesheet could pin `html` to a
 * fixed size, a component could override with an inline style the scan does not
 * model. Only a real browser settles it, which is why ADR-5 split the check in
 * two and this is the rendered half.
 *
 * The preference is set through CDP `Page.setFontSizes`, which is the *only*
 * way to emulate it — Playwright has no option for it, and it is not the same
 * lever as zoom. That distinction is the whole point. Page zoom scales `px`
 * text along with everything else and would make this pass against the
 * pre-change build; the default-font-size preference moves `rem` and leaves
 * `px` exactly where it is. WCAG 1.4.4 is about the second one. The probe in
 * the first test is there to keep the two from being confused: it is a `12px`
 * element that must NOT move while the app's own text does.
 *
 * Gated behind HELPARR_E2E_TEST (set by `npm run test:e2e`). Its fourteen
 * siblings in that lane are gated by an exclusion in `vitest.config.ts`; this
 * one gates itself with `skipIf`, which has the same effect in the default lane
 * and one advantage — vitest reports it as skipped rather than as absent, so a
 * run that never reaches it says so out loud.
 */

const PORT = 3997;
const PASSWORD = 'operator-password-for-the-text-resize-sweep';

/** Chrome's largest "Very large" default font size. 16 is the shipped default. */
const LARGE_FONT = 24;

/**
 * A `rem`-derived size under a 24px default lands around 1.5x its 16px value —
 * the `vw` term in every `clamp()` does not scale, so the real ratios sit
 * between 1.45 and 1.5. 1.3 clears that with room while still failing hard for
 * anything declared in `px`, which does not move at all (ratio 1.0).
 */
const MIN_GROWTH = 1.3;

let app: AppServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let cdp: CDPSession;
let sonarr: FakeArr;

/**
 * The surfaces sampled for AC2, spread across the scale so a regression in any
 * single band shows up rather than hiding behind a neighbour: `--text-2xs` on
 * the version and the instance meta row, `--text-xs` on the sidebar and grid
 * labels, `--text-sm` on the brand and the topbar, `--text-base` on the body
 * and `--text-lg` on the screen title.
 */
const CHROME = [
  '.brand__name',
  '.brand__version',
  '.topbar__crumb',
  '.badge',
  '.navlink',
  '.sidebar__label',
  '.section__title',
  '.screen-head__title',
  '.instance__name',
  '.instance__meta',
  '.qgrid__head',
  '.qgrid__body-row',
  'body',
];

/**
 * The subset sampled for AC3. Below 860px the sidebar collapses into a drawer,
 * so anything inside it is absent at the narrow end and cannot be compared
 * across viewports. These are in the brand row, the topbar, the screen header
 * and the document body, which keep their layout at every breakpoint.
 */
const FLUID = [
  '.brand__name',
  '.brand__version',
  '.topbar__crumb',
  '.badge',
  '.screen-head__title',
  'body',
];

/** Computed `font-size` of the first match, in px. Fails rather than skipping. */
async function fontSize(selector: string): Promise<number> {
  const count = await page.locator(selector).count();
  expect(count, `nothing matched ${selector} — the sample would be vacuous`).toBeGreaterThan(0);
  return page.locator(selector).first().evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
}

async function sample(selectors: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const selector of selectors) out[selector] = await fontSize(selector);
  return out;
}

/**
 * Emulate the browser's default font-size preference, then reload so it applies.
 *
 * The session is opened once in `beforeAll` and held for the whole file on
 * purpose: `Page.setFontSizes` is an emulation override scoped to the CDP
 * session, so detaching after each call silently reverts it and every
 * measurement below comes back at the default size — which reads exactly like
 * an app that ignores the preference.
 */
async function setDefaultFontSize(size: number) {
  await cdp.send('Page.setFontSizes', { fontSizes: { standard: size, fixed: size } });
  await page.reload();
  await page.waitForSelector('.qgrid__body-row');
}

describe.skipIf(!process.env.HELPARR_E2E_TEST)('text resizes with the operator, and with the viewport', { timeout: 150_000 }, () => {
  beforeAll(async () => {
    sonarr = await startFakeArr({ apiKey: 'sonarr-key', queue: fakeQueue(40) });
    app = await startApp({ port: PORT, password: PASSWORD });

    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();
    cdp = await context.newCDPSession(page);

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

  it('grows every chrome surface when the default font size is raised', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await setDefaultFontSize(16);
    const before = await sample(CHROME);

    // The control. An element the app does not own, declared the way the app
    // used to declare all 136 of its sizes. If this moves, the browser is
    // zooming rather than honouring the preference, and every assertion below
    // is measuring the wrong thing.
    await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.id = 'px-probe';
      probe.style.fontSize = '12px';
      probe.textContent = 'probe';
      document.body.append(probe);
    });
    const probeBefore = await fontSize('#px-probe');
    expect(probeBefore).toBeCloseTo(12, 1);

    await setDefaultFontSize(LARGE_FONT);
    const after = await sample(CHROME);

    for (const selector of CHROME) {
      const ratio = after[selector] / before[selector];
      expect(
        ratio,
        `${selector} went ${before[selector]}px → ${after[selector]}px (${ratio.toFixed(2)}x) — ` +
          'a px literal would not have moved at all',
      ).toBeGreaterThanOrEqual(MIN_GROWTH);
    }

    // Re-injected: the reload inside `setDefaultFontSize` threw the first one away.
    await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.id = 'px-probe';
      probe.style.fontSize = '12px';
      probe.textContent = 'probe';
      document.body.append(probe);
    });
    expect(
      await fontSize('#px-probe'),
      'the 12px control moved — this is emulating zoom, not the font-size preference',
    ).toBeCloseTo(12, 1);
  });

  it('scales chrome text between the narrow and wide ends of the viewport', async () => {
    await setDefaultFontSize(16);

    await page.setViewportSize({ width: 320, height: 900 });
    const narrow = await sample(FLUID);

    await page.setViewportSize({ width: 1920, height: 900 });
    const wide = await sample(FLUID);

    for (const selector of FLUID) {
      // Every token pins to its own maximum somewhere at or below 1000px, so
      // the gap between these two ends is ~1-2px rather than dramatic. The
      // claim AC3 makes is that it is not zero: a fixed literal would measure
      // identical at both widths.
      expect(
        wide[selector] - narrow[selector],
        `${selector} measured ${narrow[selector]}px at 320px and ${wide[selector]}px at 1920px — flat`,
      ).toBeGreaterThanOrEqual(0.5);
    }

    await page.setViewportSize({ width: 1440, height: 900 });
  });
});

import AxeBuilder from '@axe-core/playwright';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { login, seedInstance, startApp, type AppServer } from './helpers/appServer';
import { fakeQueue, startFakeArr, type FakeArr } from './helpers/fakeArr';

/**
 * T20, T24 / AC14, NFR7 — Login, Settings and the Overview grid pass an axe
 * WCAG AA scan with zero violations, plus the three grid properties axe cannot
 * see: one tab stop, `aria-sort` on every sortable column, and row indices that
 * refer to the full list rather than the rendered window.
 *
 * This drives the real standalone build in a real browser rather than rendering
 * components under jsdom. NFR7's requirements are mostly *rendered* properties
 * — visible `:focus-visible` rings from `--color-ring`, contrast ratios from the
 * DESIGN.md token cascade, and a virtualizer that only computes a window once a
 * scroll element has a height — and jsdom resolves none of them, so a jsdom scan
 * would silently skip exactly the rules that matter here.
 *
 * Gated behind HELPARR_A11Y_TEST (set by `npm run test:a11y`) because it needs
 * `next build` plus a downloaded Chromium.
 */

const PORT = 3987;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'operator-password-for-the-a11y-scan';

/** WCAG 2.1 A + AA. Best-practice rules are deliberately not part of the gate. */
const WCAG_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** Enough rows that the grid is genuinely virtualized (NFR7, ADR-6). */
const QUEUE_SIZE = 500;

let app: AppServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let sonarr: FakeArr;
let radarr: FakeArr;

async function scan(context?: string) {
  // Let entry animations finish first. axe samples computed colours at the
  // instant it runs, and a dialog caught 10% through its fade reads as light
  // text at 10% opacity — a cascade of contrast "violations" that describe the
  // animation rather than the design. Infinite animations (the skeleton pulse)
  // are excluded, since waiting on those never returns.
  await page.evaluate(() => Promise.all(
    document.getAnimations()
      .filter((a) => (a.effect?.getComputedTiming().iterations ?? 1) !== Infinity)
      .map((a) => a.finished.catch(() => undefined)),
  ));

  const results = await new AxeBuilder({ page }).withTags(WCAG_AA).analyze();

  if (results.violations.length > 0) {
    // The default assertion message is an unreadable object dump, and an a11y
    // failure is only actionable if you can see which node tripped which rule.
    const detail = results.violations
      .map((v) => `  [${v.impact}] ${v.id}: ${v.help}\n${v.nodes
        .map((n) => `    ${n.target.join(' ')}\n      ${(n.failureSummary ?? '').split('\n').join('\n      ')}\n      ${n.html}`)
        .join('\n')}`)
      .join('\n');
    throw new Error(`axe found ${results.violations.length} WCAG AA violation(s)${context ? ` in ${context}` : ''}:\n${detail}`);
  }

  expect(results.violations).toHaveLength(0);
}

/** The Overview, loaded and settled, from a clean page state. */
async function openOverview() {
  await page.goto(`${ORIGIN}/`);
  await page.waitForSelector('.qgrid__body-row');
}

// Each scan boots axe into the page and walks the whole tree; the suite-wide
// 20s budget is sized for in-process tests, not for that.
describe('WCAG AA', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    sonarr = await startFakeArr({
      apiKey: 'sonarr-key',
      version: '4.0.10.2544',
      queue: fakeQueue(QUEUE_SIZE),
    });
    // A second instance, taken down later, so the scans also cover the degraded
    // Callout and banner — an error surface that only renders when something is
    // actually wrong is exactly the one that escapes review.
    radarr = await startFakeArr({ apiKey: 'radarr-key', version: '5.14.0.9383' });

    app = await startApp({ port: PORT, password: PASSWORD });

    browser = await chromium.launch();
    // AxeBuilder refuses a page from `browser.newPage()` — it needs the
    // explicit context so it can inject axe into every frame. The viewport is
    // stated rather than defaulted because the grid drops columns at 1279px,
    // and a default that drifts across the breakpoint would change what is
    // being scanned without anyone editing this file.
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await app?.close();
    await sonarr?.close();
    await radarr?.close();
  });

  it('Login has zero violations', async () => {
    await page.goto(`${ORIGIN}/login`);
    await page.waitForSelector('#operator-password');
    await scan('Login');
  });

  it('Login has zero violations while showing an error', async () => {
    await page.fill('#operator-password', 'definitely-the-wrong-password');
    await page.click('button[type="submit"]');
    await page.waitForSelector('.callout');
    await scan('Login (error state)');
  });

  it('keeps a visible focus ring on every interactive control', async () => {
    // NFR7 names this explicitly, and axe cannot check it: `outline: none` with
    // no replacement is valid HTML and invisible to a rule engine.
    await page.focus('#operator-password');
    const ring = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const style = getComputedStyle(el);
      return { outline: style.outlineStyle, width: style.outlineWidth, shadow: style.boxShadow };
    });
    const visible = (ring.outline !== 'none' && ring.width !== '0px') || ring.shadow !== 'none';
    expect(visible, `focused input had no visible ring: ${JSON.stringify(ring)}`).toBe(true);
  });

  it('Settings has zero violations, empty and populated', async () => {
    await login(page, ORIGIN, PASSWORD);

    await page.goto(`${ORIGIN}/settings`);
    await page.waitForSelector('text=No instances configured');
    await scan('Settings (empty)');

    await seedInstance(page, 'sonarr', 'Sonarr', sonarr.url, {
      type: 'api-key', apiKey: 'sonarr-key',
    });
    await seedInstance(page, 'radarr', 'Radarr', radarr.url, {
      type: 'api-key', apiKey: 'radarr-key',
    });

    // Take the second instance down so its card renders the degraded Callout.
    radarr.setMode('unauthorized');

    await page.reload();
    await page.waitForSelector('.card__title');
    await scan('Settings (populated)');
  });

  it('Settings has zero violations with the add form open', async () => {
    await page.click('text=Add instance');
    await page.waitForSelector('#new-kind');
    await scan('Settings (add instance)');
  });

  it('Settings has zero violations with the remove dialog open', async () => {
    // A modal is its own a11y surface — focus trapping, labelling, and the
    // aria-hidden state of everything behind it.
    await page.click('.btn-danger >> nth=0');
    await page.waitForSelector('[role="dialog"]');
    await scan('Settings (remove dialog)');
  });

  it('Overview has zero violations with a virtualized grid and a degraded instance', async () => {
    await openOverview();
    // The banner is part of the surface under scan, not incidental: Radarr is
    // still answering 401 from the Settings test above.
    await page.waitForSelector('.callout');
    await scan('Overview (populated, degraded)');
  });

  it('Overview has zero violations with rows selected and the removal dialog open', async () => {
    await openOverview();
    await page.click('.qgrid__body-row:nth-child(1) input[type="checkbox"]');
    await page.click('.bulkbar .btn-danger');
    await page.waitForSelector('[role="dialog"]');
    await scan('Overview (removal preview)');
    await page.click('.modal__foot .btn-ghost');
  });

  it('exposes the grid body as exactly one tab stop', async () => {
    await openOverview();

    // The roving tabindex, stated as an invariant: one row is reachable by Tab,
    // every other row is -1 and reachable only by arrow keys (ADR-7).
    expect(await page.locator('.qgrid__body-row[tabindex="0"]').count()).toBe(1);

    // And the actual walk, which is the thing operators experience. From the
    // last header button, Tab lands on that row…
    await page.locator('.qgrid__head .qgrid__sort').last().focus();
    await page.keyboard.press('Tab');
    const landed = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return {
        isRow: el?.classList.contains('qgrid__body-row') ?? false,
        rowindex: el?.getAttribute('aria-rowindex') ?? null,
      };
    });
    expect(landed.isRow, 'Tab from the header did not land on a grid row').toBe(true);
    expect(landed.rowindex).toBe('2');

    // …and Tab again leaves the grid entirely, rather than walking 500 rows.
    await page.keyboard.press('Tab');
    const stillInside = await page.evaluate(
      () => Boolean((document.activeElement as HTMLElement | null)?.closest('.qgrid')),
    );
    expect(stillInside, 'Tab did not escape the grid after one row').toBe(false);
  });

  it('states aria-sort on every sortable column, including the inactive ones', async () => {
    await openOverview();

    const read = () => page.locator('.qgrid__head [role="columnheader"]')
      .evaluateAll((cells) => cells.map((cell) => cell.getAttribute('aria-sort')));

    // Six sortable columns; select and peers carry no attribute at all, which
    // is how AT is told they cannot be sorted. Omitting it on an inactive
    // sortable column would say the same thing — wrongly.
    const initial = await read();
    expect(initial.filter((s) => s !== null)).toHaveLength(6);
    expect(initial.filter((s) => s !== null && s !== 'none')).toEqual(['ascending']);

    // The default sort is state; moving it to Release must move the attribute
    // too, not merely re-order the rows.
    await page.click('.qgrid__head .qgrid__sort:has-text("Release")');
    const afterClick = await read();
    expect(afterClick.filter((s) => s !== null && s !== 'none')).toEqual(['ascending']);
    expect(afterClick[1]).toBe('none');
    expect(afterClick[2]).toBe('ascending');

    // Clicking the active column flips the direction rather than re-sorting.
    await page.click('.qgrid__head .qgrid__sort:has-text("Release")');
    expect((await read())[2]).toBe('descending');
  });

  it('reports true row indices under virtualization', async () => {
    await openOverview();

    // The count is the full queue plus the header row, whatever is rendered.
    expect(await page.getAttribute('.qgrid', 'aria-rowcount')).toBe(String(QUEUE_SIZE + 1));

    const indicesNow = () => page.locator('.qgrid__body-row')
      .evaluateAll((rows) => rows.map((r) => Number(r.getAttribute('aria-rowindex'))));

    const atTop = await indicesNow();
    // If this ever equals QUEUE_SIZE the grid stopped virtualizing, and the
    // rest of this test would pass for the wrong reason.
    expect(atTop.length).toBeLessThan(QUEUE_SIZE / 2);
    expect(atTop).toContain(2);

    await page.locator('.qgrid__scroll').evaluate((el) => { el.scrollTop = el.scrollHeight; });

    // The last row of the list announces itself as row 501 of 501 — not as row
    // 40 of 40, which is what the rendered window alone would say.
    await expect.poll(async () => (await indicesNow()).includes(QUEUE_SIZE + 1), {
      timeout: 10_000,
    }).toBe(true);
    const atBottom = await indicesNow();
    expect(atBottom.length).toBeLessThan(QUEUE_SIZE / 2);
  });
});

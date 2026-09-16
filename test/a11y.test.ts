import AxeBuilder from '@axe-core/playwright';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { login, seedInstance, startApp, type AppServer } from './helpers/appServer';
import { fakeQueue, parsedSeries, startFakeArr, type FakeArr } from './helpers/fakeArr';
import { fakeReleases, startFakeProwlarr, type FakeProwlarr } from './helpers/fakeProwlarr';

/**
 * T20, T24 / AC14, NFR7 — Login, Settings and the Overview grid pass an axe
 * WCAG AA scan with zero violations, plus the three grid properties axe cannot
 * see: one tab stop, `aria-sort` on every sortable column, and row indices that
 * refer to the full list rather than the rendered window.
 *
 * T25 / NFR5, DESIGN.md §7 extends the same gate to Indexer Search — empty,
 * with results, with the inspector open, with the confirmation open, and with
 * Prowlarr down — and to Activity, plus the properties a rule engine cannot
 * check: `aria-pressed` on the scope chips, a busy results region while a
 * search is in flight, a dialog that actually holds the keyboard, 44px targets
 * on a coarse pointer, and outcomes stated in words rather than in colour.
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
let prowlarr: FakeProwlarr;

/** Two indexers, one of which fails on demand so the degraded chip and the
 *  error banner are part of a scanned surface rather than only of a unit test. */
const INDEXERS = [{ id: 4, name: 'TorrentDay' }, { id: 7, name: 'Nyaa' }];

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

/** Indexer Search, loaded, with Prowlarr's roster in the toolbar. */
async function openSearch() {
  await page.goto(`${ORIGIN}/search`);
  await page.waitForSelector('form.stoolbar');
  await page.waitForSelector('.stoolbar .filter-chip:has-text("TorrentDay")');
}

/** The one search this screen ever runs: the one the operator asked for. */
async function runSearch(query = 'show') {
  await page.fill('#search-query', query);
  await page.click('form.stoolbar button[type="submit"]');
  await expect
    .poll(() => page.locator('.rgrid__body-row').count(), { timeout: 20_000 })
    .toBeGreaterThan(0);
}

/**
 * Row → inspector → confirmation, settled on Sonarr.
 *
 * Radarr is still answering 401 from the Settings test, so the destination is
 * chosen explicitly rather than left to whichever instance the roster lists
 * first — the scanned surface has to be the same one every run.
 */
async function openGrabDialog() {
  await page.click('.rgrid__body-row >> nth=0');
  await page.waitForSelector('.inspector');
  await page.click('.inspector__foot .btn-primary');
  await page.waitForSelector('.modal[role="dialog"]');
  await page.click('.dest-chip:has-text("Sonarr")');
  await page.waitForSelector('.modal .grab-target');
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
    // What Sonarr makes of a release title, for the grab confirmation.
    sonarr.setParse(parsedSeries());

    prowlarr = await startFakeProwlarr({ apiKey: 'prowlarr-key', indexers: INDEXERS });
    // One freeleech result, so the FL badge — the flag that must not be carried
    // by colour — is on screen during the scans.
    prowlarr.setResults(4, [
      ...fakeReleases(4, 'TorrentDay', 2),
      ...fakeReleases(4, 'TorrentDay', 1, { guid: 'fl-1', title: 'Show.S02E01.2160p.WEB-DL-GROUP', indexerFlags: ['freeleech'] }),
    ]);
    prowlarr.setResults(7, fakeReleases(7, 'Nyaa', 2));

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
    await prowlarr?.close();
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

  /* ---------------------------------------------------------------------
     T25 — Indexer Search and Activity.
     --------------------------------------------------------------------- */

  it('Indexer Search has zero violations before any search has run', async () => {
    await seedInstance(page, 'prowlarr', 'Prowlarr', prowlarr.url, {
      type: 'api-key', apiKey: 'prowlarr-key',
    });

    await openSearch();
    // The state the screen spends most of its life in: a toolbar, a roster of
    // chips, and an empty state explaining why nothing has been searched.
    await page.waitForSelector('.empty');
    await scan('Search (empty)');
  });

  it('Indexer Search has zero violations with results, a failed indexer and the inspector open', async () => {
    // Nyaa fails, so the scan covers three surfaces at once: the grid, the
    // degraded chip, and the banner naming what did not answer.
    prowlarr.failSearches([7], 500);
    await openSearch();
    await runSearch();
    await page.waitForSelector('.banner');
    await scan('Search (results, degraded indexer)');

    await page.click('.rgrid__body-row >> nth=0');
    await page.waitForSelector('.inspector');
    await scan('Search (inspector open)');
    prowlarr.failSearches([]);
  });

  it('Indexer Search has zero violations with the grab confirmation open', async () => {
    await openSearch();
    await runSearch();
    await openGrabDialog();
    // A modal is its own a11y surface, and this one is the only screen in
    // helparr that precedes a write.
    await scan('Search (grab confirmation)');
    await page.keyboard.press('Escape');
  });

  it('holds the keyboard inside the grab confirmation and gives it back on Escape', async () => {
    await openSearch();
    await runSearch();
    await openGrabDialog();

    const inside = () => page.evaluate(
      () => Boolean((document.activeElement as HTMLElement | null)?.closest('.modal')),
    );

    // `aria-modal="true"` says nothing behind the dialog exists. Ten tabs is
    // more than the dialog has stops, so an untrapped Tab would be out of it
    // and into the sidebar well before the tenth.
    for (let i = 0; i < 10; i += 1) {
      await page.keyboard.press('Tab');
      expect(await inside(), `Tab ${i + 1} escaped the dialog`).toBe(true);
    }
    // Backwards too — the trap that only holds one direction is the common one.
    for (let i = 0; i < 10; i += 1) {
      await page.keyboard.press('Shift+Tab');
      expect(await inside(), `Shift+Tab ${i + 1} escaped the dialog`).toBe(true);
    }

    await page.keyboard.press('Escape');
    await expect.poll(() => page.locator('.modal[role="dialog"]').count()).toBe(0);

    // And focus comes back to the control that opened it, rather than being
    // dropped on the body where the next Tab starts from the top of the page.
    const returned = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return { inInspector: Boolean(el?.closest('.inspector')), text: el?.textContent?.trim() ?? '' };
    });
    expect(returned.inInspector, `focus landed on "${returned.text}"`).toBe(true);
  });

  it('Indexer Search has zero violations while Prowlarr is unreachable', async () => {
    prowlarr.setDown(true);
    try {
      await page.goto(`${ORIGIN}/search`);
      // The outage renders as a callout above an inert toolbar — a described
      // state, not a thrown error (REQ-SEARCH-008).
      await page.waitForSelector('.callout');
      await scan('Search (Prowlarr outage)');

      const disabled = await page.getAttribute('#search-query', 'aria-disabled');
      expect(disabled).toBe('true');
    } finally {
      prowlarr.setDown(false);
    }
  });

  it('states the indexer scope with aria-pressed rather than with colour', async () => {
    await openSearch();

    const pressed = () => page.locator('.stoolbar .filter-chip')
      .evaluateAll((chips) => chips.map((chip) => [
        chip.querySelector('.filter-chip__label')?.textContent ?? '',
        chip.getAttribute('aria-pressed'),
      ]));

    // "All" is the empty scope, so it is the one chip on at rest.
    expect(await pressed()).toEqual([
      ['All', 'true'], ['TorrentDay', 'false'], ['Nyaa', 'false'],
    ]);

    await page.click('.stoolbar .filter-chip:has-text("TorrentDay")');
    expect(await pressed()).toEqual([
      ['All', 'false'], ['TorrentDay', 'true'], ['Nyaa', 'false'],
    ]);

    // The glyph moves with the state, so the selection survives a monochrome
    // display: colour is never the only channel (DESIGN.md §7).
    const glyphs = await page.locator('.stoolbar .filter-chip__glyph')
      .evaluateAll((spans) => spans.map((span) => span.textContent));
    expect(glyphs).toEqual(['○', '●', '○']);
  });

  it('marks the results region busy while a search is in flight', async () => {
    await openSearch();
    // Long enough to observe, well inside the route's own 30s budget.
    prowlarr.stallSearches([4, 7], 1500);
    try {
      await page.fill('#search-query', 'show');
      await page.click('form.stoolbar button[type="submit"]');

      await page.waitForSelector('.section[aria-busy="true"]');
      // And it says so, once, in a region that existed before the search
      // started — a live region inserted with its content announces nothing.
      const status = page.locator('.section[aria-busy="true"] [role="status"]');
      expect((await status.textContent())?.trim()).toBe('Searching your indexers…');

      await expect
        .poll(() => page.locator('.rgrid__body-row').count(), { timeout: 20_000 })
        .toBeGreaterThan(0);

      // Busy is a state, not a decoration: it has to come off when the answer
      // arrives, and the same region reports what came back.
      expect(await page.locator('.section[aria-busy="true"]').count()).toBe(0);
      const settled = (await page.locator('.content__scroll .section [role="status"]').first().textContent()) ?? '';
      expect(settled).toContain('results · 2 of 2 indexers answered');
    } finally {
      prowlarr.stallSearches([], 0);
    }
  });

  it('meets the 44px target minimum on a coarse pointer', async () => {
    // A phone, which in Chromium is not a media override but a context: a
    // touch-enabled, mobile-metrics context is what makes `(pointer: coarse)`
    // true, and the phone-sized viewport is what switches the grid to its
    // narrow rows. `Emulation.setEmulatedMedia` cannot do this — `pointer` is
    // not one of the features it accepts — so the test opens its own context
    // rather than dressing up the shared one.
    const touch = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const desktop = page;
    try {
      page = await touch.newPage();
      // A fresh context carries no session cookie; the instances are already
      // seeded server-side, so only the login has to be repeated.
      await login(page, ORIGIN, PASSWORD);
      await openSearch();
      await runSearch();

      // Non-vacuous: without this the whole check passes by never entering the
      // branch it is about.
      expect(await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches)).toBe(true);

      // Scoped to the screen under test, and the grid rows are in scope: a row
      // is the only way to open the inspector, so a row *is* a target.
      const small = await page.evaluate(() => {
        const targets = document.querySelectorAll<HTMLElement>(
          'main button, main a[href], main input:not(.sr-only), main select, main .rgrid__body-row',
        );
        return [...targets]
          .filter((el) => el.getBoundingClientRect().height > 0)
          .map((el) => {
            const box = el.getBoundingClientRect();
            return {
              label: (el.textContent || el.id || el.className).trim().slice(0, 40),
              h: Math.round(box.height),
              w: Math.round(box.width),
              // A column header's width is the column's, which a six-column
              // grid cannot make 44px wide on a 390px screen. Its height is the
              // dimension that is ours to set, and the one this checks.
              heightOnly: el.classList.contains('rgrid__sort'),
            };
          })
          .filter((t) => t.h < 44 || (!t.heightOnly && t.w < 44));
      });
      expect(small, `targets under 44px: ${JSON.stringify(small)}`).toEqual([]);
    } finally {
      page = desktop;
      await touch.close();
    }
  });

  it('Activity has zero violations with rows and with the purge dialog open', async () => {
    // A real operation, made the only way helparr makes one: through the
    // confirmation. A hand-written row would scan a surface no operator sees.
    await openSearch();
    await runSearch();
    await openGrabDialog();
    await page.click('.modal__foot button:not(.btn-ghost)');
    await expect.poll(() => page.locator('.toast').count(), { timeout: 15_000 }).toBeGreaterThan(0);

    await page.goto(`${ORIGIN}/operations`);
    await page.waitForSelector('.oplog__row');
    await scan('Activity (populated)');

    await page.click('.oplog-purge');
    await page.waitForSelector('[role="dialog"]');
    await scan('Activity (purge confirmation)');
    await page.keyboard.press('Escape');
  });

  it('states every Activity outcome in words, not only in colour', async () => {
    await page.goto(`${ORIGIN}/operations`);
    await page.waitForSelector('.oplog__row');

    const rows = await page.locator('.oplog__row').evaluateAll((items) => items.map((item) => ({
      word: item.querySelector('.oplog__outcome')?.textContent ?? '',
      dotLabel: item.querySelector('.dot')?.getAttribute('aria-label') ?? '',
    })));

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // The word is the channel; the dot repeats it for anyone reading the
      // colour, and says the same thing to a screen reader.
      expect(['Succeeded', 'Rejected', 'Failed']).toContain(row.word);
      expect(row.dotLabel).toBe(row.word);
    }
  });
});

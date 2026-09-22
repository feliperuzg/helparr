import { chromium, type Browser, type Request } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startSiteServer, type SiteServer } from './helpers/site';

/**
 * NFR2, NFR3, NFR6 / REQ-SITE-007, REQ-SITE-008 — the three promises the page
 * makes that can only be checked by loading it.
 *
 * **Every request is first-party.** This is the one that turns ADR-7 from an
 * intention into a guarantee. The stylesheet *names* a self-hosted font and the
 * markup *names* no analytics, but neither statement is a fact about what a
 * browser fetches — a `@font-face` left pointing at fonts.gstatic.com reads
 * almost identically to one pointing at `./fonts/`. Recording the request log
 * of a real load is the only way to know, and it is also the check that would
 * catch an embed, a tracker or a CDN'd script the moment one is pasted in.
 *
 * **Readable with JavaScript off.** The page's only script injects a Copy
 * button. NFR2 says the content does not depend on it, which means the test has
 * to load the page with scripting disabled and assert the prose is all there —
 * not merely that the script is small.
 *
 * **No horizontal scroll at 360 px.** A landing page that scrolls sideways on a
 * phone is read by nobody, and 360 is the floor the application's own
 * small-viewport rules are written against.
 *
 * Gated behind HELPARR_A11Y_TEST with the rest of the browser lane.
 */

const FLOOR = 360;

describe('site viewport, scripting and origins', () => {
  let site: SiteServer;
  let browser: Browser;

  beforeAll(async () => {
    site = await startSiteServer();
    browser = await chromium.launch();
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await site?.close();
  });

  it('issues every request to its own origin', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const requested: string[] = [];
    page.on('request', (request: Request) => requested.push(request.url()));

    try {
      await page.goto(`${site.origin}/`, { waitUntil: 'networkidle' });
      // Scroll the whole page so the three lazy screenshots are actually
      // fetched — a request that never happens cannot be proven first-party.
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForLoadState('networkidle');

      const foreign = requested.filter((url) => !url.startsWith(site.origin));
      expect(foreign, 'the page reached a third-party origin').toEqual([]);

      // The guard against a vacuous pass: if nothing was recorded, or only the
      // document was, the assertion above proves nothing. A full load is the
      // document, the stylesheet, the font, the favicon and four screenshots.
      expect(requested.length).toBeGreaterThanOrEqual(7);
      expect(requested.some((url) => url.endsWith('.woff2')), 'the font was never fetched').toBe(true);
      expect(requested.filter((url) => url.includes('/screenshots/')).length).toBe(4);
    } finally {
      await context.close();
    }
  }, 60_000);

  it('collects nothing and offers no demo', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${site.origin}/`, { waitUntil: 'networkidle' });

      // REQ-SITE-008: no form, no email capture, no newsletter, no analytics.
      expect(await page.locator('form, input, textarea, iframe').count()).toBe(0);
      expect(await page.evaluate(() => document.cookie)).toBe('');

      // REQ-SITE-002: nothing on the page implies a running instance exists to
      // visit. The install command's `http://your-host:3000` is a placeholder
      // inside a <code>, not a link, which is why this looks at hrefs only.
      const hrefs = await page.locator('a[href]').evaluateAll((links) =>
        links.map((a) => (a as HTMLAnchorElement).getAttribute('href')!),
      );
      expect(hrefs.filter((href) => /demo|try|app\.|\.helparr\./i.test(href))).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  it('is fully readable with JavaScript disabled', async () => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    try {
      await page.goto(`${site.origin}/`, { waitUntil: 'load' });

      // Every section still renders, and the install command — the single most
      // load-bearing string on the page — is present and selectable.
      for (const id of ['main', 'what', 'screens', 'install', 'limits']) {
        expect(await page.locator(`#${id}`).isVisible(), `#${id} is missing without JS`).toBe(true);
      }
      expect(await page.textContent('#install-cmd')).toContain('ghcr.io/feliperuzg/helparr:latest');
      expect(await page.locator('h1').textContent()).toContain('Self-hosted web companion');

      // And the enhancement is genuinely absent rather than present-but-dead.
      // A Copy button that silently does nothing is worse than no button.
      expect(await page.locator('.copy-btn').count()).toBe(0);
      expect(await page.locator('dialog').count()).toBe(0);
    } finally {
      await context.close();
    }
  }, 60_000);

  it('opens each screenshot at full size without JavaScript', async () => {
    // REQ-SITE-012's first scenario. With scripting off the anchor *is* the
    // feature, so this asserts the navigation itself: that each link points at
    // the same image the thumbnail shows, and that following one actually
    // serves a PNG rather than a 404 the eye would read as "it opened".
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    try {
      await page.goto(`${site.origin}/`, { waitUntil: 'load' });

      const pairs = await page.locator('.shot__zoom').evaluateAll((links) =>
        links.map((link) => ({
          href: (link as HTMLAnchorElement).getAttribute('href'),
          src: link.querySelector('img')?.getAttribute('src') ?? null,
          label: link.getAttribute('aria-label'),
        })),
      );

      expect(pairs.length, 'not every screenshot is a link').toBe(4);
      for (const { href, src, label } of pairs) {
        expect(href).toBe(src);
        expect(label, `${href} opens without saying what it opens`).toBeTruthy();
      }

      const response = await page.goto(`${site.origin}/screenshots/overview.png`);
      expect(response?.status()).toBe(200);
      expect(response?.headers()['content-type']).toContain('image/png');
    } finally {
      await context.close();
    }
  }, 60_000);

  it('enlarges a screenshot in a dialog the keyboard can reach and dismiss', async () => {
    // REQ-SITE-012's other two scenarios. Tabbing to the link rather than
    // calling `focus()` is what makes the ring assertion mean something —
    // `:focus-visible` is exactly the selector that distinguishes the two.
    //
    // Two honest limits. A computed style cannot see that an outline was
    // clipped away by `.shot figure`'s `overflow: hidden`, so what is asserted
    // is the negative offset that keeps it inside the clip, not the pixels.
    // And the focus that comes back after Escape is restored by `showModal`
    // itself, so this passes with the page's own handler removed; it is here to
    // catch a future lightbox that is not a <dialog>, not to prove that handler.
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    try {
      await page.goto(`${site.origin}/`, { waitUntil: 'networkidle' });

      let tabs = 0;
      while (tabs < 40 && !(await page.evaluate(() => !!document.activeElement?.classList.contains('shot__zoom')))) {
        await page.keyboard.press('Tab');
        tabs += 1;
      }

      const focused = await page.evaluate(() => {
        const element = document.activeElement as HTMLAnchorElement | null;
        if (!element) return null;
        const style = getComputedStyle(element);
        return {
          zoom: element.classList.contains('shot__zoom'),
          name: element.getAttribute('aria-label'),
          ring: element.matches(':focus-visible') ? style.outlineWidth : '0px',
          offset: element.matches(':focus-visible') ? style.outlineOffset : '0px',
          href: element.href,
        };
      });

      expect(focused?.zoom, 'no screenshot link is reachable by Tab').toBe(true);
      expect(focused?.name).toMatch(/full size/);
      expect(parseFloat(focused?.ring ?? '0'), 'the focused link shows no ring').toBeGreaterThanOrEqual(2);
      expect(parseFloat(focused?.offset ?? '0'), 'the ring sits outside the clip').toBeLessThan(0);

      await page.keyboard.press('Enter');
      await page.waitForSelector('dialog[open]');
      expect(await page.getAttribute('dialog[open] img', 'src')).toBe(focused?.href);

      await page.keyboard.press('Escape');
      await page.waitForSelector('dialog[open]', { state: 'detached' });

      // Focus back where it started, not at the top of the document — the
      // difference between dismissing a dialog and losing your place.
      expect(await page.evaluate(() => (document.activeElement as HTMLAnchorElement)?.href)).toBe(focused?.href);
    } finally {
      await context.close();
    }
  }, 60_000);

  it(`does not scroll horizontally at ${FLOOR} px`, async () => {
    const context = await browser.newContext({ viewport: { width: FLOOR, height: 800 } });
    const page = await context.newPage();
    try {
      await page.goto(`${site.origin}/`, { waitUntil: 'networkidle' });

      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);

      // Naming the offender, because "the document is 412 px wide" sends the
      // reader hunting through 370 lines of markup for the one element that
      // did not wrap.
      //
      // An element inside a scrolling or clipping box is not an offender: the
      // install command is deliberately wider than 360 px and `.cmd pre` gives
      // it `overflow-x: auto`, because a shell command wrapped at its `\`
      // continuations reads as a different command. What that box contains
      // cannot widen the document, so the walk stops at the first ancestor
      // that clips — anything past it is contained by construction.
      const overflowing = await page.evaluate((floor) => {
        const contained = (element: Element) => {
          for (let node: Element | null = element; node; node = node.parentElement) {
            const { overflowX } = getComputedStyle(node);
            if (overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'hidden') return true;
          }
          return false;
        };
        return Array.from(document.querySelectorAll('*'))
          .filter((element) => element.getBoundingClientRect().right > floor + 1)
          .filter((element) => !contained(element))
          .map((element) => `${element.tagName.toLowerCase()}.${element.className || '(no class)'}`)
          .slice(0, 5);
      }, FLOOR);
      expect(overflowing, 'element(s) wider than the viewport').toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);
});

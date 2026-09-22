import AxeBuilder from '@axe-core/playwright';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startSiteServer, type SiteServer } from './helpers/site';

/**
 * NFR1 / REQ-SITE-007 — the landing page meets the same accessibility floor as
 * the application it advertises.
 *
 * Not a lower one. A page whose whole argument is that helparr surfaces what
 * other tools bury cannot be the part of the project that is unreadable with a
 * screen reader, and "it's just a landing page" is exactly the reasoning that
 * produces one. So this uses the application's own tag set and its own
 * zero-violations bar, from `test/a11y.test.ts`.
 *
 * Three viewports, because the page's layout changes at each and axe's contrast
 * and target-size rules are evaluated against what is actually rendered: a
 * two-column grid that collapses to one column is a different document to scan.
 *
 * The scan runs against the assembled tree over loopback rather than `file://`
 * — see `startSiteServer`.
 *
 * Gated behind HELPARR_A11Y_TEST (set by `npm run test:a11y`) because it needs
 * a downloaded Chromium, the same reason the application's scan is gated.
 */

/** WCAG 2.1 A + AA. Best-practice rules are deliberately not part of the gate. */
const WCAG_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/**
 * 360 is NFR6's floor, 768 is where the two-column bands collapse, and 1280 is
 * the width the screenshots were captured at.
 */
const VIEWPORTS = [
  { name: '360px — the small-viewport floor', width: 360, height: 800 },
  { name: '768px — the single-column breakpoint', width: 768, height: 1024 },
  { name: '1280px — desktop', width: 1280, height: 900 },
];

describe('site accessibility', () => {
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

  async function open(width: number, height: number): Promise<Page> {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    await page.goto(`${site.origin}/`, { waitUntil: 'networkidle' });
    return page;
  }

  it.each(VIEWPORTS)('has no WCAG 2.1 AA violations at $name', async ({ width, height }) => {
    const page = await open(width, height);
    try {
      const { violations } = await new AxeBuilder({ page }).withTags(WCAG_AA).analyze();

      expect(
        violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
      ).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 60_000);

  it('gives the keyboard a way past the navigation', async () => {
    // The skip link is the one control axe cannot judge: it is visually hidden
    // until focused, so a scan sees a link that is there whether or not it
    // works. What matters is that it is the first thing Tab reaches and that it
    // moves focus to the content.
    const page = await open(1280, 900);
    try {
      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => ({
        text: document.activeElement?.textContent?.trim(),
        href: document.activeElement?.getAttribute('href'),
        visible: document.activeElement
          ? getComputedStyle(document.activeElement).clip !== 'rect(0px, 0px, 0px, 0px)'
          : false,
      }));

      expect(focused.href).toBe('#main');
      expect(focused.text).toBe('Skip to content');
      expect(focused.visible, 'the skip link stays hidden when focused').toBe(true);

      await page.keyboard.press('Enter');
      expect(await page.evaluate(() => window.location.hash)).toBe('#main');
    } finally {
      await page.context().close();
    }
  }, 60_000);

  it('states the install command in text a screen reader can reach', async () => {
    // NFR2's other half: the Copy button is an enhancement, so the command
    // itself must be readable and the button, when it exists, must say what it
    // copies rather than relying on an icon or on proximity.
    const page = await open(1280, 900);
    try {
      const command = await page.textContent('#install-cmd');
      expect(command).toContain('ghcr.io/feliperuzg/helparr:latest');

      const label = await page.getAttribute('.copy-btn', 'aria-label');
      expect(label).toBe('Copy the install command');
    } finally {
      await page.context().close();
    }
  }, 60_000);
});

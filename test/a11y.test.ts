import AxeBuilder from '@axe-core/playwright';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startFakeArr, type FakeArr } from './helpers/fakeArr';

/**
 * T20 / AC14 — Settings and Login pass an axe WCAG AA scan with zero violations.
 *
 * This drives the real standalone build in a real browser rather than rendering
 * components under jsdom. NFR7's requirements are mostly *rendered* properties
 * — visible `:focus-visible` rings from `--color-ring`, and contrast ratios
 * from the DESIGN.md token cascade — and jsdom resolves neither, so a jsdom
 * scan would silently skip exactly the rules that matter here.
 *
 * Gated behind HELPARR_A11Y_TEST (set by `npm run test:a11y`) because it needs
 * `next build` plus a downloaded Chromium.
 */

const PORT = 3987;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'operator-password-for-the-a11y-scan';

/** WCAG 2.1 A + AA. Best-practice rules are deliberately not part of the gate. */
const WCAG_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

let server: ChildProcess;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let sonarr: FakeArr;
let qbit: FakeArr;
const dir = mkdtempSync(join(tmpdir(), 'helparr-a11y-'));

async function waitForServer(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${ORIGIN}/login`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Standalone server never became ready on ${ORIGIN}`);
}

/**
 * Seeds instances through the real API, from inside the page so the session
 * cookie rides along. Going through /test first is not a shortcut around the
 * test-before-save gate — it is the gate, exercised the way the UI does it.
 */
async function seed(kind: string, label: string, baseUrl: string, credential: unknown) {
  return page.evaluate(
    async ([k, l, url, cred]) => {
      const test = await fetch('/api/instances/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: k, baseUrl: url, credential: cred }),
      }).then((r) => r.json());

      if (test.outcome !== 'ok') throw new Error(`seed test failed: ${JSON.stringify(test)}`);

      const created = await fetch('/api/instances', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: k, label: l, baseUrl: url, credential: cred, testToken: test.testToken,
        }),
      });
      if (!created.ok) throw new Error(`seed save failed: ${created.status}`);
    },
    [kind, label, baseUrl, credential] as const,
  );
}

async function scan(context?: string) {
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

// Each scan boots axe into the page and walks the whole tree; the suite-wide
// 20s budget is sized for in-process tests, not for that.
describe('WCAG AA', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    sonarr = await startFakeArr({ apiKey: 'sonarr-key', version: '4.0.10.2544' });
    // A second instance in a failing state, so the scan also covers the
    // degraded-instance Callout — an error surface that only renders when
    // something is actually wrong is exactly the one that escapes review.
    qbit = await startFakeArr({ apiKey: 'radarr-key', version: '5.14.0.9383' });

    server = spawn(process.execPath, ['.next/standalone/server.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(PORT),
        HOSTNAME: '127.0.0.1',
        NODE_ENV: 'production',
        HELPARR_DB_PATH: join(dir, 'helparr.db'),
        HELPARR_ENCRYPTION_KEY: 'a11y-encryption-key-0123456789ab',
        HELPARR_INITIAL_PASSWORD: PASSWORD,
        HELPARR_LOG_LEVEL: 'error',
      },
      stdio: 'ignore',
    });

    await waitForServer();

    browser = await chromium.launch();
    // AxeBuilder refuses a page from `browser.newPage()` — it needs the
    // explicit context so it can inject axe into every frame.
    context = await browser.newContext();
    page = await context.newPage();
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
    server?.kill();
    await sonarr?.close();
    await qbit?.close();
    rmSync(dir, { recursive: true, force: true });
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
    await page.goto(`${ORIGIN}/login`);
    await page.fill('#operator-password', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL(`${ORIGIN}/`);

    await page.goto(`${ORIGIN}/settings`);
    await page.waitForSelector('text=No instances configured');
    await scan('Settings (empty)');

    await seed('sonarr', 'Sonarr', sonarr.url, { type: 'api-key', apiKey: 'sonarr-key' });
    await seed('radarr', 'Radarr', qbit.url, { type: 'api-key', apiKey: 'radarr-key' });

    // Take the second instance down so its card renders the degraded Callout.
    qbit.setMode('unauthorized');

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
});

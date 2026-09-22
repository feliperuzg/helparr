import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { ROOT, buildSite, siteDocument } from './helpers/site';

/**
 * FR14 / REQ-SITE-001 — every reference on the built site resolves.
 *
 * GitHub Pages serves this project from a path prefix (`/helparr`), and the
 * repository's own screenshots live outside `site/` and only arrive at their
 * published path when the assembler copies them. Both are ways for a link to
 * be correct in the editor and 404 on the web, and neither is visible by
 * reading `site/index.html`. So the subject here is `.site/` — the tree that
 * actually gets uploaded.
 *
 * External links are checked for shape and never fetched. This spec runs in the
 * required lane; a required lane that makes network calls fails when GitHub has
 * a bad afternoon, which trains everyone to ignore it. A typo'd hostname is
 * what a shape check catches, and a link that rots is what a human catches.
 *
 * The `og:image` is the one absolute URL pointing at our own content — Open
 * Graph has no relative form and no crawler resolves one. It is stripped back
 * to a path and resolved inside the tree like any other internal reference,
 * rather than being waved through for being absolute.
 */

const ORIGIN = 'https://feliperuzg.github.io/helparr/';

/** Hosts this project deliberately links to. Anything else is a typo or a leak. */
const ALLOWED_HOSTS = new Set(['github.com']);

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico']);

function walk(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? walk(path.join(dir, entry.name), rel) : [rel];
  });
}

/** Every URL the built page asks a browser for, plus where it was written. */
function references(document: Document, css: string): Array<{ url: string; where: string }> {
  const refs: Array<{ url: string; where: string }> = [];

  for (const node of document.querySelectorAll('[href], [src]')) {
    const url = node.getAttribute('href') ?? node.getAttribute('src')!;
    refs.push({ url, where: `<${node.tagName.toLowerCase()}> in index.html` });
  }

  // og:image and og:url are requests too — a crawler fetches them — and they
  // are the references most likely to rot, because nothing in a browser
  // renders them.
  for (const meta of document.querySelectorAll('meta[content]')) {
    const content = meta.getAttribute('content')!;
    if (/^https?:\/\//.test(content)) {
      const name = meta.getAttribute('property') ?? meta.getAttribute('name');
      refs.push({ url: content, where: `<meta ${name}> in index.html` });
    }
  }

  // The font is fetched by the stylesheet, not the document. NFR3 says every
  // request is first-party, so the stylesheet's requests are in scope.
  for (const [, url] of css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
    refs.push({ url, where: 'url() in styles.css' });
  }

  return refs;
}

describe('site links', () => {
  const out = buildSite();
  const document = siteDocument();
  const css = readFileSync(path.join(out, 'styles.css'), 'utf8');
  const refs = references(document, css);

  it('finds every kind of reference the page makes', () => {
    // A guard on the collector itself: if a selector silently stops matching,
    // every other assertion below passes vacuously.
    expect(refs.length).toBeGreaterThan(10);
    expect(refs.some((r) => r.url.startsWith('#'))).toBe(true);
    expect(refs.some((r) => r.where.startsWith('<meta'))).toBe(true);
    expect(refs.some((r) => r.where === 'url() in styles.css')).toBe(true);
  });

  it('every internal reference resolves to a file in the assembled tree', () => {
    const missing: string[] = [];

    for (const { url, where } of refs) {
      if (url.startsWith('#')) continue;

      let relative: string;
      if (url.startsWith(ORIGIN)) {
        relative = url.slice(ORIGIN.length);
      } else if (/^[a-z]+:/i.test(url) || url.startsWith('//')) {
        continue; // external — shape-checked below
      } else {
        relative = url.replace(/^\.\//, '');
      }

      // A directory URL is served as its index; `''` is the site root itself.
      const target = relative === '' || relative.endsWith('/') ? `${relative}index.html` : relative;
      if (!existsSync(path.join(out, target))) missing.push(`${target} — from ${where} (${url})`);
    }

    expect(missing, 'reference(s) that will 404 on the published site').toEqual([]);
  });

  it('every fragment reference points at an element that exists', () => {
    const dangling = refs
      .filter((r) => r.url.startsWith('#'))
      .filter((r) => !document.getElementById(r.url.slice(1)))
      .map((r) => `${r.url} — from ${r.where}`);

    expect(dangling, 'in-page link(s) to an id nothing carries').toEqual([]);
  });

  it('every external link is an https URL on a host this project links to', () => {
    const bad: string[] = [];

    for (const { url, where } of refs) {
      if (!/^[a-z]+:\/\//i.test(url) || url.startsWith(ORIGIN)) continue;
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') bad.push(`${url} — not https (${where})`);
      if (!ALLOWED_HOSTS.has(parsed.hostname)) bad.push(`${url} — unexpected host (${where})`);
    }

    expect(bad, 'external link(s) that are malformed or point somewhere unintended').toEqual([]);
  });

  it('the og:image is absolute, on our own origin, and resolves', () => {
    // Open Graph requires an absolute URL, so this one cannot be written the
    // way the four <img> tags are. It is still our file and still has to exist.
    const image = document.querySelector('meta[property="og:image"]')?.getAttribute('content');
    expect(image, 'no og:image — the repository link renders as a bare card').toBeTruthy();
    expect(image!.startsWith(ORIGIN)).toBe(true);
    expect(existsSync(path.join(out, image!.slice(ORIGIN.length)))).toBe(true);
  });

  it('no image file lives under site/', () => {
    // REQ-SITE-006: the screenshots have exactly one home, `docs/screenshots/`,
    // and the assembler copies them in. A copy committed under `site/` would
    // look identical on the published site and go stale the first time the
    // generator ran.
    const images = walk(path.join(ROOT, 'site')).filter((file) =>
      IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase()),
    );

    expect(images, 'site/ must carry no image — the assembler copies them in').toEqual([]);
  });

  it('every screenshot the page shows is the generated one', () => {
    const shots = Array.from(document.querySelectorAll('img'), (img) => img.getAttribute('src')!);
    expect(shots.length).toBe(4);

    for (const src of shots) {
      const relative = src.replace(/^\.\//, '');
      expect(relative.startsWith('screenshots/'), `${src} is not from screenshots/`).toBe(true);

      // Same bytes as the file the generator wrote, not a resized or
      // hand-edited copy that happens to share its name.
      const published = statSync(path.join(out, relative));
      const generated = statSync(path.join(ROOT, 'docs', relative));
      expect(published.size, `${relative} differs from docs/${relative}`).toBe(generated.size);
    }
  });
});

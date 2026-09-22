import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { ROOT, buildSite } from './helpers/site';

/**
 * NFR7 / REQ-SITE-011 — the site's transfer weight, against a committed budget.
 *
 * The page is hand-written HTML with one stylesheet, one font and four
 * screenshots, and it will stay that way only if growth is visible. Weight
 * creep is not a decision anyone makes; it is what happens when each addition
 * is individually reasonable. So the measurement is committed next to the
 * source and a build that goes over it fails until someone raises it on
 * purpose.
 *
 * What is measured is what crosses the wire, not what is on disk: GitHub Pages
 * gzips text and leaves already-compressed formats alone, so PNG and woff2 are
 * counted raw and everything else is counted gzipped. Counting raw bytes for
 * HTML would make a comment cost as much as a screenshot row, which is a budget
 * that punishes the wrong thing.
 *
 * The baseline records a per-file breakdown as well as the total, so a failure
 * can say *what* moved rather than just that something did. The file set is
 * checked exactly — a new asset fails even if it fits under the total — because
 * "we added a file to the published site" is precisely the decision this is
 * here to surface.
 */

/** Formats the server will not gzip, because they already are compressed. */
const PRECOMPRESSED = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.woff', '.woff2']);

interface Baseline {
  total: number;
  tolerance: number;
  files: Record<string, number>;
}

function walk(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? walk(path.join(dir, entry.name), rel) : [rel];
  });
}

/** Bytes this file costs a visitor who has nothing cached. */
function transferSize(file: string, data: Buffer): number {
  return PRECOMPRESSED.has(path.extname(file).toLowerCase())
    ? data.length
    : gzipSync(data, { level: 9 }).length;
}

describe('site weight', () => {
  const out = buildSite();
  const baseline = JSON.parse(readFileSync(path.join(ROOT, 'site/weight-baseline.json'), 'utf8')) as Baseline;

  const measured: Record<string, number> = {};
  for (const file of walk(out).sort()) {
    measured[file] = transferSize(file, readFileSync(path.join(out, file)));
  }
  const total = Object.values(measured).reduce((sum, bytes) => sum + bytes, 0);

  it('publishes exactly the files the baseline accounts for', () => {
    expect(
      Object.keys(measured).sort(),
      'the published file set changed — update site/weight-baseline.json deliberately',
    ).toEqual(Object.keys(baseline.files).sort());
  });

  it(`stays within the committed budget`, () => {
    const budget = baseline.total + baseline.tolerance;

    if (total > budget) {
      // Name what moved. Without this the failure says a number went up and
      // leaves the reader to diff two builds by hand.
      const movers = Object.entries(measured)
        .map(([file, bytes]) => [file, bytes - (baseline.files[file] ?? 0)] as const)
        .filter(([, delta]) => delta !== 0)
        .sort((a, b) => b[1] - a[1])
        .map(([file, delta]) => `    ${delta > 0 ? '+' : ''}${delta} B  ${file}`)
        .join('\n');

      throw new Error(
        `site transfer weight is ${total} B, over the ${baseline.total} B baseline ` +
          `(+${baseline.tolerance} B tolerance).\n\n  What moved:\n${movers}\n\n` +
          '  If the increase is intended, set "total" and "files" in ' +
          'site/weight-baseline.json to the measured values and say why in the commit.',
      );
    }

    expect(total).toBeLessThanOrEqual(budget);
  });

  it('the baseline is not stale by more than the tolerance', () => {
    // A baseline left far above the truth is a budget that has stopped
    // budgeting: weight could double before anything failed. This catches the
    // case where something was removed and the baseline was never lowered.
    expect(
      total,
      `site/weight-baseline.json claims ${baseline.total} B but the site measures ${total} B — ` +
        'lower the baseline to the measurement',
    ).toBeGreaterThanOrEqual(baseline.total - baseline.tolerance);
  });
});

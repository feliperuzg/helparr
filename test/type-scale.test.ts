import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * T2 / AC1, AC8 — FR8; REQ-A11Y-009.
 *
 * helparr declares a nine-step fluid type scale and then overrode it in 137
 * places with absolute literals. A browser does not resize px-declared text
 * when the operator raises their default font size, so every literal here is a
 * hole in REQ-A11Y-009 — and 45 of them were inline `fontSize` props, which a
 * stylesheet linter would never have seen. That is why this scans `.tsx` as
 * well as `.css`.
 *
 * This is the static half. It proves every declaration names a token; it cannot
 * prove the browser's preference reaches the screen, which is what
 * `test/text-resize.test.ts` asserts in a real browser (ADR-5).
 *
 * Absolute units only. `rem` and `em` both track the operator's preference, so
 * they are not what this is guarding against; `px` and `pt` do not.
 */

const SRC = join(process.cwd(), 'src');

/** Every file under `src/` whose name ends in one of `exts`. */
function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, exts, out);
    else if (exts.some((ext) => entry.name.endsWith(ext))) out.push(path);
  }
  return out;
}

interface Offence {
  file: string;
  line: number;
  text: string;
}

/** Blanks out `/* … *\/` comment bodies, preserving newlines so lines still line up. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '));
}

function scan(files: string[], pattern: RegExp, transform = (s: string) => s): Offence[] {
  const found: Offence[] = [];
  for (const file of files) {
    const source = transform(readFileSync(file, 'utf8'));
    source.split('\n').forEach((line, index) => {
      // `pattern` is global, and a global regex carries `lastIndex` between
      // calls — reset it or every second match is skipped.
      pattern.lastIndex = 0;
      if (pattern.test(line)) {
        found.push({ file: relative(process.cwd(), file), line: index + 1, text: line.trim() });
      }
    });
  }
  return found;
}

function report(offences: Offence[]): string {
  return offences.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join('\n');
}

describe('the type scale is the only source of font sizes', () => {
  it('no stylesheet under src/ declares font-size in px or pt', () => {
    const sheets = walk(SRC, ['.css']);
    expect(sheets.length, 'no stylesheets found — the scan would pass vacuously').toBeGreaterThan(0);

    const offences = scan(sheets, /font-size\s*:[^;}]*\b\d*\.?\d+(px|pt)\b/i, stripComments);
    expect(
      offences,
      `${offences.length} absolute font-size declaration(s) — use a --text-* token:\n${report(offences)}`,
    ).toEqual([]);
  });

  it('no component under src/ sets an inline fontSize in px or pt', () => {
    const components = walk(SRC, ['.tsx', '.ts']);
    expect(components.length, 'no components found — the scan would pass vacuously').toBeGreaterThan(0);

    // `fontSize: 12` (React's implicit px), `fontSize: '12px'`, `fontSize: "9pt"`.
    // `fontSize: 'var(--text-xs)'` is the shape this is steering toward, and is
    // not matched.
    const offences = scan(
      components,
      /\bfontSize\s*:\s*['"`]?\s*\d*\.?\d+\s*(px|pt)?\s*['"`]?\s*[,}]/,
    );
    expect(
      offences,
      `${offences.length} inline fontSize literal(s) — use a --text-* token:\n${report(offences)}`,
    ).toEqual([]);
  });

  it('the scale itself defines every token the app references', () => {
    // A token that is used but never declared resolves to nothing and the
    // element silently inherits — which looks like a pass to both scans above.
    const css = stripComments(readFileSync(join(SRC, 'app/globals.css'), 'utf8'));
    const declared = new Set(Array.from(css.matchAll(/^\s*(--text-[\w-]+)\s*:/gm), (m) => m[1]));

    const referenced = new Set<string>();
    for (const file of walk(SRC, ['.css', '.tsx', '.ts'])) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/var\(\s*(--text-[\w-]+)/g)) referenced.add(match[1]);
    }

    expect(referenced.size, 'nothing references the scale').toBeGreaterThan(0);
    const undeclared = [...referenced].filter((token) => !declared.has(token));
    expect(undeclared, `referenced but never declared: ${undeclared.join(', ')}`).toEqual([]);
  });
});

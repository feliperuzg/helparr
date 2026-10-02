import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { NextConfig } from 'next';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version: string };

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('displayed version', () => {
  it('is baked into the build from package.json', async () => {
    const { default: nextConfig } = (await import(join(process.cwd(), 'next.config.mjs'))) as { default: NextConfig };
    expect(nextConfig.env?.HELPARR_VERSION).toBe(pkg.version);
  });

  it('is never hardcoded in a component', () => {
    const literal = new RegExp(`(?<![\\d.])${pkg.version.replaceAll('.', '\\.')}(?![\\d.])`);
    const offenders = sources(join(process.cwd(), 'src')).filter((file) => literal.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

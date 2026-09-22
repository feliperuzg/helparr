import { describe, expect, it } from 'vitest';

import { repoFile, siteDocument } from './helpers/site';

/**
 * FR9 / REQ-SITE-003 — every fact the site restates, checked against the file
 * that owns it.
 *
 * The landing page is a second surface describing a project whose first surface
 * is a 573-line README. Two surfaces drift; that is not a risk, it is what
 * happens. The only version of this feature worth shipping is one where drift
 * fails a build, so every restated claim on the page carries a `data-fact`
 * attribute and appears in the table below next to the file it was copied from.
 *
 * Three properties make the check real rather than decorative:
 *
 * 1. **The source is always another file.** Never a constant declared here, and
 *    never a value the assembler injected — a check that compares a string
 *    against the string it was built from asserts that a variable equals
 *    itself and can never fail (ADR-10, ADR-11).
 * 2. **`textContent`, never `innerHTML`.** The hero sentence is split across
 *    two `<span>`s so its first clause can carry the headline; `innerHTML`
 *    would compare the markup and `textContent` compares what a person reads.
 *    The two spans sit on one source line with no whitespace between them so
 *    that no normalisation is needed here — if someone reformats that line,
 *    this fails, which is correct: it would also change the rendered sentence.
 * 3. **Coverage is asserted both ways.** Every `data-fact` in the document must
 *    appear in the table, so adding a claim to the page without giving it a
 *    source fails rather than passing silently.
 */

/** `ghcr.io/owner/name`, the published image with no tag. */
const IMAGE_REF = /\bghcr\.io\/[a-z0-9-]+\/[a-z0-9-]+\b/;

function installCommand(): string {
  // The README's install block is the canonical one — it is what a person who
  // never sees the site runs. The fence is matched by its content rather than
  // its position so that reordering the README does not break this.
  const block = repoFile('README.md').match(/```bash\n(docker run -d --name helparr[\s\S]*?)\n```/);
  if (!block) throw new Error('no `docker run -d --name helparr` block in README.md');
  return block[1];
}

/**
 * The platforms the publish workflow actually builds, read off its matrix.
 *
 * Not off the README's prose: the prose is a claim about the matrix, and if the
 * two disagree it is the matrix that is telling the truth about what was
 * pushed.
 */
function architectures(): string[] {
  const matrix = Array.from(
    repoFile('.github/workflows/publish.yml').matchAll(/^\s*-\s*platform:\s*(\S+)\s*$/gm),
    (m) => m[1],
  );
  if (matrix.length === 0) throw new Error('no `- platform:` entries in publish.yml');
  return matrix;
}

const pkg = JSON.parse(repoFile('package.json')) as {
  description: string;
  version: string;
  license: string;
};

/**
 * One row per `data-fact`. `source` returns what the repository says; the page
 * must say exactly that.
 */
const FACTS: Array<{ fact: string; source: () => string; owner: string }> = [
  {
    fact: 'description',
    owner: 'package.json "description" — and, through it, the GitHub About field',
    source: () => pkg.description,
  },
  {
    fact: 'install-command',
    owner: 'the ```bash docker run block in README.md',
    source: installCommand,
  },
  {
    fact: 'node-floor',
    owner: 'the bare-metal requirements list in README.md',
    source: () => {
      const floor = repoFile('README.md').match(/\*\*(Node\.js [\d.]+\+)\*\*/);
      if (!floor) throw new Error('no **Node.js <version>+** in README.md');
      return floor[1];
    },
  },
  {
    fact: 'image-ref',
    owner: 'the image argument of the README install command',
    source: () => {
      const ref = installCommand().match(IMAGE_REF);
      if (!ref) throw new Error('the README install command names no ghcr.io image');
      return ref[0];
    },
  },
  {
    fact: 'version',
    owner: 'package.json "version"',
    source: () => `v${pkg.version}`,
  },
  {
    fact: 'architectures',
    owner: "the build matrix in .github/workflows/publish.yml",
    // The separator is the site's own typography, not a claim — what is being
    // checked is the set of platforms and the order they are listed in.
    source: () => architectures().join(' · '),
  },
  {
    fact: 'licence',
    owner: 'package.json "license", cross-checked against the LICENSE header',
    source: () => pkg.license,
  },
];

describe('site facts', () => {
  const document = siteDocument();

  it.each(FACTS)('$fact matches $owner', ({ fact, source }) => {
    const nodes = Array.from(document.querySelectorAll(`[data-fact="${fact}"]`));
    expect(nodes.length, `no [data-fact="${fact}"] on the page`).toBeGreaterThan(0);

    const expected = source();
    for (const node of nodes) {
      expect(node.textContent, `[data-fact="${fact}"] disagrees with the repository`).toBe(expected);
    }
  });

  it('LICENSE agrees with the licence the page and package.json claim', () => {
    expect(repoFile('LICENSE').split('\n')[0]).toBe(`${pkg.license} License`);
  });

  it('every data-fact on the page has a source in this table', () => {
    const onPage = new Set(
      Array.from(document.querySelectorAll('[data-fact]'), (n) => n.getAttribute('data-fact')!),
    );
    const covered = new Set(FACTS.map((f) => f.fact));
    const orphans = [...onPage].filter((fact) => !covered.has(fact));

    expect(
      orphans,
      'a claim was added to the page with nothing in the repository to check it against',
    ).toEqual([]);
  });

  it('the hero sentence is the description verbatim, not a paraphrase of it', () => {
    // Belt and braces over the table row: REQ-SITE-005 is about the *opening
    // sentence* specifically, so assert that is where the description lives
    // rather than accepting it anywhere on the page.
    const h1 = document.querySelector('h1');
    expect(h1?.getAttribute('data-fact')).toBe('description');
    expect(h1?.textContent).toBe(pkg.description);
  });
});

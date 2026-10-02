# Changelog

Notable changes per release. Versions follow [semantic versioning](https://semver.org/),
and a `0.x` means the public surface can still move between minors.

## [Unreleased]

Queue-triage ergonomics: more room to read the evidence, and selection that
works on more than one row at a time.

### Added

- **Expandable inspector** — `e` or the header control widens the open
  inspector to 560 px beside the list, never over it; the list keeps at least
  360 px. The width is remembered per browser. Esc collapses an expanded panel
  before it closes it, and the panel follows the cursor as `j`/`k` move, at
  either width.
- **Range selection** — shift+click, Shift+J/K (or Shift+↓/↑) and Shift+Space
  select from the anchor to the target on Overview, Gaps, Rename (the picker
  and the plan grid) and Force import. The range covers the rows on screen
  only, every row in it takes the anchor's state, and group headings are never
  counted. Each gesture is announced to screen readers with the new total.
- **Bulk include on Force import** — "Include all", "Exclude all" and "Include
  all replacements (N)" act on every candidate in one request, all or nothing.
  Candidates with no target are skipped by name ("Included 1 · skipped 1 — no
  target") rather than silently, and a failed request leaves every row as it
  was.

### Fixed

- The keyboard-shortcuts dialog body can be scrolled from the keyboard when it
  is taller than the viewport.

## [0.2.1] — 2026-10-02

### Fixed

- The sidebar, login screen and Settings showed `0.1.0` in v0.2.0: the version
  was written into each component by hand. It is now read from `package.json`
  at build time, and a test fails if a hardcoded copy comes back.

### Known issues

- A 401 bounce ignores `HELPARR_BASE_PATH`, so a session that expires under a
  sub-path redirects to the wrong URL.
- The rename screen reports "0 files already correct" for a title that simply
  has nothing pending.

## [0.2.0] — 2026-10-02

Stuck-item triage: helparr now says *why* a queue item is stuck, shows the
evidence, and offers the one remedy that fits.

### Added

- **Queue causes** — every queue row carries exactly one cause from a closed
  taxonomy (stalled, payload missing, import rejected, import not performed,
  importing, healthy, unknown), with the evidence it rests on and whether that
  evidence was reported by the instance or inferred by helparr.
- **Force import** — a completed download whose import did not happen can be
  imported through a plan: every candidate file with the item it resolved to
  and its verbatim rejections, replacements of existing files excluded by
  default, and nothing sent until the exact file count is typed. A candidate set
  that changed since the preview is refused whole. Each file's outcome is read
  back from history, so a partial import is reported as partial and logged that
  way. Works for Sonarr and Radarr.
- **Decision explainer** — for a release rejected against an existing file or a
  score threshold, both qualities, total scores, per-format matches (each score
  naming whether it came from the release name or the filename), and the
  profile's cutoff and minimum, beside the verbatim reason. Reachable from
  search, from a rejected queue row, and from gaps via **Evaluate releases**.
- **Unmapped folders** — a new screen (key `7`) listing folders under each root
  folder that no instance monitors, with a search link for each. A root folder
  the instance did not report on is shown as unknown, never as empty.
- **Landing page** — a static site at `feliperuzg.github.io/helparr`, whose
  every factual claim is checked by a test.

### Changed

- The error and idle status colours are lighter, to keep the new screens above
  WCAG 2.1 AA contrast.

### Notes

- Radarr's force-import payload is modelled on Sonarr's (with `movieId`) and is
  tested against a simulated instance, not yet against a real Radarr import.
  If the first one fails, the failure is shown per file and recorded in the
  operation log.

### Known issues

- A 401 bounce ignores `HELPARR_BASE_PATH`, so a session that expires under a
  sub-path redirects to the wrong URL.
- The rename screen reports "0 files already correct" for a title that simply
  has nothing pending.

## [0.1.0] — 2026-09-20

First tagged release, and the first image published to
`ghcr.io/feliperuzg/helparr`. Everything below was specified and reviewed before
it was built; the test suites are the executable half of that specification.

### Added

- **Operator authentication** — a single password, argon2id-hashed, with an
  encrypted session cookie and a rotation path that does not require touching
  the database.
- **Instance connections** — Sonarr, Radarr, Prowlarr and a download client,
  with credentials encrypted at rest under `HELPARR_ENCRYPTION_KEY`.
- **Connection testing and health** — per-instance probes, degradation
  reporting, and a circuit breaker that stops hammering an instance that is
  already failing.
- **Unified queue** — every instance's activity in one view, including stalled
  items and what each one is actually waiting on.
- **Arbitrary indexer search and manual grab** — query Prowlarr across
  indexers with the filters the *arr UIs omit, and send a release to a chosen
  target. Searches can be saved and replayed.
- **Library gaps with manual attach** — every monitored series or movie with no
  file, and attachment of a specific torrent or magnet to a specific episode,
  with the resolved count disclosed before anything is issued.
- **Bulk rename** — the full diff of what would change, reviewed and confirmed
  before a single write.
- **Packaging** — a multi-arch container image (`linux/amd64`, `linux/arm64`)
  built from a `v*` tag and only after the full suite is green, a liveness
  contract the image asserts about itself, and a startup contract that fails
  loudly on a misconfiguration rather than quietly at the first request.
- **Accessibility** — a WCAG 2.1 AA floor, a keyboard layer over the operations
  that matter, reduced-motion and text-resize handling, all under test.

### Known issues

- A 401 bounce ignores `HELPARR_BASE_PATH`, so a session that expires under a
  sub-path redirects to the wrong URL.
- The rename screen reports "0 files already correct" for a title that simply
  has nothing pending.

Neither is a data-loss path.

[0.2.1]: https://github.com/feliperuzg/helparr/releases/tag/v0.2.1
[0.2.0]: https://github.com/feliperuzg/helparr/releases/tag/v0.2.0
[0.1.0]: https://github.com/feliperuzg/helparr/releases/tag/v0.1.0

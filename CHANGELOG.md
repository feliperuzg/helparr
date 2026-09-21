# Changelog

Notable changes per release. Versions follow [semantic versioning](https://semver.org/),
and a `0.x` means the public surface can still move between minors.

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

[0.1.0]: https://github.com/feliperuzg/helparr/releases/tag/v0.1.0

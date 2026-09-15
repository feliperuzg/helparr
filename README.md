<p align="center">
  <img src="public/icon.png" alt="" width="128" height="128">
</p>

<h1 align="center">helparr</h1>

<p align="center">
  A self-hosted control surface for the operations your *arr stack makes slow — or impossible — from its own UIs.
</p>

<p align="center">
  <img alt="status: early development" src="https://img.shields.io/badge/status-early%20development-FBBF24">
  <a href="LICENSE"><img alt="license: MIT" src="https://img.shields.io/badge/license-MIT-22C55E"></a>
  <img alt="Next.js 16" src="https://img.shields.io/badge/Next.js-16-0F172A">
</p>

---

## What this is

Sonarr and Radarr automate acquisition well in the common case and leave you
stranded in the tail: a release the built-in indexer search won't surface, a
season with three episodes that never matched, a directory that was imported
before you changed the naming scheme. Today those are resolved by hopping
between four web UIs, a torrent client, and occasionally the filesystem.

**helparr collapses that into one screen.** It talks to your already-configured
Sonarr, Radarr, Prowlarr and download client over their own APIs, and gives you
the operations those tools bury or omit:

- **Arbitrary indexer search** — query Prowlarr directly, across indexers, with
  the filters you actually want, and grab a release to a chosen target.
- **Library gaps** — every monitored series/movie with no file, in one list,
  with manual attach of a specific torrent or magnet to a specific episode.
- **Bulk rename & re-organize** — a full diff of what would change, reviewed and
  confirmed before a single write is issued.
- **Unified queue & health** — one view of what every instance is doing, and
  which ones are degraded.

helparr is a **companion, not a replacement.** It never owns library state and
never touches the filesystem. Every write goes through the *arr APIs, so
Sonarr/Radarr remain the source of truth for what exists and where it lives.

### Who it's for

Self-hosters and homelab operators who already run a fully configured *arr
stack, on a trusted LAN, for a single operator or a household. It assumes you're
comfortable with API keys, indexer semantics, and release-group naming.

---

## Scope

### In scope

| | |
|---|---|
| **Instance management** | Sonarr, Radarr, Prowlarr and a download client, added by URL + API key, stored encrypted, with a live connection test. |
| **Read-through** | Every library read hits the live *arr instance. helparr keeps no mirror. |
| **Write-through** | Grabs, attaches and renames are issued to the *arr APIs, never to disk. |
| **Local persistence** | Only helparr's own state: connections, saved searches, and an audit trail of writes it performed. |
| **Per-instance degradation** | Prowlarr being down must not break the Gaps or Rename screens. |
| **Two hosting targets** | A container image and a bare-metal Node process behind a reverse proxy, from one build. |

### Out of scope

- **Multi-tenancy or public exposure.** One operator, one trusted network. There
  is no user model, no roles, no sharing.
- **Replacing Sonarr/Radarr.** No scheduling, no quality profiles, no import
  logic, no library database of its own.
- **Direct filesystem access.** helparr does not move, rename, or delete files.
  It asks the *arr instance to.
- **Shipping indexers, trackers, content, or sources.** helparr orchestrates the
  indexers and download client *you* have already configured. It bundles none of
  them and provides no means of discovering them.
- **Cloud/serverless hosting.** It's built to run on a NAS or a mini-PC with a
  small idle footprint, next to the stack it manages.

---

## Status

Early development. The first vertical slice is in:

| Area | State |
|---|---|
| Operator auth (single password, encrypted session) | ✅ implemented |
| Instance connections + encrypted credential storage | ✅ implemented |
| Connection testing & per-instance health/degradation | ✅ implemented |
| Unified queue & instance overview | 📋 specified |
| Arbitrary indexer search & manual grab | 📋 specified |
| Library gaps & manual release attach | 📋 specified |
| Bulk rename with preview-then-apply | 📋 specified |
| Packaging (Docker image), saved searches, hardening | 📋 specified |

The three implemented rows shipped as one change, verified end to end against a
real Sonarr instance — 19 requirements across the `auth` and `instances`
capabilities.

Everything still specified has a proposal (requirements), a plan (technical
design), and delta specs that merge into the canonical set when it ships.

Because packaging hasn't landed yet, **there is no published image or release
artifact.** The deployment instructions below build from source.

---

## Requirements

- **Node.js 20.9+** and npm (the floor is Next 16's)
- A running *arr instance to point it at (Sonarr, Radarr, and/or Prowlarr) plus
  its API key
- Native modules are compiled on install (`better-sqlite3-multiple-ciphers`,
  `argon2`), so a toolchain is needed: build-essential/Xcode CLI tools + Python

---

## Configuration

helparr is configured entirely through environment variables. Two of them are
required.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `HELPARR_ENCRYPTION_KEY` | **yes** | — | Encrypts the SQLite database at rest, including every stored API key. Minimum 16 characters. helparr refuses to start without it rather than silently writing credentials in the clear. |
| `HELPARR_INITIAL_PASSWORD` | first run | — | Bootstraps the operator password. Read once, hashed with argon2id, then ignored — it is not a standing source of truth. |
| `HELPARR_DB_PATH` | no | `./data/helparr.db` | Where the encrypted database lives. Point this at your mounted volume. |
| `HELPARR_BASE_PATH` | no | *(none)* | Serve under a sub-path (e.g. `/helparr`) behind a reverse proxy. Baked at build time, not runtime. |
| `HELPARR_LOG_LEVEL` | no | `info` | `debug`, `info`, `warn`, or `error`. Secrets are redacted at every level. |

> **Losing `HELPARR_ENCRYPTION_KEY` means losing the database.** There is no
> recovery path — the stored *arr credentials become unreadable and you will
> need to re-add every instance. Back it up wherever you keep your other
> secrets, and never commit it.

Generate one with:

```bash
openssl rand -base64 32
```

---

## Install (development)

```bash
git clone https://github.com/feliperuzg/helparr.git
cd helparr
npm install

cat > .env.local <<'EOF'
HELPARR_ENCRYPTION_KEY=replace-me-with-openssl-rand-base64-32
HELPARR_INITIAL_PASSWORD=replace-me
EOF

npm run dev
```

Open <http://localhost:3000>, sign in with `HELPARR_INITIAL_PASSWORD`, and add
your first instance under **Settings**.

`.env.local` is gitignored. Keep it that way.

---

## Deploy

Both targets come from the same `output: 'standalone'` build — there is no
separate server bundle to maintain.

### Bare metal / systemd

```bash
npm ci
npm run build:standalone          # next build + copies .next/static into the bundle

# Ship these three to the host:
#   .next/standalone/   (the self-contained server)
#   .next/static/       (already copied in by the script above)
#   public/
```

Then run it as a service:

```ini
# /etc/systemd/system/helparr.service
[Service]
WorkingDirectory=/opt/helparr
ExecStart=/usr/bin/node server.js
Environment=PORT=3000
Environment=HELPARR_DB_PATH=/var/lib/helparr/helparr.db
EnvironmentFile=/etc/helparr/secrets.env   # HELPARR_ENCRYPTION_KEY lives here, mode 0600
Restart=on-failure
User=helparr

[Install]
WantedBy=multi-user.target
```

### Docker

An official image and `Dockerfile` are part of the not-yet-implemented
packaging-and-hardening
change. Until it lands, build the standalone bundle above and run it in whatever
Node base image you already trust, with:

- the database path on a **mounted volume** (`HELPARR_DB_PATH`),
- `HELPARR_ENCRYPTION_KEY` supplied as a **secret**, not baked into the image,
- the container on the same network as your *arr stack.

### Behind a reverse proxy

helparr expects to sit on a trusted LAN. If you put it behind nginx/Caddy/Traefik
anyway, set `HELPARR_BASE_PATH` at **build** time to match the proxy's mount
point — a mismatch is reported loudly at startup rather than silently 404-ing
assets.

Exposing helparr to the public internet is explicitly outside its threat model.
It holds the API keys to your entire stack behind a single password.

---

## Architecture in five lines

- **Next.js App Router as a BFF.** Route handlers proxy every *arr call
  server-side, so API keys never reach the browser and CORS never comes up.
- **Encrypted SQLite**, opened lazily so a build never needs the key.
- **One circuit breaker per instance**, so a dead Prowlarr degrades its own card
  instead of the app.
- **Preview-then-apply** is a hard requirement for every destructive operation.
- **A three-layer CSS token contract** (primitive → semantic → derived) defined
  in the design contract; no hardcoded colors in
  components.

---

## Contributing

Contributions are welcome. helparr is built in the open under the
[MIT license](LICENSE) — by submitting a pull request you agree your
contribution ships under the same terms.

### Getting set up

```bash
npm install
npm test           # unit + integration (vitest)
npm run typecheck  # tsc --noEmit
npm run lint       # eslint (flat config)
```

Two heavier lanes are gated behind env vars so a forgotten build fails loudly
rather than silently skipping:

```bash
npm run test:bundle   # asserts no API keys / native modules leak into .next/static
npm run test:a11y     # drives the real standalone build in Chromium, axe WCAG 2.1 AA
```

`npm run test:a11y` needs a Chromium download once: `npx playwright install chromium`.

### Ground rules

These are non-negotiable, and a PR that breaks one won't be merged:

- **No API key may ever reach the client bundle.** `npm run test:bundle` enforces
  this; server-only modules must import `server-only`.
- **No direct filesystem mutation.** Renames and moves go through the *arr APIs
  so those tools stay consistent with reality.
- **Every destructive operation needs a confirmed preview** showing the complete
  diff before the first write.
- **New UI meets WCAG 2.1 AA** and uses CSS variables from the token contract —
  never a hardcoded hex.
- **A degraded instance degrades alone.** Nothing may take the whole app down.

### Submitting

Branch from `main`, keep the commit history readable, and make sure
`npm test`, `npm run typecheck`, and `npm run lint` are all green. If the change
touches UI, run `npm run test:a11y` too. Describe *what problem it solves* in the
PR — link the relevant proposal if there is one.

---

## License

[MIT](LICENSE) © 2026 Felipe Ruz.

## Legal & scope

helparr orchestrates indexers and a download client that **you** have already
configured. It ships no indexers, no trackers, no content, and no bundled
sources, and it provides no means of discovering any. What you point it at, and
whether that's lawful where you live, is entirely your responsibility.

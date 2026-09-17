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
| `HELPARR_ENCRYPTION_KEY_FILE` | — | — | The same key, read from a file instead — the shape Docker secrets and systemd `LoadCredential` produce. Set exactly one of the two; both at once is refused rather than resolved by precedence. One trailing newline is stripped. |
| `HELPARR_INITIAL_PASSWORD` | first run | — | Bootstraps the operator password. Read once, hashed with argon2id, then ignored — it is not a standing source of truth. Minimum 8 characters. |
| `HELPARR_DB_PATH` | no | `./data/helparr.db` | Where the encrypted database lives. Point this at your mounted volume — the *directory*, so the `-wal` and `-shm` sidecars stay beside the file. |
| `HELPARR_BASE_PATH` | no | *(none)* | Serve under a sub-path (e.g. `/helparr`) behind a reverse proxy. Baked at build time, not runtime. |
| `HELPARR_LOG_LEVEL` | no | `info` | `debug`, `info`, `warn`, or `error`. Secrets are redacted at every level. |
| `HELPARR_QUEUE_REFRESH_SECONDS` | no | `30` | How often the queue screen re-reads your instances. Minimum 5 — a lower value is refused, not silently replaced. |
| `PORT` | no | `3000` | The port to listen on. Unprefixed because it is the server's, not helparr's, and every process manager already knows the name. |
| `HOSTNAME` | no | `127.0.0.1` | The address to listen on. **Loopback by default** — bare metal is assumed to be behind something. Set `0.0.0.0` to accept connections from other machines. The image sets it to `0.0.0.0` already, since a container reached by a published port has nothing else to bind. |

Two notes on `HOSTNAME`, because it is the one variable here helparr did not
invent. Some environments export it with the machine's own name — Docker sets
it to the container id — and helparr treats *any* value you set as deliberate,
so if yours does, set it explicitly. And if nothing set it, the process says
which address it bound on its first line of output rather than leaving you to
find out by failing to connect.

Every one of these is read and validated **once, at startup**. A value helparr
cannot use stops the process with a message naming the variable, what was
expected, and what was actually there — all of them at once, so a misconfigured
deployment takes one restart to fix rather than one per mistake.

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
separate server bundle to maintain. One command produces both:

```bash
npm run package     # the standalone bundle on this host, and the helparr:local image
```

It is a wrapper, not a third build: `npm run build:standalone` on its own gives
you the bare-metal artifact, and `npm run build:image` on its own gives you the
container.

### Bare metal / systemd

```bash
npm ci
npm run build:standalone   # next build + merges .next/static and public/ into the bundle

# Ship one directory to the host:
#   .next/standalone/   (the self-contained server, static assets already inside)
```

Then run it as a service:

```ini
# /etc/systemd/system/helparr.service
[Service]
WorkingDirectory=/opt/helparr
ExecStart=/usr/bin/node start.mjs
Environment=PORT=3000
Environment=HELPARR_DB_PATH=/var/lib/helparr/helparr.db
EnvironmentFile=/etc/helparr/secrets.env   # HELPARR_ENCRYPTION_KEY lives here, mode 0600
Restart=on-failure
User=helparr

[Install]
WantedBy=multi-user.target
```

`start.mjs`, not `server.js`: it is the same launcher the image runs, and its
only job is the listen address. **With no `HOSTNAME` set this binds `127.0.0.1`
and nothing else** — a bare-metal install is assumed to be reached through a
proxy on the same host, and the alternative default would publish an app holding
your whole stack's API keys on every interface the machine has. Add
`Environment=HOSTNAME=0.0.0.0` when you actually want that.

The user in `User=` needs to own the *directory* `HELPARR_DB_PATH` sits in, not
just the file: SQLite writes `helparr.db-wal` and `helparr.db-shm` beside it.

```bash
install -d -o helparr -g helparr -m 0750 /var/lib/helparr
```

### Docker

```bash
npm run build:image                       # → helparr:local

docker run -d --name helparr \
  -p 3000:3000 \
  -v helparr-data:/data \
  -e HELPARR_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  -e HELPARR_INITIAL_PASSWORD='replace-me' \
  helparr:local
```

[`docker-compose.yml`](docker-compose.yml) is a worked example for dropping
helparr beside an existing *arr stack. It contains no secrets and is not meant
to: the two required values come from a `.env` file beside it, and compose
refuses to start without them rather than falling back to a default.

A **named volume** is the path of least resistance, and the one above: Docker
seeds it from the image, where `/data` is already owned by the `helparr` user.
A **bind mount** is not seeded, so the host directory arrives owned by whoever
made it and the container — running unprivileged, on purpose — cannot write to
it. Give it the right owner first:

```bash
sudo install -d -o 1001 -g 1001 -m 0750 /srv/helparr
docker run -d --name helparr -p 3000:3000 -v /srv/helparr:/data … helparr:local
```

`1001` is the uid the image creates and runs as. `HELPARR_DB_PATH` defaults to
`/data/helparr.db` inside the image, so the database and its `-wal`/`-shm`
sidecars stay on one mount — splitting them across a mount boundary corrupts
the write-ahead log.

The image is a multi-stage build on `node:22-slim`. It runs as a non-root user,
declares `/data` as a volume, ships no application source and no second
`node_modules` tree, and its `HEALTHCHECK` calls an unauthenticated liveness
route — so a Sonarr outage never restarts helparr, and no session cookie has to
be baked into an image layer.

Every one of those claims is checked, against a real container, by:

```bash
npm run verify:image
```

It builds nothing and touches nothing of yours — a throwaway container and
volume, removed on exit.

### Behind a reverse proxy

At the root of a hostname there is nothing to configure — proxy to the port and
you are done. Two forwarded headers are honoured if your proxy sets them, and
neither is required:

| Header | What it changes | If it is absent |
|---|---|---|
| `X-Forwarded-Proto` | Whether the session cookie is marked `Secure`. | Falls back to the scheme of the request as the app saw it — which behind a TLS-terminating proxy is `http`, so the cookie is not marked `Secure`. Set this if the browser is speaking HTTPS. |
| `X-Forwarded-For` | Who the login rate limiter counts against. | Every request arrives from the proxy's address, so *all* login attempts share one bucket and one attacker can lock out the household. |

Both are trusted as given. helparr has no notion of which proxies are yours, so
a client that can reach it directly can set `X-Forwarded-For` itself and sidestep
the rate limit — one more reason the port belongs on a trusted network rather
than published beside the proxy.

Under a **sub-path** there is one more thing, and it is not a runtime setting. `HELPARR_BASE_PATH` is compiled into every asset URL by `next build`,
so changing it means rebuilding:

```bash
# bare metal
HELPARR_BASE_PATH=/helparr npm run build:standalone

# container
docker build --build-arg HELPARR_BASE_PATH=/helparr -t helparr:helparr-subpath .
```

Then serve it at the matching location, without stripping the prefix:

```nginx
location /helparr/ {
    proxy_pass http://127.0.0.1:3000;   # note: no trailing /helparr
}
```

Set the variable at runtime to something the build does not match and helparr
**refuses to start**, naming both values. That is deliberate: the alternative is
an app that loads, renders unstyled, and 404s every script — a failure that
looks like a broken install rather than a one-line misconfiguration.

### The trust boundary, plainly

helparr assumes it is on a network you trust, and it is worth being exact about
what that means:

- **It speaks plain HTTP.** There is no TLS in the process and no certificate
  configuration, because terminating TLS is the reverse proxy's job and doing it
  in two places is how one of them ends up misconfigured. If the traffic leaves
  your host, put a proxy in front of it — and have it set `X-Forwarded-Proto`,
  or the session cookie will not be marked `Secure`.
- **One password guards everything.** There are no user accounts, no roles, and
  no second factor. Whoever has it can read and use every *arr API key helparr
  holds.
- **The API keys are encrypted at rest, not in use.** `HELPARR_ENCRYPTION_KEY`
  protects the database file — someone who can read the process' memory or its
  environment already has the keys.
- **It trusts your instances.** Sonarr, Radarr and Prowlarr are treated as
  honest; their responses are parsed, not defended against.

Exposing helparr directly to the public internet is outside its threat model. On
a LAN, or behind a VPN, or behind an authenticating proxy — that is what it was
built for.

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

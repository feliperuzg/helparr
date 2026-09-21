<p align="center">
  <img src="public/icon.png" alt="" width="128" height="128">
</p>

<h1 align="center">helparr</h1>

<p align="center">
  A self-hosted control surface for the operations your *arr stack makes slow — or impossible — from its own UIs.
</p>

<p align="center">
  <img alt="status: internal testing" src="https://img.shields.io/badge/status-internal%20testing-FBBF24">
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

**Internal testing**, ahead of a first release. Everything helparr set out to do
is built:

| Area | State |
|---|---|
| Operator auth (single password, encrypted session) | ✅ shipped |
| Instance connections + encrypted credential storage | ✅ shipped |
| Connection testing & per-instance health/degradation | ✅ shipped |
| Unified queue & instance overview | ✅ shipped |
| Arbitrary indexer search & manual grab | ✅ shipped |
| Library gaps & manual release attach | ✅ shipped |
| Bulk rename with preview-then-apply | ✅ shipped |
| Packaging, saved searches, keyboard layer, WCAG AA floor | ✅ shipped |

Every row above shipped as a specified change — requirements and acceptance
criteria written down before the code, then the gates. The specification
documents themselves are kept outside this repository; the test suites are
their executable half, and they are all here.

What has *not* happened is a release. There is no tag, no image on any registry,
and no install path that doesn't start with `git clone` — the deployment
instructions below build from source, and will until this phase ends.

### What this phase is for

Shipped means the acceptance criteria hold and the gates are green. It does not
mean the code has met a library it didn't expect. The suites run against
fixtures and a single real stack; the tail is what internal testing is for — an
indexer that answers slowly, a season pack named by a group nobody scripted for,
a rename preview spanning four thousand files, a NAS whose clock is wrong.

Before you point it at anything, two things are worth being blunt about.

**helparr issues real writes.** A grab is a grab. An attach asks Sonarr to
import. A rename moves files on disk through the *arr APIs. None of it is
reversible by helparr, and the *arr APIs offer no rollback either. Every
destructive path sits behind a preview you have to confirm, and that preview is
the entire safety net — so read the diff, and point this at a stack you could
afford to repair.

**Back up `HELPARR_ENCRYPTION_KEY` before the first run**, not after. Losing it
loses the database, and this phase is exactly when you are most likely to throw
away a container and recreate it.

Each integration helparr was least sure of also has a script that settles the
question against *your* stack rather than a fixture. None of them changes
anything in Sonarr, Radarr, Prowlarr or the download client:

| Script | What it settles |
|---|---|
| `npm run verify:image` | Every claim the Docker section below makes, against a real container — throwaway, removed on exit |
| `npm run verify:downloadid` | That queue rows and download-client torrents join on the id helparr thinks they do |
| `npm run spike:grab` | What your Prowlarr and *arr actually return for a manual grab, without issuing one |
| `npm run spike:gaps` | What an attach would resolve to, before one is attached |
| `npm run spike:rename` | Your real rename preview, without posting a command |

The one script that writes — `scripts/verify-rename-scope.mjs`, which renames a
single real file irreversibly to re-check an *arr behaviour — is deliberately
not wired to an `npm run` name. Read its header before you ever run it.

### Known and open

- A 401 bounce ignores `HELPARR_BASE_PATH`, so a session that expires under a
  sub-path redirects to the wrong URL.
- The rename screen reports "0 files already correct" for a title that simply
  has nothing pending.

Neither is a data-loss path, and both are the kind of thing only running it
against a real library finds — which is the argument for this phase.

### What a first release still needs

- the two bugs above, plus whatever this phase turns up
- a tag and a changelog. `package.json` reads `0.1.0` and nothing has been
  released under it yet; until a `v*` tag exists, no image has been published
  at all, because publishing is triggered by the tag and nothing else.

---

## Requirements

- **Node.js 20.9+** and npm (the floor is Next 16's)
- A running *arr instance to point it at (Sonarr, Radarr, and/or Prowlarr) plus
  its API key
- Native modules are compiled on install (`better-sqlite3-multiple-ciphers`,
  `argon2`), so a toolchain is needed: build-essential/Xcode CLI tools + Python

None of that applies to the container: the published image already contains the
compiled modules for its architecture, so a Docker host needs no Node, no
compiler and no Python. See [Docker](#docker).

---

## Configuration

helparr is configured entirely through environment variables. Two of them are
required.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `HELPARR_ENCRYPTION_KEY` | **yes** | — | Encrypts the SQLite database at rest, including every stored API key. Minimum 16 characters. helparr refuses to start without it rather than silently writing credentials in the clear. |
| `HELPARR_ENCRYPTION_KEY_FILE` | — | — | The same key, read from a file instead — the shape Docker secrets and systemd `LoadCredential` produce. Set exactly one of the two; both at once is refused rather than resolved by precedence. One trailing newline is stripped. |
| `HELPARR_INITIAL_PASSWORD` | first run | — | The *setup* password: how you get in the first time, not how you stay in. Read once, hashed with argon2id, then inert — a restart with it still set does not overwrite a password you changed later. Change it under **Settings → Operator password** and the value here stops mattering. Minimum 8 characters. |
| `HELPARR_PASSWORD_RESET` | no | `false` | Recovery for a forgotten password. On the next start, **and only once per time you set it**, the stored password is overwritten with `HELPARR_INITIAL_PASSWORD`. Accepts `1`/`true`/`yes`/`on` and their negatives — anything else is refused by name at startup rather than guessed at. Set it, restart, sign in, change the password, then **remove the variable**: removing it is what re-arms recovery for next time. |
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

### The operator password

`HELPARR_INITIAL_PASSWORD` gets you in the first time. It is not where the
password lives: helparr hashes it on first boot and stores the hash, and from
then on the variable is inert. Change the password under **Settings → Operator
password** — the form asks for the current one, and changing it signs out every
other device while keeping you signed in on the one you used.

Until you do, a banner says so on every screen. That is deliberate: a password
sitting in a compose file is readable by anything that can read the file.

**If you forget it**, recovery runs through the environment, because helparr has
no email to send you and the database is encrypted, so there is nothing to edit
by hand:

```bash
# 1. set both, in the .env file beside your compose file
HELPARR_INITIAL_PASSWORD=a-temporary-password
HELPARR_PASSWORD_RESET=1

# 2. restart. The log says it reset, and every existing session is dead.
docker compose up -d

# 3. sign in, change the password under Settings, then REMOVE
#    HELPARR_PASSWORD_RESET and restart again.
```

Step 3 is the part that matters. The reset fires **once per time you ask for
it**, so a flag left behind will not quietly undo your next password change on
some later restart — but it also will not work a second time until you remove
it and set it again. helparr logs a warning on every start while the flag is
still there, naming the time it was already applied.

This cedes no security you had: anyone who can set environment variables on the
container can already read the database key.

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
your first instance under **Settings**. helparr will keep a banner up until you
replace that setup password under **Settings → Operator password** — it is
sitting in a file in plaintext, and anyone who can read the file is you.

`.env.local` is gitignored. Keep it that way.

---

## Deploy

Container is the short path — the image is published, for `linux/amd64` and
`linux/arm64` under one tag, so there is nothing to compile. Bare metal builds
from source. Both targets come from the same `output: 'standalone'` build,
though: there is no separate server bundle to maintain.

If you are building rather than pulling, one command produces both artifacts:

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

The image is published to the GitHub Container Registry as
`ghcr.io/feliperuzg/helparr`, built for `linux/amd64` and `linux/arm64` and
served from one tag — the same line works on an Intel NAS and on Apple silicon,
and you never pick an architecture.

**The package is private during internal testing, so the pull is
authenticated.** Take a GitHub personal access token (classic) with the
`read:packages` scope, and log in once:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
```

Without that, `docker pull` fails with `denied` — which reads like the tag does
not exist rather than like you are not logged in.

```bash
docker run -d --name helparr \
  -p 3000:3000 \
  -v helparr-data:/data \
  -e HELPARR_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  -e HELPARR_INITIAL_PASSWORD='replace-me' \
  ghcr.io/feliperuzg/helparr:latest
```

Which tag:

| Tag | What it is |
|---|---|
| `<version>`, `<major>.<minor>` | A release. `1.2` follows the newest `1.2.x`, so it picks up patches and never a breaking change. |
| `latest` | The newest release. Convenient, and the one to stop using the moment you care about reproducing a deployment. |
| `sha-<short>` | The exact commit a release was built from. Use it to pin, or to go back to a build that worked. |

A push to `main` publishes nothing. An image is only ever built from a `v*` git
tag, and only after the full test suite has passed on that tag — so every
digest in the registry corresponds to a release that was green. **Until the
first `v*` tag exists no image has been published at all**, and `:latest` fails
with `manifest unknown` rather than resolving to something unreleased.

If you would rather build it yourself, `npm run build:image` still produces
`helparr:local` and every command below works the same with that tag
substituted.

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
docker run -d --name helparr -p 3000:3000 -v /srv/helparr:/data … ghcr.io/feliperuzg/helparr:latest
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
npm run verify:image                                       # helparr:local

IMAGE=ghcr.io/feliperuzg/helparr:latest npm run verify:image  # a published release
```

It builds nothing and touches nothing of yours — a throwaway container and
volume, removed on exit.

**One thing the published image cannot do for you: a sub-path.**
`HELPARR_BASE_PATH` is a build input, not a runtime setting — it is compiled
into the server, the client bundles and every asset URL. The published image is
the empty-base-path build, which serves helparr at the root of whatever
hostname or port it is reached on. Serving it under `/helparr` means building
your own image; see [Behind a reverse proxy](#behind-a-reverse-proxy) below.
Starting the published image with `HELPARR_BASE_PATH` set to something else
does not half-work — startup refuses the mismatch and says so.

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
  in [`src/app/globals.css`](src/app/globals.css); no hardcoded colors or font
  sizes in components.

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

That first lane is 20 files and 208 tests, and it is the fast one. Three
heavier lanes are gated behind env vars so a forgotten build fails loudly rather
than silently skipping:

```bash
npm run test:bundle   # asserts no API keys / native modules leak into .next/static
npm run test:e2e      # 14 files driving the real standalone build in Chromium
npm run test:a11y     # the same build, axe WCAG 2.1 AA, zero violations
```

All three build first, so they take minutes rather than seconds — which is why
they are not in `npm test`. The last two need a Chromium download once:

```bash
npx playwright install chromium
```

### How work is organized

Development here is requirements-first. Before a feature is written it has
acceptance criteria in SHALL/MUST language, and those criteria become tests
before they become code — which is why the suites read like a specification
and why a change that can't be stated as a testable claim doesn't get built.

That paper trail is kept in a private workspace, so the *why* behind a decision
usually isn't in this repo. Two things make up for it: commit messages are
written to carry the reasoning, and load-bearing decisions are documented in a
comment at the place they constrain. If something looks arbitrary, check the
comment above it before assuming it is — and if it really is undocumented,
that's a bug worth filing.

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
- **The icons are generated, never hand-edited.** `public/logo.svg` is the only
  source; `npm run build:icons` renders the five committed binaries from it.
  Editing a PNG directly makes the set drift apart silently.

### Submitting

Branch from `main`, keep the commit history readable, and make sure
`npm test`, `npm run typecheck`, and `npm run lint` are all green. If the change
touches UI, run `npm run test:e2e` and `npm run test:a11y` too. Describe *what
problem it solves* in the PR — link the relevant proposal if there is one.

While helparr is in internal testing, a bug report is worth more than a patch.
The useful ones say which *arr versions you are on, what the screen showed, and
what the instance's own log said — helparr is a client, and half of what looks
like a helparr bug is an *arr answering something nobody expected.

---

## License

[MIT](LICENSE) © 2026 Felipe Ruz.

## Legal & scope

helparr orchestrates indexers and a download client that **you** have already
configured. It ships no indexers, no trackers, no content, and no bundled
sources, and it provides no means of discovering any. What you point it at, and
whether that's lawful where you live, is entirely your responsibility.

# syntax=docker/dockerfile:1

# helparr container image (FR2–FR5, FR8; REQ-DEPLOY-001..005, ADR-5).
#
# Two stages, not three. The design sketched a separate `deps` stage for
# build-cache shape and noted that going builder → runner is equally valid; it
# is, and the third stage would cost every build a second native compile of
# better-sqlite3-multiple-ciphers whose output is then thrown away, because
# `next build`'s own trace into .next/standalone already IS the minimal
# node_modules the runner ships (REQ-DEPLOY-003).
#
# The one thing that is NOT negotiable is that `npm ci` and `next build` run
# inside this Linux builder, never on a developer's machine with the result
# copied in: argon2 resolves to a glibc prebuild and
# better-sqlite3-multiple-ciphers compiles native, and both are correct only
# for the glibc and architecture that produced them (OQ-2, closed by OQ-5).

ARG NODE_IMAGE=node:22-slim

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS builder

WORKDIR /app

# better-sqlite3-multiple-ciphers has no prebuild for every platform and falls
# back to compiling. These are build-stage only — the runner never sees them.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Dependencies before source, so editing a component does not re-resolve the
# tree. `npm ci` (not `--omit=dev`): next, typescript and the compiler are
# devDependencies and the build needs them.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# basePath is compiled into the server, the client bundles and every asset URL.
# It is a build input, and next.config.mjs freezes it into
# HELPARR_COMPILED_BASE_PATH so a running container can refuse a mismatch
# rather than serve an app whose every stylesheet 404s (ADR-1 / T4).
ARG HELPARR_BASE_PATH=""
ENV HELPARR_BASE_PATH=${HELPARR_BASE_PATH}
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# Assembles .next/standalone with .next/static and public/ merged in — the same
# artifact the a11y and e2e lanes boot, so what CI tests is what ships.
RUN npm run build:standalone

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runner

WORKDIR /app

# `source` is the load-bearing one: GHCR links a package to a repository
# automatically only when the push comes from that repository's workflow, and
# this label is the other way it can be established. Baking it in means the
# linkage is a property of the image rather than of the push path, so an image
# built by hand does not silently become an orphan package that the workflow
# token can never write to afterwards (T1 / REQ-DEPLOY-019).
#
# The publish workflow also passes labels from docker/metadata-action, which
# adds the revision and created timestamps that only CI knows. Those override
# these on a pushed image; these are what a locally-built image carries.
LABEL org.opencontainers.image.source="https://github.com/feliperuzg/helparr" \
      org.opencontainers.image.url="https://github.com/feliperuzg/helparr" \
      org.opencontainers.image.title="helparr" \
      org.opencontainers.image.description="A self-hosted control surface for the operations your *arr stack makes slow — or impossible — from its own UIs." \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# The container binds every interface: it is reached through the published port
# or by compose DNS, and there is no reverse proxy inside the container to bind
# loopback for. Stated here rather than left to the launcher's default, which is
# loopback — that is the one this image has to override (FR6 / REQ-DEPLOY-006).
#
# It also has to be stated because Docker sets HOSTNAME to the container id
# otherwise, and Next would try to bind *that*.
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
# Under the declared volume, so the database and its -wal/-shm sidecars share
# one mount. Splitting them across a mount boundary corrupts WAL (FR5).
ENV HELPARR_DB_PATH=/data/helparr.db

ARG HELPARR_BASE_PATH=""
ENV HELPARR_BASE_PATH=${HELPARR_BASE_PATH}

# Created and owned before privileges drop, because a container that first
# touches /data as an unprivileged user on a fresh named volume finds it owned
# by root and fails to write (FR4/FR5, REQ-DEPLOY-004/005).
RUN groupadd --system --gid 1001 helparr \
 && useradd --system --uid 1001 --gid helparr --no-create-home --shell /usr/sbin/nologin helparr \
 && mkdir -p /data \
 && chown helparr:helparr /data

# One COPY: build:standalone already merged .next/static and public/ into the
# traced output. No application source, no devDependencies, no second
# node_modules tree (REQ-DEPLOY-003).
COPY --from=builder --chown=helparr:helparr /app/.next/standalone ./
COPY --from=builder --chown=helparr:helparr /app/docker/healthcheck.mjs ./healthcheck.mjs

# Declared, never populated at build time. An image that ships a database is an
# image that ships someone's credentials.
VOLUME /data

USER helparr
EXPOSE 3000

# Targets the unauthenticated liveness route: compose and orchestrator tooling
# have no session cookie, and a down *arr instance must not restart helparr.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "healthcheck.mjs"]

# The same launcher bare metal runs, not `server.js` directly. Its only job is
# the listen-address default, which `ENV HOSTNAME` above has already answered —
# so this is a no-op here, and that is the point: which file you run is not part
# of the deployment contract, and the two targets cannot drift apart on it.
ENTRYPOINT ["node", "start.mjs"]

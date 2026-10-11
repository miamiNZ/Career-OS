# Career OS — local-first NZ job-hunting dashboard.
#
# Runs the TypeScript app directly with tsx (no compile step): the dashboard
# resolves its static web/ assets relative to the source file, so we ship src/
# as-is rather than a tsc build that would drop the non-TS assets.
#
# The Obsidian vault is NOT baked into the image — it is bind-mounted at runtime
# to /vault (see the Makefile docker-* targets). Scoring/tailoring talk to Ollama
# on the host via host.docker.internal.
FROM node:22-alpine

# tzdata lets the daily scheduler honour a named TZ (e.g. Pacific/Auckland) on hosts
# like Unraid that pass one in; without it alpine stays on UTC.
RUN apk add --no-cache tzdata

WORKDIR /app

# Install dependencies first for layer caching. tsx is a devDependency and is the
# runtime here, so install everything (no --omit=dev).
COPY package.json package-lock.json ./
RUN npm ci

# App sources. tsconfig is included so tsx honours the project's compiler options.
COPY tsconfig.json ./
COPY src ./src

# Default app config folder (ships the Career OS logo at /app/config/logo.png).
# Bind-mount /app/config to a host path to persist/override it (see the Unraid template).
COPY config ./config

# Loopback-only is unsafe inside a container (nothing could reach it), so bind all
# interfaces here and rely on the host publishing the port to 127.0.0.1 only.
# UV_THREADPOOL_SIZE: the vault is a network mount, so reading its ~560 notes is
# latency-bound — widen libuv's fs threadpool so those reads actually run in parallel
# (4 is node's default and makes a full vault scan ~13x slower). It has to be in the
# environment before node starts; the npm scripts use cross-env to do the same locally.
ENV NODE_ENV=production \
    DASHBOARD_HOST=0.0.0.0 \
    DASHBOARD_PORT=8787 \
    VAULT_PATH=/vault \
    LOG_DIR=/logs \
    UV_THREADPOOL_SIZE=64

# Rotating app log lives here (career-os.log + archives). Declared a volume so it can
# be bind-mounted on the host (e.g. Unraid /mnt/user/appdata/career-os/logs) to persist
# across container recreation; otherwise it is an anonymous volume.
VOLUME /logs

EXPOSE 8787

# umask 000 so vault notes are created group/other-writable (666, not the default 644).
# The vault is normally a bind-mounted share that is ALSO written by a desktop client —
# Obsidian, or Career-OS running natively against the same SMB path. A note this container
# creates at 644 is owned by the container's uid and read-only to every other writer, so
# the desktop side can never update its status or score again: dropping it or marking it
# Interested fails with EPERM, permanently. Shared-vault writes have to be group-writable.
CMD ["sh", "-c", "umask 000 && npm run dashboard"]

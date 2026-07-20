# Fly.io chat worker image.
#
# Builds the long-lived Node process that consumes the chat job queue.
# The whole project is copied in (the worker imports many in-repo modules
# via the tsconfig "@/*" path alias), and tsx runs the entrypoint
# directly so we don't need a separate compile step. If cold-start time
# becomes a problem, switch to an esbuild bundle and run plain node.

FROM node:20-alpine AS deps
WORKDIR /app

# Alpine lacks the build deps some optional native modules want; keep
# the install lean and rely on prebuilt binaries where available. If a
# transitive dep fails to install, install python3/make/g++ here.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Disable handoff to /api/chat/continue — the worker has no per-request
# wall clock so the chain wall is unnecessary. Effectively infinity.
ENV CHAT_HANDOFF_THRESHOLD_MS=9999999999

# Headless Chromium for server-side artifact image rendering (puppeteer-core
# drives this binary — see app/lib/artifact/render-image.ts). We install the
# distro Chromium rather than letting puppeteer download one, so the binary
# matches the Alpine runtime. The font packages keep rendered text from falling
# back to tofu boxes.
RUN apk add --no-cache \
      chromium \
      nss \
      freetype \
      harfbuzz \
      ca-certificates \
      ttf-freefont \
      font-noto \
      font-noto-emoji \
      curl \
      jq \
      python3 \
      py3-pip \
      ffmpeg
ENV CHROMIUM_PATH=/usr/bin/chromium-browser
ENV PYTHON_BIN=/usr/bin/python3

# Allow-listed binaries for the Advanced Web `run_command` tool. curl + jq are
# installed above; the rest (wget, head, tail, wc, sort, uniq, cut, grep, sed,
# awk, tr, nl, rev, base64, cat, echo, date) are provided by BusyBox in the
# base node:20-alpine image. The tool exec's these with argv arrays (no shell),
# under a scrubbed environment — see app/lib/web/agentic.ts.

# Code Execution Sandbox (`run_code` tool — see app/lib/exec/sandbox.ts). The
# interpreters above (python3, node from the base image) plus ffmpeg cover the
# common tasks: media conversion, data crunching, image work, scraping. We
# pre-bake a tight set of python libs so the model has batteries without being
# able to `pip install` at runtime (network installs are intentionally not
# exposed). --break-system-packages is required on Alpine's externally-managed
# python; this image is single-purpose so polluting the system site-packages is
# fine. Keep this list small — every lib is image weight on every cold start.
RUN pip3 install --no-cache-dir --break-system-packages \
      numpy \
      pillow \
      requests

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY app ./app
COPY worker ./worker

# tsx reads tsconfig.json so the "@/*" path alias resolves the same way
# it does under `next dev`.
CMD ["node", "--enable-source-maps", "node_modules/.bin/tsx", "worker/index.ts"]

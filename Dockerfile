# syntax=docker/dockerfile:1.7

# Keep in step with .nvmrc
ARG NODE_VERSION=24

# ---------------------------------------------------------------------------
# Build: the same `pnpm build` CI runs before deploying to Cloudflare
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm AS build
WORKDIR /app

ENV CI=true \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# The production build prerenders every route in headless Chromium. Set PRERENDER=false to skip it
# (faster build, no Chromium download); the app works the same, only the initial HTML is emptier.
ARG PRERENDER=true
RUN if [ "$PRERENDER" = "true" ]; then pnpm exec playwright install --with-deps chromium; fi

COPY . .
RUN if [ "$PRERENDER" = "true" ]; then pnpm build; else pnpm exec vite build; fi

# ---------------------------------------------------------------------------
# Runtime: serves the built Worker + static assets with workerd (via `wrangler dev`), so the
# leaderboard, shared songs, online mode and remote mics all work without a Cloudflare account
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

# Only what is needed at runtime: wrangler (bundles workerd) and werift for the stand-in SFU.
# Versions match pnpm-lock.yaml.
WORKDIR /opt/runtime
RUN npm install --no-audit --no-fund --omit=dev wrangler@4.134.0 werift@0.24.4 \
    && npm cache clean --force
COPY --chown=node:node tests/fake-sfu/server.mts ./fake-sfu/server.mts

WORKDIR /app
COPY --from=build --chown=node:node /app/build ./build
COPY --chown=node:node docker/entrypoint.mjs ./entrypoint.mjs

RUN mkdir -p /data && chown node:node /data /app
USER node

ENV NODE_ENV=production \
    PORT=3010 \
    FAKE_SFU_PORT=3480 \
    DATA_DIR=/data \
    WRANGLER_SEND_METRICS=false \
    PATH=/opt/runtime/node_modules/.bin:$PATH

VOLUME ["/data"]
EXPOSE 3010

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

ENTRYPOINT ["tini", "--"]
CMD ["node", "/app/entrypoint.mjs"]

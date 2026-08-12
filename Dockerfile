# Homelander headless scanner (Kaufradar) — analysis-only deployment.
#
# Runs engine/headless.js: polls scan-mode searches (IS24 buy, Kleinanzeigen,
# Neubaukompass), enriches + geocodes listings, writes scan-listings.json,
# serves the Kaufradar browse site, and sends the weekly e-mail report.
# No Electron, no Chromium, no auto-applying.
#
#   docker compose up -d          # see docker-compose.yml
#   docker build -t homelander-scanner .

FROM node:22-bookworm-slim AS deps
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json package-lock.json ./
# better-sqlite3 is the only native module the scanner needs — build it for
# this platform; every install/postinstall script is skipped (they target
# Electron and would try to download Chromium).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && npm ci --omit=dev --ignore-scripts \
 && npm rebuild better-sqlite3 \
 && rm -rf /var/lib/apt/lists/*

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    HOMELANDER_DATA_DIR=/data \
    HOMELANDER_SCAN_HOST=0.0.0.0 \
    HOMELANDER_SCAN_PORT=8477
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY engine ./engine
# The runtime never invokes npm (CMD is plain node) — drop npm and its
# vendored deps from the image; they only feed the weekly CVE scan noise.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
 && mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8477
HEALTHCHECK --interval=60s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HOMELANDER_SCAN_PORT||8477)+'/api/scan/filters').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "engine/headless.js"]

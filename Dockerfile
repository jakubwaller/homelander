# Homelander Kaufradar — the whole app.
#
# Runs engine/headless.js: polls scan searches (IS24 buy, Kleinanzeigen,
# Neubaukompass), enriches + geocodes listings, writes scan-listings.json,
# serves the Kaufradar browse site, and sends the weekly e-mail report.
# There is no apply path in this repo at all.
#
#   docker compose up -d          # see docker-compose.yml
#   docker build -t homelander-scanner .

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 is the only runtime dependency, and the only native module —
# it uses a prebuilt binary where one exists and compiles here otherwise.
# Install scripts stay off and the rebuild is explicit: newer npm gates install
# scripts behind an approval prompt, and `npm rebuild` is the way past it that
# does not depend on which npm the base image happens to ship.
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
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8477
HEALTHCHECK --interval=60s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HOMELANDER_SCAN_PORT||8477)+'/api/scan/filters').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "engine/headless.js"]

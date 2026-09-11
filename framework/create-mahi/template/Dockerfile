# Two-stage build: compile with the full toolchain, ship a lean runtime.
# See docs/deployment for the compose file, worker/scheduler services, and
# the console entry (`node dist/bin/console.js migrate`).

# ---- build ----
FROM node:22-slim AS build
WORKDIR /app

# Native deps for better-sqlite3 and argon2.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Drop dev dependencies from the tree we copy forward.
RUN npm prune --omit=dev

# ---- runtime ----
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./

# storage/ is gitignored, so it must be created — and owned by the app user,
# or the first log write fails under `USER node`.
RUN mkdir -p storage/app/private storage/app/public storage/logs storage/cache storage/schedule-locks \
    && chown -R node:node /app/storage

USER node
EXPOSE 8000

# One process. Run migrations and the queue/scheduler as separate
# services (see docs/deployment); this image is the web server.
CMD ["node", "dist/bin/server.js"]

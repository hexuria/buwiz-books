# ── Stage 1: Install ALL deps (needed to build) ──────────────────
FROM oven/bun:1 AS deps

WORKDIR /app
COPY package.json bun.lock ./
COPY patches ./patches
RUN bun install --frozen-lockfile

# ── Stage 2: Install PRODUCTION-ONLY deps ─────────────────────────
FROM oven/bun:1 AS prod-deps

WORKDIR /app
COPY package.json bun.lock ./
COPY patches ./patches
RUN bun install --frozen-lockfile --production --ignore-scripts

# ── Stage 3: Build ────────────────────────────────────────────────
FROM oven/bun:1 AS build

WORKDIR /app

# Copy full deps (dev + prod) for the build step
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# White-label branding. Vite inlines VITE_* at BUILD time, so these must arrive
# as build args — setting them on the Cloud Run service does nothing for the
# client bundle. Unset args fall through to the defaults in src/config/brand.ts.
# The server-side equivalents (APP_NAME, SUPPORT_EMAIL, MAIL_FROM) are runtime
# env vars on the service instead, because VITE_* is stripped from that bundle.
ARG VITE_APP_NAME
ARG VITE_APP_URL
ARG VITE_BRAND_PRIMARY
ARG VITE_BRAND_ACCENT
ARG VITE_BRAND_LOGO_URL
ARG VITE_BRAND_FAVICON_URL
ARG VITE_SUPPORT_EMAIL
ENV VITE_APP_NAME=$VITE_APP_NAME \
    VITE_APP_URL=$VITE_APP_URL \
    VITE_BRAND_PRIMARY=$VITE_BRAND_PRIMARY \
    VITE_BRAND_ACCENT=$VITE_BRAND_ACCENT \
    VITE_BRAND_LOGO_URL=$VITE_BRAND_LOGO_URL \
    VITE_BRAND_FAVICON_URL=$VITE_BRAND_FAVICON_URL \
    VITE_SUPPORT_EMAIL=$VITE_SUPPORT_EMAIL

# Build the Nitro/TanStack Start app → .output/
RUN bun run build

# ── Stage 4: Production runtime ──────────────────────────────────
FROM oven/bun:1-slim AS runtime

WORKDIR /app

# sharp needs libvips at runtime — use the runtime lib, NOT -dev
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       libvips42 \
       ca-certificates \
       curl \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd --gid 1001 buwiz \
    && useradd --uid 1001 --gid buwiz --shell /bin/false --create-home buwiz

# Copy ONLY production node_modules (no devDeps)
COPY --from=prod-deps --chown=buwiz:buwiz /app/node_modules ./node_modules

# Copy built output
COPY --from=build --chown=buwiz:buwiz /app/.output ./.output
COPY --from=build --chown=buwiz:buwiz /app/package.json ./package.json

# Drizzle schema + config for the managed migration lifecycle
COPY --from=build --chown=buwiz:buwiz /app/drizzle ./drizzle
COPY --from=build --chown=buwiz:buwiz /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=build --chown=buwiz:buwiz /app/src/db ./src/db
# The migration entrypoint and its exact dependency closure. scripts/apply-*.ts are thin
# delegates over scripts/migrate.ts, so shipping them without this closure would fail at
# import time. loader.ts resolves migrations as ../../../drizzle/ relative to itself, which
# is /app/drizzle above, and the @/ alias resolves through the tsconfig.json copied below.
COPY --from=build --chown=buwiz:buwiz /app/scripts/migrate.ts ./scripts/migrate.ts
COPY --from=build --chown=buwiz:buwiz /app/src/lib/migrations ./src/lib/migrations
COPY --from=build --chown=buwiz:buwiz /app/src/lib/database-target.ts ./src/lib/database-target.ts
COPY --from=build --chown=buwiz:buwiz /app/src/lib/database-target-internal.ts ./src/lib/database-target-internal.ts
COPY --from=build --chown=buwiz:buwiz /app/scripts/apply-integrity-migration.ts ./scripts/apply-integrity-migration.ts
COPY --from=build --chown=buwiz:buwiz /app/scripts/apply-ai-foundation.ts ./scripts/apply-ai-foundation.ts
COPY --from=build --chown=buwiz:buwiz /app/scripts/apply-enterprise-migrations.ts ./scripts/apply-enterprise-migrations.ts
# The review-rule catalog seeder and the module it reads. Both are required: the seeder is a
# no-op in production if either is missing from the image.
COPY --from=build --chown=buwiz:buwiz /app/scripts/seed-review-rules.ts ./scripts/seed-review-rules.ts
COPY --from=build --chown=buwiz:buwiz /app/src/lib/inbox/review-rule-catalog.ts ./src/lib/inbox/review-rule-catalog.ts
COPY --from=build --chown=buwiz:buwiz /app/tsconfig.json ./tsconfig.json

# Drop privileges
USER buwiz

# Cloud Run injects PORT (default 8080)
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
EXPOSE 8080

# Health check for orchestrators
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:8080/ || exit 1

CMD ["bun", "run", ".output/server/index.mjs"]

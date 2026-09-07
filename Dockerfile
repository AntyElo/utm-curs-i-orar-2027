# syntax=docker/dockerfile:1.6
# ---- Stage 1: install dependencies & build the Next.js app (frontend + API) ----
FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Keep the runtime COPY valid even when the app has no static public assets.
# The build does not need a database; the scheduler is started at runtime only.
RUN mkdir -p public && SCHEDULE_DISABLE_SCHEDULER=1 npm run build

# ---- Stage 2: minimal production runtime ----
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8000 \
    HOSTNAME=0.0.0.0 \
    SCHEDULE_DATA_DIR=/app/data \
    SCHEDULE_SEED_PDF=/app/seed/anul_i_semestrul_i-18.pdf \
    SCHEDULE_SEED_PDF_2=/app/seed/anul_ii_semestrul_iii-11.pdf
RUN groupadd --system app && useradd --system --gid app --home /app app
COPY --from=builder --chown=app:app /app/.next/standalone ./
# Next's file tracer omits PDF.js' dynamically imported worker and optional
# Node canvas bindings. Copy both packages so runtime PDF parsing is complete.
COPY --from=builder --chown=app:app /app/node_modules/pdfjs-dist ./node_modules/pdfjs-dist
COPY --from=builder --chown=app:app /app/node_modules/@napi-rs ./node_modules/@napi-rs
COPY --from=builder --chown=app:app /app/.next/static ./.next/static
COPY --from=builder --chown=app:app /app/public ./public
# Keep the bundled fallbacks outside the writable cache mount: deployment platforms
# may replace /app/data with an initially empty volume. Both courses' seeds live here,
# and each course's SCHEDULE_SEED_PDF[_<year>] above points at its own file.
COPY --from=builder --chown=app:app /app/data/seed ./seed
RUN mkdir -p /app/data && chown -R app:app /app/data /app/seed
USER app
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]

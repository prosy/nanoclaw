# Multi-stage Dockerfile for NanoClaw (M2-P3 T4.1, REQ-11.1)
# Final image contains only compiled JS -- no .ts source files.

# ---------------------------------------------------------------------------
# Stage 1: Build
# ---------------------------------------------------------------------------
FROM node:20-alpine AS build

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Copy source and compile
COPY tsconfig.json ./
COPY src/ src/

RUN npx tsc

# Prune dev dependencies for production
RUN npm prune --production

# ---------------------------------------------------------------------------
# Stage 2: Runtime
# ---------------------------------------------------------------------------
FROM node:20-alpine AS runtime

# Security: run as non-root
RUN addgroup -S nanoclaw && adduser -S nanoclaw -G nanoclaw

WORKDIR /app

# Copy only compiled output + production dependencies
COPY --from=build /app/dist/ dist/
COPY --from=build /app/node_modules/ node_modules/
COPY --from=build /app/package.json package.json

# Create data directories
RUN mkdir -p /app/data/ipc /app/store /app/groups && \
    chown -R nanoclaw:nanoclaw /app

ENV NODE_ENV=production
ENV WS_PORT=9347
ENV WS_BIND=127.0.0.1

EXPOSE 9347

USER nanoclaw

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:9347').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]

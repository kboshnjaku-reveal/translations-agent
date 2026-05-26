# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── Runner stage ──────────────────────────────────────────────────────────────
FROM node:20-slim AS runner

ARG VERSION=dev
LABEL org.opencontainers.image.title="translations-agent" \
      org.opencontainers.image.description="AI-driven CLI tool for automating localization updates" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.source="https://github.com/krist/translations-agent"

# git is required by simple-git for diff/status operations
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# The target repo is mounted here at runtime
WORKDIR /repo

ENTRYPOINT ["node", "/app/dist/agent/index.js"]

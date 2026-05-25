# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── Runner stage ──────────────────────────────────────────────────────────────
FROM node:20-slim AS runner

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

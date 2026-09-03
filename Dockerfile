FROM node:22-slim AS base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ git \
    && rm -rf /var/lib/apt/lists/*

FROM base AS deps
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts && \
    npm rebuild better-sqlite3 && \
    (npm rebuild onnxruntime-node || true) && \
    (npm rebuild node-pty || true)
COPY scripts/ ./scripts/
RUN node scripts/patch-fsbrowse.js && node scripts/copy-vendor.js
RUN find node_modules -type f \( \
      -name "*.md" -o -name "*.markdown" -o \
      -name "CHANGELOG*" -o -name "HISTORY*" -o \
      -name ".travis.yml" -o -name "*.map" \
    \) -delete 2>/dev/null; \
    find node_modules -type d \( \
      -name "__tests__" -o -name "test" -o \
      -name "tests" -o -name "docs" -o \
      -name "example" -o -name "examples" \
    \) -exec rm -rf {} + 2>/dev/null; true

FROM node:22-slim
ARG VERSION=0.0.0
LABEL org.opencontainers.image.title="AgentGUI" \
      org.opencontainers.image.description="Multi-agent GUI client for AI coding agents" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.source="https://github.com/AnEntrypoint/agentgui"
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/static/lib ./static/lib
COPY . .
RUN rm -rf .github .git scripts/patch-fsbrowse.js test/ __tests__/ tmp/ .env* .prd .pma
ENV PORT=3000 BASE_URL=/gm NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]

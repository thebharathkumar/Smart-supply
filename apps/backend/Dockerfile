# Multi-stage build for the Node backend.
# Builds inside the monorepo so workspace deps resolve correctly.
FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY apps/backend/package.json apps/backend/
COPY packages/db/package.json packages/db/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/proto/package.json packages/proto/
RUN pnpm install --frozen-lockfile=false

FROM base AS build
COPY --from=deps /repo /repo
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/backend apps/backend
RUN pnpm --filter @smart-supply/backend build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache wget
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY --from=build /repo /repo
WORKDIR /repo/apps/backend
RUN pnpm prune --prod
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:4000/health || exit 1
CMD ["node", "dist/server.js"]

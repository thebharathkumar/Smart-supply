FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY apps/simulator/package.json apps/simulator/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/proto/package.json packages/proto/
RUN pnpm install --frozen-lockfile=false

FROM base AS build
COPY --from=deps /repo /repo
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/simulator apps/simulator
RUN pnpm --filter @smart-supply/simulator build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY --from=build /repo /repo
WORKDIR /repo/apps/simulator
RUN pnpm prune --prod
CMD ["node", "dist/index.js"]
